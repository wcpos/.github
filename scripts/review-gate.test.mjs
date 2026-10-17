import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { evaluate } from './review-gate.mjs';

const head = 'a'.repeat(40);
const pr = {
  state: 'OPEN', isDraft: false, headRefOid: head, headCommittedAt: '2026-10-17T10:00:00Z',
  author: { login: 'owner' }, reviews: [], comments: [], threads: [], timeline: [],
};
const request = author => ({ author, body: '@codex review', createdAt: '2026-10-17T11:00:00Z' });
const receipt = { author: { login: 'chatgpt-codex-connector', __typename: 'Bot' },
  body: 'codex-review-receipt', createdAt: '2026-10-17T12:00:00Z' };

for (const author of [{ login: 'github-actions[bot]' }, { login: 'some-app', __typename: 'Bot' }]) {
  test(`${author.login} request cannot suppress the member warning`, () => {
    const result = evaluate({ ...pr, comments: [request(author)] });
    assert.equal(result.needsCodex, true);
    assert.ok(result.warnings.some(w => /member must post/.test(w)));
  });
  test(`${author.login} request cannot authorize a receipt`, () => {
    const result = evaluate({ ...pr, comments: [request(author), receipt] });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.needsCodex, true);
  });
}
test('member request after head suppresses another request', () => {
  assert.equal(evaluate({ ...pr, comments: [request({ login: 'member', __typename: 'User' })] }).needsCodex, false);
});
for (const boundary of ['head', 'HeadRefForcePushedEvent', 'BaseRefChangedEvent']) {
  for (const [hour, verdict] of [['09', 'FAIL'], ['10', 'FAIL'], ['11', 'PASS']]) {
    test(`receipt requires request after ${boundary} boundary (request hour=${hour})`, () => {
      const changed = boundary === 'head' ? pr : { ...pr, headCommittedAt: '2026-10-17T08:00:00Z',
        timeline: [{ __typename: boundary, createdAt: pr.headCommittedAt }] };
      const result = evaluate({ ...changed, comments: [
        { ...request({ login: 'member' }), createdAt: `2026-10-17T${hour}:00:00Z` }, receipt,
      ] });
      assert.equal(result.verdict, verdict);
      assert.equal(result.needsCodex, verdict === 'FAIL');
      assert.equal(result.warnings.some(w => /receipt-based/.test(w)), verdict === 'PASS');
    });
  }
}
test('bot request after a valid member-request receipt does not invalidate it', () => {
  const comments = [request({ login: 'member', __typename: 'User' }), receipt,
    { ...request({ login: 'github-actions[bot]' }), createdAt: '2026-10-17T13:00:00Z' }];
  const result = evaluate({ ...pr, comments });
  assert.equal(result.verdict, 'PASS');
  assert.ok(result.warnings.some(w => /receipt-based/.test(w)));
});

