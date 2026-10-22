import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
  for (const hour of ['09', '10', '11']) {
    test(`receipt alone never passes at ${boundary} boundary (request hour=${hour})`, () => {
      const changed = boundary === 'head' ? pr : { ...pr, headCommittedAt: '2026-10-17T08:00:00Z',
        timeline: [{ __typename: boundary, createdAt: pr.headCommittedAt }] };
      const result = evaluate({ ...changed, comments: [
        { ...request({ login: 'member' }), createdAt: `2026-10-17T${hour}:00:00Z` }, receipt,
      ] });
      assert.equal(result.verdict, 'FAIL');
      assert.equal(result.needsCodex, hour !== '11');
      assert.equal(result.warnings.some(w => /receipt-based/.test(w)), false);
    });
  }
}
test('receipt alone never passes even with member and bot requests', () => {
  const comments = [request({ login: 'member', __typename: 'User' }), receipt,
    { ...request({ login: 'github-actions[bot]' }), createdAt: '2026-10-17T13:00:00Z' }];
  const result = evaluate({ ...pr, comments });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.needsCodex, false);
  assert.equal(result.warnings.some(w => /receipt-based/.test(w)), false);
});

// Exercise the CLI with only external GitHub I/O replaced and a real event file.
function workflow({ resolveOnly = 'false', restError = false, publish = 'true', headOwner = '', headBranch = '', branchPRs = [], restHead, prInput = '', parents = [], shaInput = '', fork = false, eventName = 'pull_request', statusCode = 200, readError = false, merged = false, prs = { 7: pr }, associated = [], timelinePages = false, associated5xx = 0, associatedEmpty200 = false } = {}) {
  const event = shaInput || eventName === 'workflow_run' ? {} : eventName === 'issue_comment' ? { issue: { number: 7, pull_request: {} } } : eventName === 'workflow_dispatch' ? { inputs: { pr: '7' } } : {
    pull_request: { number: 7, user: { login: fork ? 'contributor' : 'dependabot[bot]' }, head: { sha: head, repo: { full_name: fork ? 'outside/repo' : 'wcpos/repo' } },
      base: { repo: { full_name: 'wcpos/repo' } } },
  };
  const bootstrap = `
    const prs = ${JSON.stringify(prs)}, pr = prs[7];
    globalThis.associated5xxLeft = ${associated5xx};
    globalThis.fetch = async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      if (url.endsWith('/pulls/7') && ${restError}) throw new Error('live PR fetch failed');
      if (url.endsWith('/pulls/7')) return Response.json({ state: pr.state.toLowerCase(), head: { sha: ${JSON.stringify(restHead)} || pr.headRefOid }, merged: ${merged} });
      if (url.includes('/statuses/')) {
        console.log('STATUS ' + JSON.stringify({ url, ...body }));
        return Response.json({ message: 'status response' }, { status: ${statusCode} });
      }
      if (url.includes('/commits/') && !url.includes('/pulls?')) return Response.json({ parents: ${JSON.stringify(parents)} });
      if (url.includes('/commits/')) {
        console.log('ASSOCIATED');
        // GitHub during an incident: 5xx with an empty body, for the first N calls.
        if (globalThis.associated5xxLeft > 0) { globalThis.associated5xxLeft--; return new Response('', { status: 502 }); }
        if (${associatedEmpty200}) return new Response('', { status: 200 });
        return Response.json(url.includes('/commits/merge/') ? [] : ${JSON.stringify(associated)});
      }
      if (url.includes('/pulls?')) {
        const query = new URL(url).searchParams;
        if (query.get('state') !== 'open' || (query.has('head') && query.get('head') !== 'contributor:feature/fix')) throw new Error('Wrong branch lookup');
        console.log('BRANCH LOOKUP'); return Response.json(${JSON.stringify(branchPRs)});
      }
      if (url.endsWith('/graphql')) {
        console.log('GRAPHQL');
        if (${readError}) return Response.json({ message: 'read denied' }, { status: 403 });
        const n = body.query.match(/pullRequest\\(number:(\\d+)\\)/)?.[1];
        if (n) return Response.json({ data: { repository: { pullRequest: {
          ...prs[n], id: n, commits: { nodes: [{ commit: { committedDate: prs[n].headCommittedAt } }] }
        } } } });
        const row = prs[JSON.parse(body.query.match(/node\\(id:("[^"]+")/)[1])];
        const field = ['reviewThreads', 'reviews', 'comments', 'timelineItems', 'files'].find(f => body.query.includes(f + '('));
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
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: new URL('.', import.meta.url), encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName,
        GITHUB_REPOSITORY: 'wcpos/repo', GITHUB_RUN_ID: '123', GITHUB_TOKEN: 'test-only',
        INPUT_RESOLVE_ONLY: resolveOnly, GITHUB_OUTPUT: `${dir}/output`, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: '', INPUT_PUBLISH: publish, INPUT_HEAD_OWNER: headOwner, INPUT_HEAD_BRANCH: headBranch, INPUT_SHA: shaInput, INPUT_PR: prInput || (eventName === 'workflow_dispatch' ? '7' : eventName === 'workflow_run' ? '0' : '999') },
    });
    result.output = existsSync(`${dir}/output`) ? readFileSync(`${dir}/output`, 'utf8') : '';
    result.target = existsSync(`${dir}/review-gate-target.json`) && JSON.parse(readFileSync(`${dir}/review-gate-target.json`, 'utf8'));
    return result;
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
// GitHub incident of 2026-10-22: commits/{sha}/pulls answered 500 with an empty body on one request in
// three, and the gate reported "Unexpected end of JSON input" on every re-run of an otherwise passing PR.
test('a GET that answers 5xx with an empty body is retried and the run evaluates', () => {
  const result = workflow({ eventName: 'workflow_dispatch', associated5xx: 2 });
  assert.equal(result.status, 1, result.stderr); // Unreviewed PR: blocked on its merits, not on the outage.
  assert.match(result.stdout, /"verdict": "FAIL"/);
  assert.doesNotMatch(result.stdout + result.stderr, /could not evaluate|Unexpected end of JSON input/);
  assert.equal((result.stdout.match(/ASSOCIATED/g) || []).length, 3);
});
test('a GET that keeps answering 5xx fails loud with the status, not a JSON parse error', () => {
  const result = workflow({ eventName: 'workflow_dispatch', associated5xx: 3 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not evaluate; retry/);
  assert.match(result.stdout, /GitHub 502: \\"empty body\\"/);
  assert.doesNotMatch(result.stdout + result.stderr, /Unexpected end of JSON input/);
  assert.equal((result.stdout.match(/ASSOCIATED/g) || []).length, 3); // Exhaustion takes every attempt, no more.
});
test('a 200 with an empty body fails with the status rather than a fake payload', () => {
  const result = workflow({ eventName: 'workflow_dispatch', associatedEmpty200: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not evaluate; retry/);
  assert.match(result.stdout, /GitHub 200: \\"empty body\\"/);
  assert.equal((result.stdout.match(/ASSOCIATED/g) || []).length, 1); // A 2xx is not retried.
});
test('read-only event lane still fails when it could not evaluate', () => {
  const result = workflow({ publish: 'false', restError: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /could not evaluate; retry/);
});
test('merged verdict never publishes a status', () => {
  const result = workflow({ merged: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"verdict": "MERGED"/);
  assert.doesNotMatch(result.stdout, /STATUS /);
});

const pass = { author: { login: 'chatgpt-codex-connector' }, body: '', state: 'COMMENTED',
  submittedAt: '2026-10-17T12:00:00Z', commit: { oid: head } };
const ready = { ...pr, reviews: [pass] };
test('stale CodeRabbit review passes only after its body and inline findings are answered', () => {
  const finding = { author: { login: 'coderabbitai' }, body: 'P1 potential issue', createdAt: pass.submittedAt };
  const reply = { author: { login: 'owner' }, body: '@coderabbitai fixed', createdAt: '2026-10-17T14:00:00Z' };
  for (const bodyAnswered of [false, true]) for (const threadAnswered of [false, true]) {
    const result = evaluate({ ...ready,
      reviews: [pass, { ...pass, ...finding, commit: { oid: 'old' }, submittedAt: '2026-10-17T09:00:00Z' }],
      comments: bodyAnswered ? [reply] : [],
      threads: [{ isResolved: true, comments: threadAnswered ? [finding, reply] : [finding] }],
    });
    assert.equal(result.verdict, bodyAnswered && threadAnswered ? 'PASS' : 'FAIL');
  }
});
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
test('review bodies require a later human reply referencing that review', () => {
  for (const login of ['reviewer', 'coderabbitai[bot]']) for (const state of ['COMMENTED', 'CHANGES_REQUESTED']) {
    const review = { ...pass, author: { login }, state, body: state === 'COMMENTED' ? 'P1 potential issue needs a reply' : '',
      url: 'https://github.com/wcpos/repo/pull/7#pullrequestreview-123', lastEditedAt: '2026-10-17T13:00:00Z' };
    for (const [body, author, createdAt, verdict] of [
      ['Unrelated update', 'owner', '14', 'FAIL'], ['@other fixed', 'owner', '14', 'FAIL'],
      [`@${login}-other fixed`, 'owner', '14', 'FAIL'], ['pullrequestreview-1234', 'owner', '14', 'FAIL'],
      [`@${login} fixed`, 'owner', '14', 'PASS'], [`@${login.toUpperCase()} fixed`, 'owner', '14', 'PASS'],
      [review.url, 'owner', '14', 'PASS'], [`@${login} fixed`, 'helper[bot]', '14', 'FAIL'],
      [`@${login} fixed`, 'owner', '13', 'FAIL'], [`@${login} fixed`, 'owner', '12', 'FAIL'],
    ]) assert.equal(evaluate({ ...ready, reviews: [pass, review], comments: [{ body, author: { login: author },
      createdAt: `2026-10-17T${createdAt}:00:00Z` }] }).verdict, verdict, `${login}/${state}: ${body}/${author}/${createdAt}`);
  }
});
test('only completed Codex state on the head passes without a review', () => {
  for (const commit_sha of [head, 'old']) for (const status of ['completed', 'running']) {
    const state = { ...receipt, body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha, status } })} -->` };
    assert.equal(evaluate({ ...pr, comments: [state] }).verdict, commit_sha === head && status === 'completed' ? 'PASS' : 'FAIL');
  }
});
test('a Codex state comment edited in place for the head passes; the same comment before its edit does not', () => {
  const stateFor = commit_sha => `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha, status: 'completed' } })} -->`;
  // Created for an earlier head at 09:00, before this head (10:00); Codex edited it for this head at 12:00.
  const edited = { ...receipt, body: stateFor(head), createdAt: '2026-10-17T09:00:00Z', lastEditedAt: '2026-10-17T12:00:00Z', editor: receipt.author };
  assert.equal(evaluate({ ...pr, comments: [edited] }).verdict, 'PASS');
  const unedited = { ...receipt, body: stateFor(head), createdAt: '2026-10-17T09:00:00Z' };
  assert.equal(evaluate({ ...pr, comments: [unedited] }).verdict, 'FAIL');
  // An edit that predates a later base change is still stale.
  const rebased = { ...pr, timeline: [{ __typename: 'BaseRefChangedEvent', createdAt: '2026-10-17T13:00:00Z' }] };
  assert.equal(evaluate({ ...rebased, comments: [edited] }).verdict, 'FAIL');
});
test('a Codex state comment edited by anyone but Codex is forged, whatever its body says', () => {
  const stateFor = commit_sha => `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha, status: 'completed' } })} -->`;
  const base = { ...receipt, body: stateFor(head), createdAt: '2026-10-17T09:00:00Z', lastEditedAt: '2026-10-17T12:00:00Z' };
  // GitHub lets anyone with write access edit a bot's comment; only the connector's own edits count.
  assert.equal(evaluate({ ...pr, comments: [{ ...base, editor: { login: 'chatgpt-codex-connector[bot]' } }] }).verdict, 'PASS');
  // Edited (lastEditedAt set) but the editor is unknown: not Codex's own edit either.
  for (const editor of [null, { login: 'owner' }, { login: 'member' }, { login: 'helper[bot]' }]) {
    const result = evaluate({ ...pr, comments: [{ ...base, editor }] });
    assert.equal(result.verdict, 'FAIL', JSON.stringify(editor));
    assert.match(result.reasons.join('\n'), /waiting for Codex/);
  }
  // A never-edited comment created for this head is Codex's own.
  assert.equal(evaluate({ ...pr, comments: [{ ...receipt, body: stateFor(head), editor: null }] }).verdict, 'PASS');
});
const potFile = { path: 'languages/woocommerce-pos.pot', additions: 6, deletions: 6 };
const potPR = { ...pr, author: { login: 'wcpos-bot', __typename: 'Bot' }, title: 'chore(i18n): update languages/woocommerce-pos.pot', files: [potFile] };
test('a wcpos-bot POT-only PR needs no Codex review', () => {
  const result = evaluate(potPR);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.needsCodex, false);
  assert.match(result.warnings.join('\n'), /automation PR \(POT update\)/);
});
test('the POT exemption is strict on a Bot author, the exact title and the single file', () => {
  for (const changed of [
    { author: { login: 'wcpos-bot' } }, // a User registered under the bot's name
    { author: { login: 'owner', __typename: 'User' } },
    { author: { login: 'github-actions[bot]' } },
    { title: 'chore(i18n): update languages/other.pot' },
    { title: 'chore(i18n): update languages/woocommerce-pos.pot and more' },
    { files: [potFile, { path: 'includes/Init.php', additions: 1, deletions: 0 }] },
    { files: [] },
  ]) {
    const result = evaluate({ ...potPR, ...changed });
    assert.equal(result.verdict, 'FAIL', JSON.stringify(changed));
    assert.match(result.reasons.join('\n'), /waiting for Codex/);
    assert.doesNotMatch(result.warnings.join('\n'), /automation PR/);
  }
});
const versionFile = (additions, deletions = additions) => ({ path: 'woocommerce-pos.php', additions, deletions });
const versionPR = { ...pr, author: { login: 'translations-ci', __typename: 'Bot' }, title: 'chore: update translation version to 2026.10.5', files: [versionFile(1)] };
test('a translations-ci version bump replacing one or two lines in one file needs no Codex review', () => {
  assert.equal(evaluate(versionPR).verdict, 'PASS');
  assert.equal(evaluate({ ...versionPR, files: [versionFile(2)] }).verdict, 'PASS');
  for (const changed of [
    { files: [versionFile(3)] }, { files: [versionFile(2, 1)] }, { files: [versionFile(0)] },
    { files: [versionFile(1), { path: 'readme.txt', additions: 1, deletions: 1 }] },
    { title: 'chore: update translation version to next' },
    { author: { login: 'wcpos-bot', __typename: 'Bot' } },
    { author: { login: 'translations-ci', __typename: 'User' } },
  ]) assert.equal(evaluate({ ...versionPR, ...changed }).verdict, 'FAIL', JSON.stringify(changed));
});
const approval = { author: { login: 'wcpos-project-bot', __typename: 'Bot' }, body: '', state: 'APPROVED', submittedAt: '2026-10-17T12:00:00Z', commit: { oid: head } };
const dependabotPR = { ...pr, author: { login: 'dependabot', __typename: 'Bot' }, title: 'build(deps): bump the actions group with 3 updates', reviews: [approval] };
test('a Dependabot PR approved by the project bot on its current head needs no Codex review', () => {
  assert.equal(evaluate(dependabotPR).verdict, 'PASS');
  for (const reviews of [[], [{ ...approval, commit: { oid: 'old' } }], [{ ...approval, state: 'COMMENTED' }], [{ ...approval, state: 'DISMISSED' }],
    [{ ...approval, author: { login: 'owner', __typename: 'User' } }], [{ ...approval, author: { login: 'wcpos-bot', __typename: 'Bot' } }]])
    assert.equal(evaluate({ ...dependabotPR, reviews }).verdict, 'FAIL', JSON.stringify(reviews));
  assert.equal(evaluate({ ...dependabotPR, author: { login: 'owner', __typename: 'User' } }).verdict, 'FAIL');
  // An approval from before a base change is stale, exactly like a Codex review.
  assert.equal(evaluate({ ...dependabotPR, timeline: [{ __typename: 'BaseRefChangedEvent', createdAt: '2026-10-17T13:00:00Z' }] }).verdict, 'FAIL');
  assert.equal(evaluate({ ...dependabotPR, timeline: [{ __typename: 'BaseRefChangedEvent', createdAt: '2026-10-17T11:00:00Z' }] }).verdict, 'PASS');
});
test('automation PRs still answer threads and review bodies and may not be drafts', () => {
  const finding = { author: { login: 'coderabbitai' }, body: 'P1 potential issue', createdAt: pass.submittedAt };
  assert.equal(evaluate({ ...potPR, threads: [{ isResolved: false, comments: [finding] }] }).verdict, 'FAIL');
  assert.equal(evaluate({ ...potPR, threads: [{ isResolved: true, comments: [finding] }] }).verdict, 'FAIL');
  assert.equal(evaluate({ ...potPR, isDraft: true }).verdict, 'FAIL');
  assert.equal(evaluate({ ...potPR, reviews: [{ ...pass, author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }] }).verdict, 'FAIL');
});
test('the workflow loads the changed files, so an automation PR passes end to end', () => {
  const result = workflow({ prs: { 7: potPR } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"state":"success"/);
  assert.match(result.stdout, /automation PR \(POT update\)/);
});
const doc = (path, additions = 10, deletions = 0) => ({ path, additions, deletions });
const docsPR = { ...pr, title: 'docs(adr): 0040 — the server derives paid', files: [
  doc('docs/adr/0040-server-derives-paid-no-money-epoch.md'), doc('GLOSSARY.md'), doc('.claude/specs/2026-10-19-x/SPEC.md'), doc('.ai/rules/db-tables.mdc', 3, 1), doc('docs/plans/diagram.svg'), doc('versioned_docs/version-1.x/getting-started/install.mdx'), doc('src/pages/faq.mdx', 2, 2),
] };
test('a documentation-only PR by anyone needs no Codex review', () => {
  const result = evaluate(docsPR);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(result.needsCodex, false);
  assert.match(result.warnings.join('\n'), /docs-only PR: Codex review not required/);
  assert.doesNotMatch(result.warnings.join('\n'), /automation PR/);
  assert.equal(evaluate({ ...docsPR, author: { login: 'wcpos-bot', __typename: 'Bot' } }).verdict, 'PASS');
});
test('one file outside Markdown or docs/ makes the PR code again; an empty file set is not documentation', () => {
  for (const extra of [
    'includes/Init.php', 'README.php', 'tests/includes/Test_Thing.php', '.github/workflows/ci.yml', 'package.json', 'readme.txt',
    'languages/woocommerce-pos.pot', '.claude/hooks/guard.js', 'src/docs.md.js', 'documentation/index.html', 'versioned_docs/version-1.x/img/screen.png', 'src/components/Tabs.mdx.js',
  ]) {
    const result = evaluate({ ...docsPR, files: [...docsPR.files, doc(extra)] });
    assert.equal(result.verdict, 'FAIL', extra);
    assert.match(result.reasons.join('\n'), /waiting for Codex/, extra);
    assert.doesNotMatch(result.warnings.join('\n'), /docs-only/, extra);
  }
  assert.equal(evaluate({ ...docsPR, files: [] }).verdict, 'FAIL');
  assert.equal(evaluate({ ...docsPR, files: undefined }).verdict, 'FAIL');
});
test('documentation-only PRs still answer threads and review bodies and may not be drafts', () => {
  const finding = { author: { login: 'coderabbitai' }, body: 'P1 potential issue', createdAt: pass.submittedAt };
  assert.equal(evaluate({ ...docsPR, threads: [{ isResolved: false, comments: [finding] }] }).verdict, 'FAIL');
  assert.equal(evaluate({ ...docsPR, threads: [{ isResolved: true, comments: [finding] }] }).verdict, 'FAIL');
  assert.equal(evaluate({ ...docsPR, isDraft: true }).verdict, 'FAIL');
  assert.equal(evaluate({ ...docsPR, reviews: [{ ...pass, author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }] }).verdict, 'FAIL');
});
test('the workflow loads the changed files, so a documentation-only PR passes end to end', () => {
  const result = workflow({ prs: { 7: docsPR } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"state":"success"/);
  assert.match(result.stdout, /docs-only PR/);
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
    assert.equal(evaluate({ ...changed, reviews: [fresh, { ...pass, author: { login: 'coderabbitai' } }] }).verdict, 'PASS');
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
    assert.equal(result.stdout.split('STATUS ').length - 1, 2, 'one pending and one aggregate verdict');
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
  const result = workflow({ resolveOnly: 'true', eventName: 'workflow_run', shaInput: 'merge', parents: [{ sha: 'base' }, { sha: head }],
    prs: { 7: ready }, associated: [{ number: 7, state: 'open', head: { sha: head } }] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.output, `sha=${head}\n`);
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

for (const readError of [false, true]) for (const reviewed of [false, true]) {
  test(`publish=false evaluates without any status POST (readError=${readError}, reviewed=${reviewed})`, () => {
    const result = workflow({ publish: 'false', readError, prs: { 7: reviewed ? ready : pr } });
    // A blocked verdict does not fail this lane: its check run cannot be updated when the reviewer
    // finishes later, and the published status is the gate. Only a failed evaluation exits 1.
    assert.equal(result.status, readError ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, reviewed && !readError ? /"verdict": "PASS"/ : /"verdict": "FAIL"/);
    assert.doesNotMatch(result.stdout, /STATUS /);
    assert.equal(result.target?.pr, 7);
  });
}
for (const merge of [false, true]) for (const matches of [false, true]) {
  test(`publisher falls back to owner/branch with exact head (merge=${merge}, matches=${matches})`, () => {
    const result = workflow({ resolveOnly: 'true', eventName: 'workflow_run', shaInput: merge ? 'merge' : head,
      parents: merge ? [{ sha: 'base' }, { sha: head }] : [],
      headOwner: 'contributor', headBranch: 'feature/fix', prs: { 7: ready, 8: pr },
      branchPRs: [7, 8].map(number => ({ number, state: 'open', head: { sha: matches ? head : 'moved' } })) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /BRANCH LOOKUP/);
    if (matches) {
      assert.match(result.stdout, /Resolved PRs by owner\/branch/);
      assert.equal(result.output, `sha=${head}\n`);
      assert.doesNotMatch(result.stdout, /STATUS /);
      assert.doesNotMatch(result.stdout, /statuses\/merge/);
      const published = workflow({ eventName: 'workflow_run', shaInput: result.output.trim().slice(4), prs: { 7: ready, 8: pr },
        branchPRs: [7, 8].map(number => ({ number, state: 'open', head: { sha: head } })) });
      assert.equal(published.status, 1, published.stdout + published.stderr);
      assert.match(published.stdout, /"description":"Blocked PRs: #8"/);
    } else {
      assert.match(result.stdout, /No open PRs/);
      assert.doesNotMatch(result.stdout, /STATUS /);
    }
  });
}

for (const eventName of ['pull_request', 'issue_comment', 'pull_request_review', 'workflow_dispatch']) test(`${eventName}: failed read-only evaluation writes its target`, () => {
  const result = workflow({ publish: 'false', eventName });
  assert.deepEqual(result.target, { pr: 7, sha: head });
});
test('publisher validates artifact data, targets the live PR or falls back to SHA', () => {
  const script = readFileSync(new URL('../.github/workflows/review-gate.yml', import.meta.url), 'utf8').match(/node <<'NODE'\n([\s\S]*?)\n\s*NODE/);
  assert.ok(script, 'publisher must validate the downloaded artifact');
  for (const data of [JSON.stringify({ pr: 7, sha: 'b'.repeat(40) }), undefined, '{', 'null', '{"pr":7,"sha":"bad"}', JSON.stringify({ pr: '7', sha: head }), JSON.stringify({ pr: -1, sha: head })]) {
    let output = '';
    runInNewContext(script[1], { require: () => ({ readFileSync: () => data, appendFileSync: (_, text) => { output += text; } }), process: { env: {} }, console });
    const valid = !!data?.includes('bbbb');
    assert.equal(output, valid ? 'pr=7\n' : '');
    const result = workflow({ resolveOnly: 'true', eventName: 'workflow_run', prInput: output.split('=')[1]?.trim() || '', shaInput: output ? '' : head, prs: { 7: ready }, associated: [{ number: 7, state: 'open', head: { sha: head } }] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.output, `sha=${head}\n`);
    assert.doesNotMatch(result.stdout, /STATUS |GRAPHQL/);
    assert.equal(result.stdout.includes('Resolved PRs by head SHA'), !valid);
  }
});

for (const eventName of ['pull_request', 'issue_comment', 'pull_request_review', 'workflow_dispatch']) test(`${eventName}: handoff survives the first live PR fetch failing`, () => {
  const result = workflow({ publish: 'false', eventName, restError: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.target, { pr: 7, sha: ['issue_comment', 'workflow_dispatch'].includes(eventName) ? '0'.repeat(40) : head });
  assert.doesNotMatch(result.stdout, /STATUS /);
});
for (const state of ['OPEN', 'CLOSED', 'MERGED']) test(`resolver emits only an open artifact target's live head (${state})`, () => {
  const result = workflow({ resolveOnly: 'true', eventName: 'workflow_run', prInput: '7', prs: { 7: { ...pr, state, headRefOid: 'b'.repeat(40) } } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.output, state === 'OPEN' ? `sha=${'b'.repeat(40)}
` : '');
  assert.doesNotMatch(result.stdout, /STATUS |GRAPHQL/);
});
test('resolver with no fallback match emits no publish target', () => {
  const result = workflow({ resolveOnly: 'true', eventName: 'workflow_run', shaInput: head });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, '');
  assert.doesNotMatch(result.stdout, /STATUS |GRAPHQL/);
});

test('resolver keeps a closed target head when another open PR shares it', () => {
  const result = workflow({ resolveOnly: 'true', eventName: 'workflow_run', prInput: '7', prs: { 7: { ...pr, state: 'CLOSED' } },
    associated: [{ number: 8, state: 'open', head: { sha: head } }] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, `sha=${head}\n`);
  assert.doesNotMatch(result.stdout, /STATUS |GRAPHQL/);
});
test('publisher cannot leave its resolved concurrency SHA via merge fallback', () => {
  const result = workflow({ eventName: 'workflow_run', shaInput: 'merge', parents: [{ sha: 'base' }, { sha: head }],
    associated: [{ number: 7, state: 'open', head: { sha: head } }] });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /STATUS |second parent/);
});
