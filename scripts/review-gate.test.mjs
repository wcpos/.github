import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { evaluate } from './review-gate.mjs';

const head = 'a'.repeat(40);
const pr = {
  state: 'OPEN', isDraft: false, headRefOid: head, headCommittedAt: '2026-10-17T10:00:00Z',
  reviews: [], comments: [], threads: [],
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
test('bot request after a valid member-request receipt does not invalidate it', () => {
  const comments = [request({ login: 'member', __typename: 'User' }), receipt,
    { ...request({ login: 'github-actions[bot]' }), createdAt: '2026-10-17T13:00:00Z' }];
  const result = evaluate({ ...pr, comments });
  assert.equal(result.verdict, 'PASS');
  assert.ok(result.warnings.some(w => /receipt-based/.test(w)));
});

// Exercise the CLI with only external GitHub I/O replaced; stdin supplies its event file.
function workflow({ fork = false, eventName = 'pull_request', statusCode = 200, readError = false, merged = false } = {}) {
  const event = eventName === 'workflow_dispatch' ? { inputs: { pr: '7' } } : {
    pull_request: { number: 7, head: { sha: head, repo: { full_name: fork ? 'outside/repo' : 'wcpos/repo' } },
      base: { repo: { full_name: 'wcpos/repo' } } },
  };
  const bootstrap = `
    const pr = ${JSON.stringify(pr)};
    globalThis.fetch = async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      if (url.endsWith('/pulls/7')) return Response.json({ head: { sha: pr.headRefOid }, merged: ${merged} });
      if (url.includes('/statuses/')) {
        console.log('STATUS ' + JSON.stringify({ url, ...body }));
        return Response.json({ message: 'status response' }, { status: ${statusCode} });
      }
      if (url.endsWith('/graphql')) {
        if (${readError}) return Response.json({ message: 'read denied' }, { status: 403 });
        if (body.query.includes('pullRequest(number:7)')) return Response.json({ data: { repository: { pullRequest: {
          ...pr, id: 'PR_id', commits: { nodes: [{ commit: { committedDate: pr.headCommittedAt } }] }
        } } } });
        const field = ['reviews', 'comments', 'reviewThreads'].find(f => body.query.includes(f + '('));
        if (field) return Response.json({ data: { node: { [field]: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      }
      throw new Error('Unexpected request: ' + url);
    };
    process.argv = [process.execPath, ${JSON.stringify(new URL('./review-gate.mjs', import.meta.url).pathname)}, '--workflow'];
    await import('./review-gate.mjs');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: new URL('.', import.meta.url), input: JSON.stringify(event), encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_PATH: '/dev/stdin', GITHUB_EVENT_NAME: eventName,
      GITHUB_REPOSITORY: 'wcpos/repo', GITHUB_RUN_ID: '123', GITHUB_TOKEN: 'test-only', REVIEW_SWEEP_TOKEN: '',
      GITHUB_STEP_SUMMARY: '', INPUT_PR: eventName === 'workflow_dispatch' ? '7' : '999' },
  });
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
for (const readError of [false, true]) {
  test(`fork status 403 exits zero with member recovery guidance (readError=${readError})`, () => {
    const result = workflow({ fork: true, statusCode: 403, readError });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /fork PR: status not published.*member.*pr=7/);
    assert.match(result.stdout, /"verdict": "FAIL"/);
  });
}
for (const options of [{ statusCode: 403 }, { fork: true, statusCode: 500 }, { readError: true }]) {
  test(`other API failures remain loud: ${JSON.stringify(options)}`, () => {
    const result = workflow(options);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /fork PR: status not published/);
  });
}
test('merged verdict never publishes a status', () => {
  const result = workflow({ merged: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"verdict": "MERGED"/);
  assert.doesNotMatch(result.stdout, /STATUS /);
});
