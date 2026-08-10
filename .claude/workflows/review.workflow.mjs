export const meta = {
  name: 'review',
  description: 'Generic change-review gate for any git increment: parallel multi-dimension review + adversarial verify + QA smoke, returning one consolidated report',
  whenToUse:
    'Any time one integrator wants a consolidated gate on a diff (pre-merge, pre-un-draft, ad-hoc), instead of async reviewer/qa/security round-trips. Composable as a child of dev-loop via workflow({scriptPath}). Pass args:{range, files?, dimensions?, qaScenarios?}.',
  phases: [
    { title: 'Review', detail: 'reviewer-dimension x N + security-scanner over the diff' },
    { title: 'Verify', detail: 'adversarially verify each finding, drop the unreal' },
    { title: 'QA', detail: 'qa-scenario smoke against the touched flows' },
    { title: 'Dogfood', detail: 'optional live persona pass over the touched flow (needs a running app)' },
  ],
}

// --- inputs (override via Workflow args) ---
// The runtime delivers `args` as a JSON *string* (not an object), so normalize first.
const A = (() => {
  try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} }
})()
// range: a git range understood by `git diff`/`git log` (default: changes since branch diverged from origin/main).
const RANGE = A.range || 'origin/main...HEAD'
// files: optional explicit scope. When omitted, each agent discovers changed files via `git diff --name-only <range>`.
const FILES = (Array.isArray(A.files) && A.files.length > 0) ? A.files : null
// cwd: optional repo/worktree path so a composed parent (dev-loop) can point review at an
// isolated worktree. Agents prepend `git -C <cwd>` to every git command.
const CWD = A.cwd || null
const GIT = CWD ? `git -C ${CWD}` : 'git'
// dimensions / qaScenarios: tune cost. Smaller increments → fewer dimensions.
// Each entry is either a legacy string (criteria stays embedded in reviewer-dimension.md)
// or {name, content} where content is authoritative externalized criteria injected into
// the reviewer prompt. A resources/*.md pack exists under
// .claude/skills/review-gate/resources/ (mirroring audit-triage's
// .claude/skills/audit-triage/resources/) — see the review-gate skill for how a caller
// globs/reads those files and passes them through as {name, content}.
// `reachability` is in the DEFAULT set, not opt-in: an increment that builds, typechecks and
// passes its tests while nothing registers/mounts/renders it reads as finished to every other
// dimension, so the only reliable catch is a lane that always asks.
const RAW_DIMENSIONS = A.dimensions || ['correctness', 'contract', 'boundary', 'test-coverage', 'reachability']
// Mirrors .claude/workflows/lib/normalize-dimensions.mjs (unit-tested via node:test — the
// workflow runtime executes this file as a standalone function body with no module resolution,
// so it cannot `import` that file; keep the two in sync). Throws on a malformed non-string entry
// (e.g. missing `name`) instead of letting `undefined` silently propagate into the lane `key`,
// the reviewer prompt label, and the Codex lane-key special-case match below.
function normalizeDimension(d) {
  if (typeof d === 'string') return { name: d, content: null }
  if (d && typeof d === 'object' && typeof d.name === 'string' && d.name.length > 0) {
    return { name: d.name, content: d.content || null }
  }
  throw new Error(
    `invalid dimension entry: expected a string or a {name, content} object with a non-empty "name", got ${JSON.stringify(d)}`,
  )
}
const DIMENSIONS = RAW_DIMENSIONS.map((d) => normalizeDimension(d))
const QA_SCENARIOS = A.qaScenarios || ['smoke', 'error-recovery', 'startup']
// dogfood: optional live persona pass over the touched flow. Default OFF — needs a running app.
// Inline (not a nested workflow) so review stays composable as a child of dev-loop (1-level nesting limit).
const DOGFOOD = !!A.dogfood
const APP_URL = A.appUrl || null
const DOGFOOD_PERSONAS = typeof A.dogfoodPersonas === 'number' ? A.dogfoodPersonas : 1
// codex: add a Codex second-opinion review lane (gate decisions). Unavailable runtime → dropped.
const CODEX = !!A.codex

