import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CODEX = 'chatgpt-codex-connector';
const RABBIT = 'coderabbitai';
const login = c => c.author?.login?.replace(/\[bot\]$/, '').toLowerCase();
const bot = c => c.author?.__typename === 'Bot' || /\[bot\]$/.test(c.author?.login) || [CODEX, RABBIT].includes(login(c));
const human = c => !!c.author && !bot(c);
const stamp = c => Date.parse(c.submittedAt || c.createdAt);
const severity = /\bP[0-3]\b|\b(critical|major|minor|blocker|severity)\b|outside diff range|potential issue/i;

export function evaluate(pr, historical = false) {
  const reasons = [], warnings = [];
  if (pr.state === 'MERGED' && !historical) return { verdict: 'MERGED', reasons: ['Already merged; use sweep for historical audit.'], warnings };
  const cutoff = historical ? Date.parse(pr.mergedAt) : Infinity;
  const reviews = pr.reviews.filter(r => r.state !== 'DISMISSED' && r.submittedAt && stamp(r) <= cutoff);
  const comments = pr.comments.filter(c => stamp(c) <= cutoff);
  for (const t of pr.threads) {
    const cs = t.comments.filter(c => stamp(c) <= cutoff);
    if (!cs.length) continue;
    const link = cs[0].url;
    if (!t.isResolved) reasons.push(`${historical ? 'currently ' : ''}unresolved thread: ${link}`);
    const author = login(cs[0]);
    if (author !== login(pr)) {
      // The finding is the bot's first comment or its last comment that still carries a
      // severity marker; a bot acknowledgement after a human reply ("@you Thanks for the
      // fix", "You are correct") is not a new finding and must not re-open the question.
      const findings = cs.map((c, i) => (login(c) === author && (i === 0 || (bot(cs[0]) && severity.test(c.body || ''))) ? i : -1)).filter(i => i >= 0);
      const lastFinding = findings.length ? findings[findings.length - 1] : 0;
      if (!cs.slice(lastFinding + 1).some(c => bot(cs[0]) ? human(c) : login(c) && login(c) !== author))
        reasons.push(`unanswered ${bot(cs[0]) ? 'bot ' : ''}thread: ${link}`);
    }
  }
  if (!historical) {
    if (pr.isDraft) reasons.push('PR is a draft');
    for (const r of reviews.filter(r => r.state !== 'APPROVED')) {
      const substantive = bot(r) ? severity.test(r.body) : r.body.trim().length > 20 || r.state === 'CHANGES_REQUESTED';
      if (substantive && !comments.some(c => human(c) && stamp(c) > Date.parse(r.lastEditedAt || r.submittedAt))) reasons.push(`unanswered review body: ${r.url}`);
    }
  } else warnings.push('GitHub exposes current resolution only, not resolution timestamps; unresolved-at-merge cannot be proven. Edited/deleted comments also limit historical evidence.');
  const threshold = (pr.timeline || []).filter(e => stamp(e) <= cutoff)
    .reduce((date, e) => Math.max(date, stamp(e)), Date.parse(pr.headCommittedAt));
  if (!Number.isFinite(threshold)) throw new Error('Missing commit timestamp');
  const latest = items => items.reduce((a, b) => !a || stamp(b) > stamp(a) ? b : a, null);
  const requests = comments.filter(c => human(c) && /^@codex\s+review\b/im.test(c.body));
  const request = latest(requests);
  const receipts = comments.filter(c => login(c) === CODEX && c.body.includes('codex-review-receipt'));
  // Codex also posts a `codex-review-state:v1 {json}` comment naming the commit it reviews
  // (observed 2026-10-17); it carries the OID the receipt lacks, so it outranks the receipt.
  const states = comments.filter(c => login(c) === CODEX && c.body.includes('codex-review-state:v1')).map(c => {
    const m = c.body.match(/codex-review-state:v1\s*(\{[\s\S]*?\})\s*-->/);
    try { return { c, state: m ? JSON.parse(m[1]).code_review : null }; } catch { return { c, state: null }; }
  }).filter(x => x.state && x.state.commit_sha === pr.headRefOid && stamp(x.c) >= threshold);
  const stateDone = states.some(x => x.state.status === 'completed');
  const stateRunning = !stateDone && states.some(x => x.state.status === 'running');
  const codex = latest(reviews.filter(r => login(r) === CODEX).concat(receipts));
  const receiptPass = receipts.includes(codex) && request && stamp(codex) > threshold && stamp(codex) > stamp(request);
  const reviewOnHead = reviews.some(r => login(r) === CODEX && r.commit?.oid === pr.headRefOid && stamp(r) >= threshold);
  const staleCodex = !(stateDone || reviewOnHead || receiptPass);
  if (receiptPass && !stateDone && !reviewOnHead) warnings.push('Codex receipt-based pass: receipt postdates the freshness boundary and latest @codex review request; receipt has no commit OID.');
  if (staleCodex) reasons.push(historical ? 'Codex pass missing or not for PR head' : stateRunning ? `Codex is reviewing ${pr.headRefOid} (state: running); wait` : `waiting for Codex on ${pr.headRefOid}`);
  const rabbit = latest(reviews.filter(r => login(r) === RABBIT));
  if (rabbit && (rabbit.commit?.oid !== pr.headRefOid || stamp(rabbit) < threshold)) reasons.push('CodeRabbit pass missing for current head/base');
  const needsCodex = !historical && staleCodex && !stateRunning && !requests.some(c => stamp(c) > threshold);
  if (needsCodex) warnings.push('Codex has not reviewed this head: a repository member must post `@codex review` (bot-authored requests are refused by Codex).');
  return { verdict: reasons.length ? 'FAIL' : 'PASS', sha: pr.headRefOid, reasons, warnings, needsCodex };
}

