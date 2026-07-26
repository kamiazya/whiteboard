export const meta = {
  name: 'ci-triage',
  description:
    'Triage the POST-PUSH automated-review surface of a PR — GitHub Actions CI failures, CodeRabbit, AccessLint, CodeQL — separating real signal from bot noise and returning a deduped backlog of task/issue candidates. Read-only (gh + code reads); the integrator files the survivors. Complements the local lefthook pre-push gate.',
  whenToUse:
    'After a push, once the PR checks have run (or a review bot has commented). Pass args:{pr, cwd?, sources?}. Not for local pre-push gating (that is lefthook). See the ci-triage skill for the verified check surface + gh commands.',
  phases: [
    { title: 'Gather', detail: 'one agent per source fetches its findings via gh and assesses real-vs-noise' },
    { title: 'Triage', detail: 'dedupe + rank into a task/issue backlog' },
  ],
}

const A = (() => {
  try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} }
})()
const PR = A.pr
const CWD = A.cwd || null
const GH = CWD ? `gh` : 'gh' // gh is repo-aware from cwd; integrator runs from repo root
const cwdHint = CWD ? ` Run gh/git from ${CWD}.` : ''
if (!PR) return { error: 'args.pr (PR number) is required' }

// Sources to triage. Each is fetched read-only via gh; a source that 404s on auth scope is skipped, not failed.
const SOURCES = Array.isArray(A.sources) && A.sources.length
  ? A.sources
  : [
      {
        key: 'ci',
        brief: `GitHub Actions CI for PR #${PR}. Run \`gh pr checks ${PR}\` to list checks; for any non-pass GitHub-Actions check, get its run id and read \`gh run view <run-id> --log-failed\` to find the failing job/step + assertion. A CI failure is almost always REAL + BLOCKING (it gates merge) — but a flaky test-isolation failure (different test fails per run, passes in isolation; see tmp/issues/audit-test-fixture-dedup) is the exception: note it as flaky, not a code bug. Report each failure with the failing test/step, the likely cause, and a fix direction.`,
      },
      {
        key: 'coderabbit',
        brief: `CodeRabbit review on PR #${PR}. Fetch its line comments + summary via \`gh api repos/kamiazya/whiteboard/pulls/${PR}/comments\` and \`gh pr view ${PR} --json reviews,comments\`. NOTE: CodeRabbit SKIPS PRs whose title contains WIP/draft — if so, report that it was skipped (no findings to triage) and that removing WIP from the title unblocks it. For each real comment, VERIFY it against the actual code (CodeRabbit has high recall but hallucinates context): keep correctness/security/contract points; drop style nits already enforced by Biome and inapplicable "consider" suggestions. Mark each kept item real=true with evidence.`,
      },
      {
        key: 'accesslint',
        brief: `AccessLint accessibility review on PR #${PR}. Read its check + any a11y review comments (\`gh pr view ${PR} --json comments,reviews\`; \`gh api repos/kamiazya/whiteboard/pulls/${PR}/comments\` filtered to the accesslint actor). Keep real a11y issues on the touched UI components; map each to the file. If AccessLint did not run / has no comments, report none.`,
      },
      {
        key: 'codeql',
        brief: `CodeQL code-scanning for PR #${PR}. PRIMARY (scope-free, always works): CodeQL posts its findings as ordinary PR review comments authored by \`github-advanced-security[bot]\` — fetch them with \`gh api repos/kamiazya/whiteboard/pulls/${PR}/comments --jq '.[] | select(.user.login=="github-advanced-security[bot]") | {path, line, body}'\`. This needs NO special scope and is the reliable source; treat these comments as the CodeQL findings for this PR. ENRICHMENT (optional, may fail): \`gh api repos/kamiazya/whiteboard/code-scanning/alerts --jq '.[] | {rule: .rule.id, sev: .rule.security_severity_level, state, path: .most_recent_instance.location.path}'\` for severity/state — if it 404s ("no analysis found") or fails on auth scope (security_events/admin), just rely on the PR comments; do NOT fail. For any real finding, keep HIGH+ and verify the data-flow is genuine (not an already-sanitized path); a ReDoS/injection finding on an untrusted-input parser is real and blocking.`,
      },
    ]

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    source: { type: 'string' },
    available: { type: 'boolean', description: 'false if the source 404d / was skipped (WIP) / not configured' },
    note: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line or check/step' },
          detail: { type: 'string' },
          isReal: { type: 'boolean', description: 'survived verification against the actual code' },
          blocking: { type: 'boolean', description: 'gates the merge (CI failure)' },
          suggestedAction: { type: 'string' },
        },
        required: ['severity', 'title', 'isReal', 'suggestedAction'],
      },
    },
  },
  required: ['source', 'available', 'findings'],
}

const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    blockingNow: { type: 'array', items: { type: 'string' }, description: 'CI failures to fix before merge' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' }, severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          source: { type: 'string' }, location: { type: 'string' },
          suggestedAction: { type: 'string' },
          track: { enum: ['fix-now', 'task', 'issue', 'dismiss'] },
        },
        required: ['title', 'severity', 'track', 'suggestedAction'],
      },
    },
    summary: { type: 'string' },
    sourcesUnavailable: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'summary'],
}

// --- Phase 1: gather + assess per source ---
phase('Gather')
const gathered = (
  await parallel(
    SOURCES.map((s) => () =>
      agent(
        `Gather and assess the automated-review findings from ONE source for PR #${PR}.\n\nSOURCE: ${s.brief}${cwdHint}\n\nFetch read-only via gh, verify each finding against the real code (cite file:line), set available=false (with a note) if the source 404s/skipped/unconfigured, and return only findings that survive verification (isReal). Do not invent findings; do not fail the run if a source is unavailable.`,
        { label: `gather:${s.key}`, phase: 'Gather', agentType: 'general-purpose', schema: FINDINGS_SCHEMA },
      ),
    ),
  )
).filter(Boolean)

// --- Phase 2: triage into a backlog ---
phase('Triage')
const realFindings = gathered.flatMap((g) => (g.findings || []).filter((f) => f.isReal).map((f) => ({ ...f, source: g.source })))
const unavailable = gathered.filter((g) => !g.available).map((g) => `${g.source}${g.note ? ` (${g.note})` : ''}`)
const triaged = await agent(
  `Triage these verified post-push automated-review findings for PR #${PR} into a backlog for the integrator. Findings: ${JSON.stringify(realFindings)}\nUnavailable sources: ${JSON.stringify(unavailable)}\n\n` +
    `Dedupe across sources, rank by severity, and assign track per item: "fix-now" (CI-blocking or CRITICAL — must clear before merge), "task" (real, do soon), "issue" (backlog debt), "dismiss" (verified noise — e.g. a CodeRabbit style nit already covered by Biome). List the fix-now/CI-blocking ones in blockingNow. Be concise and decision-ready; do not invent items.`,
  { label: 'triage', phase: 'Triage', agentType: 'architect', schema: TRIAGE_SCHEMA },
)

return {
  pr: PR,
  sourcesAssessed: gathered.map((g) => g.source),
  sourcesUnavailable: unavailable,
  realFindingCount: realFindings.length,
  triaged,
  needsHumanGate: true,
  note: 'Read-only CI/automated-review triage. Integrator: clear blockingNow before merge; file track=task -> Tasks, track=issue -> tmp/issues, dismiss CodeRabbit noise by resolving the thread.',
}
