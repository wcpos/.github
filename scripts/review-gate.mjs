import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CODEX = 'chatgpt-codex-connector';
const RABBIT = 'coderabbitai';
const login = c => c.author?.login?.replace(/\[bot\]$/, '').toLowerCase();
const bot = c => c.author?.__typename === 'Bot' || /\[bot\]$/.test(c.author?.login) || [CODEX, RABBIT].includes(login(c));
const human = c => !!c.author && !bot(c);
const stamp = c => Date.parse(c.submittedAt || c.createdAt);
const severity = /\bP[0-3]\b|\b(critical|major|minor|blocker|severity)\b|outside diff range|potential issue/i;

// Automation PRs whose shape the consuming repo's Merge Gate already validates get no Codex
// requirement: Codex refuses bot-authored `@codex review`, and nobody is asked to post one on a
// generated .pot, a translation-version bump or a Dependabot bump the project bot has approved
// (observed 2026-10-19: woocommerce-pos#2314, #2310 and #2307-#2309 all blocked on it). The
// predicate is strict on author, title and file set so an automation token cannot smuggle other
// changes under it, and the author must be a Bot account so a user registered under a bot's name
// does not qualify. Every other rule (threads, review bodies, drafts) still applies.
const WCPOS_BOT = 'wcpos-bot', TRANSLATIONS_CI = 'translations-ci', DEPENDABOT = 'dependabot', PROJECT_BOT = 'wcpos-project-bot';
export function automation(pr) {
  if (!bot(pr)) return null;
  const author = login(pr), title = pr.title || '', files = pr.files || [];
  const pot = /^chore\(i18n\): update (\S+\.pot)$/.exec(title);
  if (author === WCPOS_BOT && pot && files.length === 1 && files[0].path === pot[1]) return 'POT update';
  // The Merge Gate checks the replaced lines themselves; here a bump is one file with one or two lines replaced.
  if (author === TRANSLATIONS_CI && /^chore: update translation version to \d{4}\.\d+\.\d+$/.test(title)
    && files.length === 1 && files[0].additions === files[0].deletions && files[0].additions >= 1 && files[0].additions <= 2) return 'translation version';
  // dependabot-auto-merge approves non-major bumps on each head; that approval is the judgment reused here.
  if (author === DEPENDABOT && pr.reviews.some(r => login(r) === PROJECT_BOT && r.state === 'APPROVED' && r.commit?.oid === pr.headRefOid)) return 'approved Dependabot bump';
  return null;
}