const scopeHint = FILES
  ? `Scope: the following files only — ${FILES.join(', ')}.`
  : `Scope: discover the changed files yourself with \`${GIT} diff --name-only ${RANGE}\`.`
const cwdHint = CWD ? ` All paths are under ${CWD}; run git as \`${GIT} ...\` and Read files at that absolute path.` : ''
const diffHint = `Read the actual diff with \`${GIT} diff ${RANGE}\` (and surrounding context via Read on each file).${cwdHint} ${scopeHint} Only report issues introduced or left unaddressed by THIS diff, not pre-existing debt.`

// --- schemas ---
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['severity', 'title', 'file', 'detail'],
      },
    },
    notApplicable: { type: 'boolean', description: 'set true when this dimension cannot meaningfully apply to the diff; findings stays [] unless something was still found' },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isReal: { type: 'boolean' },
    confidence: { enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
  },
  required: ['isReal', 'reasoning'],
}

const QA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenario: { type: 'string' },
    status: { enum: ['pass', 'fail', 'skip'] },
    notes: { type: 'string' },
  },
  required: ['scenario', 'status'],
}

// --- Phase 1+2: each review dimension is adversarially verified as soon as it lands (pipeline, no barrier) ---
// Partition = requested dimensions ∪ {'security'} (security is always-on and failable, same
// as any other dimension). The optional codex lane sits OUTSIDE the partition entirely — it's
// a second opinion, reported only via codexUnavailable, never counted as a failed dimension.
const REVIEW_LANES = [
  ...DIMENSIONS.map((dim) => ({
    agentType: 'reviewer-dimension',
    key: dim.name,
    partition: true,
    prompt: `Review dimension: ${dim.name}. ${dim.content ? `\nAUTHORITATIVE CRITERIA:\n${dim.content}\n` : ''}${diffHint}`,
  })),
  {
    agentType: 'security-scanner',
    key: 'security',
    partition: true,
    prompt: `Scan for injection / path-traversal / info-leak / auth-bypass introduced by the diff. ${diffHint}`,
  },
  // Optional Codex second opinion at the review gate. Runs only when codex is requested;
  // if the Codex runtime is unavailable the agent returns null and is reported via
  // codexUnavailable, never as a failed partition dimension.
  ...(CODEX
    ? [{
        agentType: 'codex:codex-rescue',
        key: 'codex',
        partition: false,
        prompt: `Independently review this diff as a gate before merge. Report concrete correctness/contract/security/test-gap findings the other reviewers may have missed. ${diffHint}`,
      }]
    : []),
]

let codexUnavailable = false
const failedDimensions = []
const notApplicableDimensions = []

