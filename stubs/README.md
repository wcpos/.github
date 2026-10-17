# Review gate installation

Repository administrators: land the central workflow and script on `wcpos/.github`'s `main`, then copy `stubs/review-gate.yml` to `.github/workflows/review-gate.yml` on each repository's default branch (needed for PR issue-comment events). The stub must grant `statuses: write`, `pull-requests: write`, and `contents: read`. Require the **commit status context `review-gate`**, not a caller-prefixed check-run name, on every trunk using the line below; retain required thread resolution and disable bypasses. Every supported trigger publishes that context on the API-reported PR head, never the issue-comment run's default-branch SHA. The workflow runs trusted central code, never PR code. Fork tokens may lack status/comment write permissions, preventing completion; an authorized same-repo issue comment can rerun evaluation. Bot-authored `@codex review` triggering is unverified; if it does not start, post it as a human or agent. Resolving a thread alone does not trigger these workflows; rerun the PR workflow after resolution. Review-body dispositions require a later non-bot top-level PR comment. API failures publish failure when the head SHA and status endpoint are available; if both the API lookup and the event lack a head SHA, publication is impossible and the job fails. Sweep history cannot prove resolution time; it reports current unresolved state and surviving pre-merge comments, comparing freshness to the PR's last HEAD commit date, not the merge commit timestamp.

Ruleset requirement shorthand (not a complete GitHub ruleset JSON document):

```yaml
required_status_checks: review-gate
```