export function evaluate(pr) {
  const reasons = [], warnings = [];
  if (pr.state === 'MERGED') return { verdict: 'MERGED', reasons: ['Already merged.'], warnings };
  const reviews = pr.reviews.filter(r => r.state !== 'DISMISSED' && r.submittedAt);
  const comments = pr.comments;
  for (const t of pr.threads) {
    const cs = t.comments;
    if (!cs.length) continue;
    const link = cs[0].url;
    if (!t.isResolved) reasons.push(`unresolved thread: ${link}`);
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
  if (pr.isDraft) reasons.push('PR is a draft');
  for (const r of reviews.filter(r => r.state !== 'APPROVED')) {
    const substantive = r.state === 'CHANGES_REQUESTED' || (bot(r) ? severity.test(r.body) : r.body.trim().length > 20);
    const mention = login(r) && new RegExp(`@${login(r)}(?:\\[bot\\])?(?![\\w\\[\\]-])`, 'i');
    const reviewRef = r.url?.match(/pullrequestreview-\d+\b/)?.[0];
    if (substantive && !comments.some(c => human(c) && stamp(c) > Date.parse(r.lastEditedAt || r.submittedAt) &&
      (mention?.test(c.body) || (reviewRef && c.body.match(/\bpullrequestreview-\d+\b/g)?.includes(reviewRef)))))
      reasons.push(`unanswered review body: ${r.url}`);
  }
  const threshold = (pr.timeline || [])
    .reduce((date, e) => Math.max(date, stamp(e)), Date.parse(pr.headCommittedAt));
  if (!Number.isFinite(threshold)) throw new Error('Missing commit timestamp');
  const requests = comments.filter(c => human(c) && /^@codex\s+review\b/im.test(c.body));
  // Codex also posts a `codex-review-state:v1 {json}` comment naming the commit it reviews
  // (observed 2026-10-17); receipts have no OID and cannot prove a pass for this head.
  // Codex keeps ONE state comment per PR and edits it in place on every push (observed
  // 2026-10-17 on monorepo#2649), so its creation time predates every later head; the
  // edit time is when the state for this head was written.
  const stateStamp = c => Date.parse(c.lastEditedAt || c.createdAt);
  // Anyone with write access can edit a bot's comment, so an edited state comment counts only
  // when its last editor is Codex itself (GraphQL `editor`). A never-edited comment has no
  // `lastEditedAt`; an edited one whose editor is unknown (null) is not trusted either.
  const ownEdit = c => !c.lastEditedAt || login({ author: c.editor }) === CODEX;
  const states = comments.filter(c => login(c) === CODEX && ownEdit(c) && c.body.includes('codex-review-state:v1')).map(c => {
    const m = c.body.match(/codex-review-state:v1\s*(\{[\s\S]*?\})\s*-->/);
    try { return { c, state: m ? JSON.parse(m[1]).code_review : null }; } catch { return { c, state: null }; }
  }).filter(x => x.state && x.state.commit_sha === pr.headRefOid && stateStamp(x.c) >= threshold);
  const stateDone = states.some(x => x.state.status === 'completed');
  const stateRunning = !stateDone && states.some(x => x.state.status === 'running');
  const reviewOnHead = reviews.some(r => login(r) === CODEX && r.commit?.oid === pr.headRefOid && stamp(r) >= threshold);
  const kind = automation(pr);
  if (kind) warnings.push(`automation PR (${kind}): Codex review not required`);
  const staleCodex = !kind && !(stateDone || reviewOnHead);
  if (staleCodex) reasons.push(stateRunning ? `Codex is reviewing ${pr.headRefOid} (state: running); wait` : `waiting for Codex on ${pr.headRefOid}`);
  const needsCodex = staleCodex && !stateRunning && !requests.some(c => stamp(c) > threshold);
  if (needsCodex) warnings.push('Codex has not reviewed this head: a repository member must post `@codex review` (bot-authored requests are refused by Codex).');
  return { verdict: reasons.length ? 'FAIL' : 'PASS', sha: pr.headRefOid, reasons, warnings, needsCodex };
}

async function api(path, method = 'GET', body) {
  const token = process.env.GITHUB_TOKEN;
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
const commentFields = 'author { login __typename } editor { login } body createdAt lastEditedAt url';

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
    id state isDraft title author { login __typename } headRefOid url commits(last:1) { nodes { commit { committedDate } } }
  } } }`);
  if (!pr) throw new Error(`PR not found: ${spec}`);
  pr.headCommittedAt = pr.commits.nodes[0]?.commit.committedDate;
  const collect = (field, fields) => connection(pr.id, 'PullRequest', field, fields);
  pr.timeline = await connection(pr.id, 'PullRequest', 'timelineItems',
    '... on HeadRefForcePushedEvent { createdAt } ... on BaseRefChangedEvent { createdAt }',
    undefined, ', itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT]');
  pr.reviews = await collect('reviews', 'author { login __typename } body submittedAt lastEditedAt commit { oid } state url');
  pr.comments = await collect('comments', commentFields);
  pr.files = await collect('files', 'path additions deletions');
  pr.threads = await collect('reviewThreads', `id isResolved comments(first:100) { nodes { ${commentFields} } ${pageInfo} }`);
  for (const t of pr.threads) t.comments = await connection(t.id, 'PullRequestReviewThread', 'comments', commentFields, t.comments);
  return pr;
}

async function main() {
  const args = process.argv.slice(2);
  const workflow = args[0] === '--workflow';
  const event = workflow ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : null;
  const inputSha = workflow && process.env.INPUT_SHA;
  const resolveOnly = workflow && process.env.INPUT_RESOLVE_ONLY === 'true';
  const publish = workflow && !resolveOnly && process.env.INPUT_PUBLISH !== 'false';
  let number = ['workflow_dispatch', 'workflow_run'].includes(process.env.GITHUB_EVENT_NAME) && workflow ? Number(process.env.INPUT_PR)
    : event?.pull_request?.number || (event?.issue?.pull_request && event.issue.number);
  if (workflow && !number && !inputSha) return;
  let spec = workflow ? `${process.env.GITHUB_REPOSITORY}#${number}` : args[0] === '--pr' && args[1];
  let sha = inputSha || event?.pull_request?.head?.sha;
  // Zero SHA means unknown before the live fetch; the publisher trusts only the PR number.
  if (workflow && !publish && !resolveOnly && number)
    writeFileSync(`${process.env.RUNNER_TEMP}/review-gate-target.json`, JSON.stringify({ pr: Number(number), sha: sha || '0'.repeat(40) }));
  let statusSkipped = false, pending = false;
  const status = async (state, description) => {
    if (!publish) return;
    try {
      return await api(`/repos/${process.env.GITHUB_REPOSITORY}/statuses/${sha}`, 'POST', {
        state, context: 'review-gate', description: description.slice(0, 140),
        target_url: `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      });
    } catch (error) {
      if (error.status !== 403 || inputSha || ['workflow_dispatch', 'workflow_run'].includes(process.env.GITHUB_EVENT_NAME)) throw error;
      statusSkipped = true;
    }
  };
  let pr, result, associated;
  try {
    if (inputSha) {
      associated = (await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`))
        .filter(p => p.state === 'open' && p.head.sha === sha);
      if (!associated.length && !resolveOnly)
        associated = (await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/pulls?state=open`))
          .filter(p => p.state === 'open' && p.head.sha === sha);
      if (!associated.length && resolveOnly) {
        const commit = await api(`/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}`);
        if (commit.parents.length === 2) {
          sha = commit.parents[1].sha;
          console.log(`Trying second parent ${sha} of merge commit ${inputSha}`);
          associated = (await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`))
            .filter(p => p.state === 'open' && p.head.sha === sha);
        }
      }
      let resolvedBy = sha === inputSha ? 'head SHA' : 'merge second parent';
      const { INPUT_HEAD_OWNER: owner, INPUT_HEAD_BRANCH: branch } = process.env;
      if (!associated.length && resolveOnly && owner && branch) {
        associated = (await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`))
          .filter(p => p.state === 'open' && p.head.sha === sha);
        resolvedBy = 'owner/branch';
      }
      if (!associated.length) { console.log(`No open PRs for ${sha}; no status published.`); return; }
      console.log(`Resolved PRs by ${resolvedBy}: ${associated.map(p => `#${p.number}`).join(', ')}`);
      number = associated[0].number;
      spec = `${process.env.GITHUB_REPOSITORY}#${number}`;
    }
    if (workflow) {
      // Issue-comment events have no head SHA. Never use GITHUB_SHA (default branch).
      const current = inputSha ? associated[0] : await api(`/repos/${process.env.GITHUB_REPOSITORY}/pulls/${number}`);
      sha = current.head.sha;
      if (resolveOnly) {
        associated ||= current.state === 'open' && !current.merged ? [current] : await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`);
        if (associated.some(p => p.state === 'open' && p.head.sha === sha)) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
        else console.log(`No open PR for #${number}; no publish target.`);
        return;
      }
      if (!publish) writeFileSync(`${process.env.RUNNER_TEMP}/review-gate-target.json`, JSON.stringify({ pr: Number(number), sha }));
      pending = !current.merged && current.state === 'open';
      if (current.merged) pr = { state: 'MERGED', headRefOid: sha };
      else if (pending) await status('pending', 'Evaluating reviews on current head');
    }
    if (!pr) pr = await loadPR(spec || '');
    result = evaluate(pr);
    if (workflow && (pending || result.verdict !== 'MERGED')) {
      associated ||= await restPages(`/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`);
      const numbers = new Set([Number(number), ...associated.filter(p => p.state === 'open' && p.head.sha === sha).map(p => p.number)]);
      const results = [];
      for (const n of numbers) {
        const loaded = n === Number(number) ? pr : await loadPR(`${process.env.GITHUB_REPOSITORY}#${n}`);
        if (loaded.state !== 'OPEN' || loaded.headRefOid !== sha) continue;
        results.push({ number: n, ...evaluate(loaded) });
      }
      if (!results.length) {
        if (pending) await status('error', 'head moved; re-evaluated on the new head');
        console.log(`No open PRs for ${sha}; ${pending ? 'head moved' : 'no status published'}.`); return;
      }
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