async function api(path, method = 'GET', body) {
  const token = process.env.REVIEW_SWEEP_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const response = await fetch(`https://api.github.com${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.errors) throw Object.assign(new Error(`GitHub ${response.status}: ${JSON.stringify(data.errors || data.message)}`), { status: response.status });
  return data;
}
const gql = async query => (await api('/graphql', 'POST', { query })).data;
const pageInfo = 'pageInfo { hasNextPage endCursor }';
const commentFields = 'author { login __typename } body createdAt url';

// Every connection, including nested thread comments, is fully paginated.
async function connection(id, type, field, fields, initial, args = '') {
  const nodes = [];
  let page = initial, cursor = null;
  do {
    if (!page) {
      const data = await gql(`{ node(id:${JSON.stringify(id)}) { ... on ${type} {
        ${field}(first:100, after:${JSON.stringify(cursor)}${args}) { nodes { ${fields} } ${pageInfo} }
      } } }`);
      page = data.node[field];
    }
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    page = null;
  } while (cursor);
  return nodes;
}
async function restPages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const items = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
}
export async function loadPR(spec) {
  const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
  if (!match) throw new Error('Expected --pr owner/repo#number');
  const [, owner, repo, number] = match;
  const repository = `repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(repo)})`;
  const { repository: { pullRequest: pr } } = await gql(`{ ${repository} { pullRequest(number:${number}) {
    id state isDraft author { login } headRefOid url mergedAt commits(last:1) { nodes { commit { committedDate } } }
  } } }`);
  if (!pr) throw new Error(`PR not found: ${spec}`);
  pr.headCommittedAt = pr.commits.nodes[0]?.commit.committedDate;
  const collect = (field, fields) => connection(pr.id, 'PullRequest', field, fields);
  pr.timeline = await connection(pr.id, 'PullRequest', 'timelineItems',
    '... on HeadRefForcePushedEvent { createdAt } ... on BaseRefChangedEvent { createdAt }',
    undefined, ', itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT]');
  pr.reviews = await collect('reviews', 'author { login __typename } body submittedAt lastEditedAt commit { oid } state url');
  pr.comments = await collect('comments', commentFields);
  pr.threads = await collect('reviewThreads', `id isResolved comments(first:100) { nodes { ${commentFields} } ${pageInfo} }`);
  for (const t of pr.threads) t.comments = await connection(t.id, 'PullRequestReviewThread', 'comments', commentFields, t.comments);
  return pr;
}

async function sweep() {
  const since = new Date(Date.now() - 8 * 86400000).toISOString();
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const title = `Review sweep: merged with unanswered findings (week of ${monday.toISOString().slice(0, 10)})`;
  const limited = !process.env.REVIEW_SWEEP_TOKEN;
  const scope = limited ? 'WARNING: REVIEW_SWEEP_TOKEN missing; only wcpos/.github was scanned.' : 'Scope: wcpos repositories visible to REVIEW_SWEEP_TOKEN.';
  if (limited) console.warn(scope);
  const repos = limited ? [{ full_name: 'wcpos/.github' }] : await restPages('/orgs/wcpos/repos?type=all');
  const lines = [], errors = [];
  for (const repo of repos) {
    try {
      for (let page = 1; ; page++) {
        const prs = await api(`/repos/${repo.full_name}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
        for (const p of prs.filter(p => p.merged_at && p.merged_at >= since)) {
          const result = evaluate(await loadPR(`${repo.full_name}#${p.number}`), true);
          if (result.reasons.length) lines.push(`- ${repo.full_name}#${p.number} — ${result.reasons.join('; ')} — ${p.html_url}`);
        }
        if (prs.length < 100 || prs.at(-1).updated_at < since) break;
      }
    } catch (error) { errors.push(`${repo.full_name}: ${error.message}`); }
  }
  const body = `${scope}\n\nSince ${since}. Historical evidence, not proof: GitHub has no resolution timestamps; current unresolved state may differ from merge time. Replies/reviews after merge are excluded; edited/deleted content cannot be reconstructed. Reviews must match the PR head OID; Codex receipts must postdate both the last HEAD commit date and latest review request, never the merge commit timestamp.\n\n${lines.join('\n') || 'No findings in the scanned data.'}\n\n${errors.length ? `INCOMPLETE SCAN:\n${errors.join('\n')}` : ''}`;
  const issues = await restPages('/repos/wcpos/.github/issues?state=all');
  const existing = issues.find(i => !i.pull_request && i.title === title);
  await api(`/repos/wcpos/.github/issues${existing ? `/${existing.number}` : ''}`, existing ? 'PATCH' : 'POST', { title, body });
  console.log(JSON.stringify({ title, repositories: repos.length, findings: lines.length, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--sweep') return sweep();
  const workflow = args[0] === '--workflow';
  const event = workflow ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const inputSha = workflow && process.env.INPUT_SHA;
  let number = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && workflow ? process.env.INPUT_PR
    : event?.pull_request?.number || (event?.issue?.pull_request && event.issue.number);
  if (workflow && !number && !inputSha) return;
  let spec = workflow ? `${process.env.GITHUB_REPOSITORY}#${number}` : args[0] === '--pr' && args[1];
  let sha = inputSha || event?.pull_request?.head?.sha;
  let statusSkipped = false;
  const status = async (state, description) => {
    try {
      return await api(`/repos/${process.env.GITHUB_REPOSITORY}/statuses/${sha}`, 'POST', {
        state, context: 'review-gate', description: description.slice(0, 140),
        target_url: `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      });
    } catch (error) {
      if (error.status !== 403 || inputSha || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') throw error;
      statusSkipped = true;
    }
  };
  let pr, result, associated;
  try {
    if (inputSha) {
      associated = (await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`))
        .filter(p => p.state === 'open' && p.head.sha === sha);
      if (!associated.length) { console.log(`No open PRs for ${sha}; no status published.`); return; }
      number = associated[0].number;
      spec = `${process.env.GITHUB_REPOSITORY}#${number}`;
    }
    if (workflow) {
      // Issue-comment events have no head SHA. Never use GITHUB_SHA (default branch).
      const current = inputSha ? associated[0] : await api(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${number}`);
      sha = current.head.sha;
      if (current.merged) pr = { state: 'MERGED', headRefOid: sha };
      else await status('pending', 'Evaluating reviews on current head');
    }
    if (!pr) pr = await loadPR(spec || '');
    sha = pr.headRefOid;
    result = evaluate(pr);
    if (workflow && result.verdict !== 'MERGED') {
      associated ||= await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`);
      const numbers = new Set([Number(number), ...associated.filter(p => p.state === 'open' && p.head.sha === sha).map(p => p.number)]);
      const results = [];
      for (const n of numbers) results.push({ number: n, ...(n === Number(number) ? result
        : evaluate(await loadPR(`${process.env.GITHUB_REPOSITORY}#${n}`))) });
      const blocked = results.filter(r => r.verdict !== 'PASS').map(r => `#${r.number}`);
      result = { verdict: blocked.length ? 'FAIL' : 'PASS', sha, blocked,
        reasons: results.flatMap(r => r.reasons.map(s => `#${r.number}: ${s}`)),
        warnings: results.flatMap(r => r.warnings.map(s => `#${r.number}: ${s}`)),
        needsCodex: results.some(r => r.needsCodex) };
    }
  } catch (error) {
    if (!workflow) throw error;
    result = { verdict: 'FAIL', sha, reasons: ['could not evaluate; retry'], warnings: [error.message] };
    if (sha) {
      try { await status('failure', 'could not evaluate; retry'); }
      catch (failure) { result.warnings.push(`Could not publish failure status: ${failure.message}`); }
    } else result.warnings.push('Cannot publish failure status: API unavailable and event has no PR head SHA. Retry required.');
  }
  if (workflow && pr && result.verdict !== 'MERGED') {
    try { await status(result.verdict === 'PASS' ? 'success' : 'failure', result.blocked?.length ? `Blocked PRs: ${result.blocked.join(', ')}` : result.reasons[0] || 'All review findings answered on current head'); }
    catch (error) { result.verdict = 'FAIL'; result.reasons.push(`Could not publish head status: ${error.message}`); }
  }
  if (statusSkipped) result.warnings.push('restricted token: status not published from this run; the publisher run publishes it');
  console.log(JSON.stringify({ pr: spec, ...result }, null, 2));
  if (workflow && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## review-gate: ${result.verdict}\n\n${[...result.reasons, ...result.warnings].map(s => `- ${s}`).join('\n')}\n`);
  if (result.verdict === 'FAIL' && !statusSkipped) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