// Exercise the CLI with only external GitHub I/O replaced and a real event file.
function workflow({ restHead, prInput = '', parents = [], shaInput = '', fork = false, eventName = 'pull_request', statusCode = 200, readError = false, merged = false, prs = { 7: pr }, associated = [], timelinePages = false } = {}) {
  const event = shaInput || eventName === 'workflow_run' ? {} : eventName === 'workflow_dispatch' ? { inputs: { pr: '7' } } : {
    pull_request: { number: 7, user: { login: fork ? 'contributor' : 'dependabot[bot]' }, head: { sha: head, repo: { full_name: fork ? 'outside/repo' : 'wcpos/repo' } },
      base: { repo: { full_name: 'wcpos/repo' } } },
  };
  const bootstrap = `
    const prs = ${JSON.stringify(prs)}, pr = prs[7];
    globalThis.fetch = async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      if (url.endsWith('/pulls/7')) return Response.json({ state: pr.state.toLowerCase(), head: { sha: ${JSON.stringify(restHead)} || pr.headRefOid }, merged: ${merged} });
      if (url.includes('/statuses/')) {
        console.log('STATUS ' + JSON.stringify({ url, ...body }));
        return Response.json({ message: 'status response' }, { status: ${statusCode} });
      }
      if (url.includes('/commits/') && !url.includes('/pulls?')) return Response.json({ parents: ${JSON.stringify(parents)} });
      if (url.includes('/commits/')) { console.log('ASSOCIATED'); return Response.json(url.includes('/commits/merge/') ? [] : ${JSON.stringify(associated)}); }
      if (url.endsWith('/graphql')) {
        console.log('GRAPHQL');
        if (${readError}) return Response.json({ message: 'read denied' }, { status: 403 });
        const n = body.query.match(/pullRequest\\(number:(\\d+)\\)/)?.[1];
        if (n) return Response.json({ data: { repository: { pullRequest: {
          ...prs[n], id: n, commits: { nodes: [{ commit: { committedDate: prs[n].headCommittedAt } }] }
        } } } });
        const row = prs[JSON.parse(body.query.match(/node\\(id:("[^"]+")/)[1])];
        const field = ['reviewThreads', 'reviews', 'comments', 'timelineItems'].find(f => body.query.includes(f + '('));
        const more = ${timelinePages} && field === 'timelineItems' && body.query.includes('after:null');
        if (field) return Response.json({ data: { node: { [field]: {
          nodes: more ? [] : row[field === 'timelineItems' ? 'timeline' : field] || [],
          pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null }
        } } } });
      }
      throw new Error('Unexpected request: ' + url);
    };
    process.argv = [process.execPath, ${JSON.stringify(new URL('./review-gate.mjs', import.meta.url).pathname)}, '--workflow'];
    await import('./review-gate.mjs');
  `;
  const dir = mkdtempSync(new URL('./.review-gate-test-', import.meta.url));
  const eventPath = `${dir}/event.json`;
  writeFileSync(eventPath, JSON.stringify(event));
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: new URL('.', import.meta.url), encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName,
        GITHUB_REPOSITORY: 'wcpos/repo', GITHUB_RUN_ID: '123', GITHUB_TOKEN: 'test-only',
        GITHUB_STEP_SUMMARY: '', INPUT_SHA: shaInput, INPUT_PR: prInput || (eventName === 'workflow_dispatch' ? '7' : eventName === 'workflow_run' ? '0' : '999') },
    });
  } finally { rmSync(dir, { recursive: true }); }
}
test('dispatch evaluates the requested PR and publishes on its head', () => {
  const result = workflow({ eventName: 'workflow_dispatch' });
  assert.equal(result.status, 1, result.stderr); // The unreviewed PR is blocked, not silently skipped.
  assert.match(result.stdout, /"pr": "wcpos\/repo#7"/);
  assert.match(result.stdout, new RegExp(`/statuses/${head}`));
});
test('event PR number takes precedence over dispatch input on PR events', () => {
  const result = workflow();
  assert.match(result.stdout, /"pr": "wcpos\/repo#7"/);
  assert.equal(result.status, 1);
});
for (const fork of [false, true]) for (const readError of [false, true]) {
  test(`restricted status 403 exits zero (${fork ? 'fork' : 'same-repo Dependabot'}, readError=${readError})`, () => {
    const result = workflow({ fork, statusCode: 403, readError });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /restricted token: status not published from this run; the publisher run publishes it/);
    assert.match(result.stdout, /"verdict": "FAIL"/);
  });
}
for (const options of [{ eventName: 'workflow_dispatch', statusCode: 403 }, { fork: true, statusCode: 500 }, { readError: true }]) {
  test(`other API failures remain loud: ${JSON.stringify(options)}`, () => {
    const result = workflow(options);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /restricted token: status not published/);
  });
}
test('merged verdict never publishes a status', () => {
  const result = workflow({ merged: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"verdict": "MERGED"/);
  assert.doesNotMatch(result.stdout, /STATUS /);
});

const pass = { author: { login: 'chatgpt-codex-connector' }, body: '', state: 'COMMENTED',
  submittedAt: '2026-10-17T12:00:00Z', commit: { oid: head } };
const ready = { ...pr, reviews: [pass] };
for (const eventName of ['pull_request', 'workflow_dispatch', 'workflow_run']) for (const secondary of [ready, pr, null]) {
  test(`${eventName}: primary moves after pending, secondary=${secondary ? secondary === ready ? 'passing' : 'blocked' : 'absent'}`, () => {
    const result = workflow({ eventName, restHead: head, shaInput: eventName === 'workflow_run' ? head : '',
      prs: { 7: { ...pr, headRefOid: 'moved' }, 8: secondary },
      associated: [7, ...(secondary ? [8] : [])].map(number => ({ number, state: 'open', head: { sha: head } })) });
    assert.equal(result.status, secondary === pr ? 1 : 0, result.stdout + result.stderr);
    const statuses = result.stdout.split('\n').filter(s => s.startsWith('STATUS ')).map(s => JSON.parse(s.slice(7)));
    assert.deepEqual(statuses.map(s => s.url.split('/').at(-1)), [head, head]);
    assert.deepEqual(statuses.map(s => s.state), ['pending', secondary ? secondary === ready ? 'success' : 'failure' : 'error']);
    if (!secondary) assert.equal(statuses[1].description, 'head moved; re-evaluated on the new head');
    assert.doesNotMatch(result.stdout, /#7:/);
  });
}
for (const eventName of ['pull_request', 'workflow_dispatch', 'workflow_run']) for (const secondary of [false, true]) {
  test(`${eventName}: closed primary ${secondary ? 'leaves passing secondary' : 'publishes nothing without open PRs'}`, () => {
    const result = workflow({ eventName, prInput: '7', prs: { 7: { ...pr, state: 'CLOSED' }, 8: ready },
      associated: secondary ? [{ number: 8, state: 'open', head: { sha: head } }] : [] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /"state":"failure"|#7:/);
    if (secondary) assert.match(result.stdout, /"state":"success"/);
    else {
      assert.doesNotMatch(result.stdout, /STATUS /);
      assert.match(result.stdout, /No open PRs/);
    }
  });
}
test('dismissed reviews neither pass nor demand replies', () => {
  assert.equal(evaluate({ ...pr, reviews: [{ ...pass, state: 'DISMISSED' }] }).verdict, 'FAIL');
  for (const login of ['reviewer', 'coderabbitai']) {
    const review = { ...pass, author: { login }, state: 'DISMISSED', body: 'P1 potential issue needs a reply', commit: { oid: 'old' } };
    assert.equal(evaluate({ ...ready, reviews: [pass, review] }).verdict, 'PASS');
  }
});
test('approvals do not demand replies but findings still do', () => {
  for (const login of ['reviewer', 'coderabbitai']) for (const state of ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']) {
    const review = { ...pass, author: { login }, state, body: 'P1 potential issue needs a reply' };
    assert.equal(evaluate({ ...ready, reviews: [pass, review] }).verdict, state === 'APPROVED' ? 'PASS' : 'FAIL');
  }
});
test('every reviewer thread needs another author; author threads and bot thanks are exempt', () => {
  const comment = (login, body = '') => ({ author: { login }, body, createdAt: pass.submittedAt });
  for (const [comments, verdict] of [
    [[comment('reviewer')], 'FAIL'], [[comment('reviewer'), comment('reviewer')], 'FAIL'],
    [[comment('reviewer'), comment('owner')], 'PASS'], [[comment('owner')], 'PASS'],
    [[comment('coderabbitai'), comment('owner'), comment('coderabbitai', 'Thanks')], 'PASS'],
    [[comment('coderabbitai'), comment('owner'), comment('coderabbitai', 'P1 new issue')], 'FAIL'],
  ]) assert.equal(evaluate({ ...ready, threads: [{ isResolved: true, comments }] }).verdict, verdict);
});
for (const __typename of ['HeadRefForcePushedEvent', 'BaseRefChangedEvent']) {
  test(`${__typename} invalidates earlier reviews, requests, receipts and completed/running states`, () => {
    const changed = { ...ready, timeline: [{ __typename, createdAt: '2026-10-17T13:00:00Z' }] };
    for (const comments of [[request({ login: 'member' }), receipt], ...['completed', 'running'].map(status => [{ ...receipt,
      body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}","status":"${status}"}} -->` }])]) {
      const result = evaluate({ ...changed, comments });
      assert.equal(result.verdict, 'FAIL');
      assert.equal(result.needsCodex, true);
    }
    const fresh = { ...pass, submittedAt: '2026-10-17T14:00:00Z' };
    assert.equal(evaluate({ ...changed, reviews: [fresh] }).verdict, 'PASS');
    assert.equal(evaluate({ ...changed, reviews: [fresh, { ...pass, author: { login: 'coderabbitai' } }] }).verdict, 'FAIL');
  });
}
test('pending precedes pagination even when evaluation subsequently fails', () => {
  for (const readError of [false, true]) {
    const result = workflow({ readError });
    const pending = result.stdout.indexOf('"state":"pending"');
    assert.ok(pending >= 0 && pending < result.stdout.indexOf('GRAPHQL'), result.stdout);
    assert.ok(!result.stdout.includes('ASSOCIATED') || pending < result.stdout.indexOf('ASSOCIATED'));
    assert.match(result.stdout, /"state":"failure"/);
  }
});
test('shared-head status aggregates all open PRs, including the triggering PR', () => {
  for (const blocked of [7, 8, null]) {
    const prs = { 7: ready, 8: ready, ...(blocked && { [blocked]: pr }) };
    const result = workflow({ prs, associated: [{ number: 8, state: 'open', head: { sha: head } }] });
    assert.equal(result.status, blocked ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, blocked ? new RegExp(`"description":"[^"\n]*#${blocked}`) : /"state":"success"/);
  }
});
test('timeline pagination includes a later base change when loading a PR', () => {
  const result = workflow({ prs: { 7: { ...ready, timeline: [{ createdAt: '2026-10-17T13:00:00Z' }] } }, timelinePages: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /waiting for Codex/);
});

for (const blocked of [7, 8, null]) {
  test(`publisher resolves SHA and aggregates open PRs (blocked=${blocked})`, () => {
    const result = workflow({ eventName: 'workflow_run', shaInput: head,
      prs: { 7: ready, 8: ready, ...(blocked && { [blocked]: pr }) },
      associated: [7, 8].map(number => ({ number, state: 'open', head: { sha: head } })) });
    assert.equal(result.status, blocked ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`/statuses/${head}`));
    assert.match(result.stdout, /"state":"pending"/);
    assert.match(result.stdout, blocked ? new RegExp(`"description":"[^"\n]*#${blocked}`) : /"state":"success"/);
  });
}
test('publisher with no open PR for its SHA publishes nothing', () => {
  const result = workflow({ eventName: 'workflow_run', shaInput: head,
    associated: [{ number: 7, state: 'closed', head: { sha: head } },
      { number: 8, state: 'open', head: { sha: 'old' } }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No open PRs/);
  assert.doesNotMatch(result.stdout, /STATUS /);
});
test('publisher status 403 is a hard failure', () => {
  const result = workflow({ eventName: 'workflow_run', shaInput: head, statusCode: 403,
    associated: [{ number: 7, state: 'open', head: { sha: head } }] });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /GitHub 403/);
  assert.doesNotMatch(result.stdout + result.stderr, /restricted token:/);
});

for (const statusCode of [200, 403]) test(`publisher PR input uses current head (status=${statusCode})`, () => {
  const result = workflow({ eventName: 'workflow_run', prInput: '7', statusCode, prs: { 7: ready } });
  assert.equal(result.status, statusCode === 200 ? 0 : 1, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`/statuses/${head}`));
  assert.doesNotMatch(result.stdout + result.stderr, /restricted token:/);
});
test('publisher resolves a merge SHA through its second parent', () => {
  const result = workflow({ eventName: 'workflow_run', shaInput: 'merge', parents: [{ sha: 'base' }, { sha: head }],
    prs: { 7: ready }, associated: [{ number: 7, state: 'open', head: { sha: head } }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`/statuses/${head}`));
  assert.match(result.stdout, /second parent/);
  assert.doesNotMatch(result.stdout, /statuses\/merge/);
});
for (const eventName of ['pull_request', 'workflow_run']) for (const changed of [{ headRefOid: 'moved' }, { state: 'MERGED' }]) {
  test(`${eventName} ignores a secondary PR that moved or merged: ${JSON.stringify(changed)}`, () => {
    const result = workflow({ eventName, shaInput: eventName === 'workflow_run' ? head : '',
      prs: { 7: ready, 8: { ...pr, ...changed } },
      associated: [7, 8].map(number => ({ number, state: 'open', head: { sha: head } })) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /"state":"success"/);
    assert.doesNotMatch(result.stdout, /#8:/);
  });
}