const reviewed = await pipeline(
  REVIEW_LANES,
  (lane) =>
    agent(lane.prompt, {
      label: `review:${lane.key}`,
      phase: 'Review',
      agentType: lane.agentType,
      schema: FINDINGS_SCHEMA,
    }).then((r) => {
      if (!r) {
        if (lane.key === 'codex' && !lane.partition) {
          codexUnavailable = true
        } else if (lane.partition) {
          failedDimensions.push(lane.key)
        }
        return { key: lane.key, findings: [] }
      }
      const hasFindings = Array.isArray(r.findings) && r.findings.length > 0
      if (lane.partition && r.notApplicable && !hasFindings) {
        notApplicableDimensions.push(lane.key)
      }
      return { key: lane.key, findings: r.findings || [] }
    }),
  (rev) =>
    parallel(
      rev.findings.map((f) => () =>
        agent(
          `Adversarially verify this ${rev.key} finding. Default to isReal=false if you cannot reproduce it from the actual code. Finding: ${f.severity} — ${f.title} (${f.file}${f.line ? ':' + f.line : ''}). Detail: ${f.detail}\n\n${diffHint}`,
          { label: `verify:${rev.key}:${(f.file || '').split('/').pop()}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ).then((v) => ({ ...f, dimension: rev.key, verdict: v })),
      ),
    ),
)

const reviewedFindings = reviewed.flat().filter(Boolean)
// A failed mandatory partition lane (e.g. security, correctness) must never silently degrade to
// "zero findings" — that reads as a clean pass to the dev-loop gate, which only looks at
// confirmedFindings. Synthesize a gating finding instead; it's a process fact (the lane never
// ran), not a refutable code claim, so it bypasses adversarial verify like the failed-dimension
// coverage-gap advisories in audit-triage.
const failedLaneFindings = failedDimensions.map((key) => ({
  severity: 'HIGH',
  title: `mandatory review lane failed: ${key}`,
  kind: 'lane-failure',
  dimension: key,
  file: '',
  detail: `The ${key} review lane returned no result, so it contributed zero findings by default. Re-run the ${key} review lane (or otherwise confirm the diff is clean for it) before treating this gate as passed.`,
  verdict: { isReal: true, confidence: 'high', reasoning: 'lane failure is a process fact, not a claim to verify' },
}))
const allFindings = reviewedFindings.concat(failedLaneFindings)
// If a verdict is missing (verify agent died), keep the finding rather than silently drop it —
// same policy as audit-triage's verify pass: an unverified claim is safer surfaced than hidden.
const confirmed = allFindings.filter((f) => !f.verdict || f.verdict.isReal)

// --- Phase 3: QA smoke on the touched flows ---
const qa = (
  await parallel(
    QA_SCENARIOS.map((s) => () =>
      agent(
        `QA scenario: ${s}. Target increment: ${RANGE}.${cwdHint} Inspect the diff to learn the touched flow, then verify it behaves. If a real run is not possible in this environment, status=skip and give the exact command you would run. ${scopeHint}`,
        { label: `qa:${s}`, phase: 'QA', agentType: 'qa-scenario', schema: QA_SCHEMA },
      ),
    ),
  )
).filter(Boolean)

// --- Phase 4 (optional): live dogfood over the touched flow ---
// Inline persona pass (sequential — the browser MCP is a shared singleton). Only the flow
// this diff touches, as a user would experience it. Skipped unless dogfood+appUrl are set.
const DOGFOOD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    persona: { type: 'string' },
    goalAchieved: { enum: ['yes', 'partial', 'no', 'skip'] },
    summary: { type: 'string' },
    friction: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { enum: ['bug', 'missing-affordance', 'confusing', 'slow', 'dead-end'] },
          severity: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['kind', 'severity', 'title', 'detail'],
      },
    },
  },
  required: ['goalAchieved', 'summary', 'friction'],
}

const dogfood = []
if (DOGFOOD && APP_URL) {
  for (let i = 0; i < DOGFOOD_PERSONAS; i++) {
    const run = await agent(
      `Live dogfood of THIS change as a real user. First read the diff (\`${GIT} diff ${RANGE}\`) to learn which flow it touches.${cwdHint} Then, as a plausible user (persona #${i + 1}; pick a realistic context/goal that exercises the touched flow), drive the running app at ${APP_URL} with the Playwright MCP browser tools and try to accomplish that goal end-to-end. Stay in character; record concrete friction (bug / missing affordance / confusing / slow / dead-end) the change introduced or left unaddressed, with repro. Be efficient (a handful of meaningful steps). If ${APP_URL} is unreachable, goalAchieved=skip with the reason.`,
      { label: `dogfood:p${i + 1}`, phase: 'Dogfood', agentType: 'dogfood-persona', schema: DOGFOOD_SCHEMA },
    )
    if (run) dogfood.push(run)
  }
}

const bySeverity = (s) => confirmed.filter((f) => f.severity === s).length
return {
  range: RANGE,
  files: FILES,
  summary: {
    rawFindings: allFindings.length,
    confirmed: confirmed.length,
    critical: bySeverity('CRITICAL'),
    high: bySeverity('HIGH'),
    qaFail: qa.filter((q) => q.status === 'fail').length,
    dogfoodFriction: dogfood.reduce((n, r) => n + (r.friction ? r.friction.length : 0), 0),
    failedDimensions: failedDimensions.length,
  },
  failedDimensions,
  notApplicable: notApplicableDimensions,
  ...(CODEX ? { codexUnavailable } : {}),
  confirmedFindings: confirmed,
  qa,
  dogfood,
}
