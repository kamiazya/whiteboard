export const meta = {
  name: 'dev-loop',
  description:
    "Drive one dev task's inner loop deterministically: design -> plan-review gate -> TDD implement -> simplify -> review (composes the review workflow) -> triage/fix loop. Returns a report for the integrator (main session) to commit/PR/merge.",
  whenToUse:
    'Per dev task. Launch one per task; for parallel work the main session launches several, each with its own cwd worktree. Human gates (design approval, commit, PR, merge) stay in the main session. Pass args:{taskTitle, taskSpec, baseRef, cwd?, files?, skipDesign?, designDoc?, maxPlanRevisions?, maxFixRounds?, fixThreshold?, codex?, docs?, reviewArgs?, dogfood?, appUrl?}. fixThreshold (default LOW) = resolve every finding at/above it on the spot, looping until review is clean; the loop breaks out only for human decisions or the round cap.',
  phases: [
    { title: 'Design', detail: 'draft a design doc (completion criteria / scope / contracts / test scenarios / risks)' },
    { title: 'PlanReview', detail: 'gate the design for completeness; one retry on fail' },
    { title: 'Implement', detail: 'TDD red->green, lint/typecheck, commit; operates in cwd' },
    { title: 'Simplify', detail: 'code-simplifier on changed files' },
    { title: 'Review', detail: 'compose the review workflow over baseRef..HEAD' },
    { title: 'Triage', detail: 'fix CRITICAL/HIGH (loop, capped), backlog the rest' },
  ],
}

// --- inputs ---
// The runtime delivers `args` as a JSON *string* (not an object), so normalize first.
const A = (() => {
  try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} }
})()
const TASK = A.taskTitle || 'untitled task'
const SPEC = A.taskSpec || ''
// baseRef: the SHA/ref that was HEAD before this task started (main session captures it).
// review diffs ${baseRef}..HEAD so it only sees this task's commits.
const BASE = A.baseRef || 'origin/main'
const CWD = A.cwd || null
const GIT = CWD ? `git -C ${CWD}` : 'git'
const FILES = Array.isArray(A.files) ? A.files : null
const SKIP_DESIGN = !!A.skipDesign
const PROVIDED_DESIGN = A.designDoc || null
const MAX_FIX = typeof A.maxFixRounds === 'number' ? A.maxFixRounds : 3
const MAX_PLAN_REV = typeof A.maxPlanRevisions === 'number' ? A.maxPlanRevisions : 1
// fixThreshold: lowest severity the fix loop resolves ON THE SPOT (ideal: leave nothing behind).
// Default LOW = fix everything actionable until review is clean; raise to HIGH for a quick patch.
const FIX_THRESHOLD = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(A.fixThreshold) ? A.fixThreshold : 'LOW'
const REVIEW_ARGS = A.reviewArgs || {}
const DOGFOOD = !!A.dogfood
const APP_URL = A.appUrl || null
// codex: add a Codex second-opinion at gate decisions (plan gate + review gate). Default on
// (codex CLI present); set codex:false to disable. Codex unavailable at runtime never blocks.
const CODEX = A.codex !== false
// docs: run a technical-writer docs-sync pass on the increment (commits doc files). Opt-in —
// enable when the change is user-visible or alters an API/contract/config.
const DOCS = !!A.docs

log(`dev-loop start: task="${TASK}" baseRef=${BASE} cwd=${CWD || '(repo root)'} skipDesign=${SKIP_DESIGN} maxFix=${MAX_FIX} specLen=${SPEC.length}`)

const cwdNote = CWD
  ? ` Work inside the worktree at ${CWD}: run git as \`${GIT} ...\`, and create/edit files under that path (use absolute paths).`
  : ''
const disciplineNote =
  'Follow AGENTS.md: Zod as the single source of truth for cross-boundary contracts (annotate execute returns with z.infer), never call console.* in server code (use getLogger), keep changes immutable, and keep at least one nearest-layer test for the root cause.'

// --- schemas ---
// Mirrors .claude/workflows/lib/design-schema.mjs (unit-tested via node:test — the workflow
// sandbox has no import/fs, so the schema is duplicated rather than imported; keep both in sync).
const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    completionCriteria: { type: 'array', items: { type: 'string' } },
    scope: { type: 'string' },
    contractChanges: { type: 'string', description: 'Zod/contract/type impact, or "none"' },
    testScenarios: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unit: { type: 'array', items: { type: 'string' } },
        browser: { type: 'array', items: { type: 'string' } },
        e2e: { type: 'array', items: { type: 'string' } },
      },
      required: ['unit'],
    },
    risks: { type: 'array', items: { type: 'string' } },
    // Never empty: pins the invariants/round-trips/metamorphic relations this change must hold.
    // A stateless/pure-UI design supplies exactly one sentinel entry `"none: <reason>"` so the
    // justification lives inside this same field instead of contradicting a `minItems: 1` empty
    // array. PlanReview fails the gate when a design that touches state/parser/store logic
    // supplies only that sentinel.
    properties: {
      type: 'array',
      // `pattern: '\\S'` rejects "", "   ", and other whitespace-only entries — minItems alone
      // only guards array length, not per-entry content.
      items: { type: 'string', pattern: '\\S' },
      minItems: 1,
      description:
        'Invariants, round-trip, and metamorphic relations this change must preserve (e.g. "parse(serialize(x)) === x", "reconcile is idempotent"). Never empty. For a stateless/pure-UI change with no parser/store/state-machine surface, supply exactly one entry of the form "none: <reason>".',
    },
  },
  required: ['completionCriteria', 'scope', 'testScenarios', 'properties'],
}

const PLAN_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    mustFix: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: ['pass', 'rationale'],
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    committed: { type: 'boolean' },
    headSha: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    commands: {
      type: 'object',
      additionalProperties: false,
      properties: { test: { type: 'string' }, typecheck: { type: 'string' } },
    },
    summary: { type: 'string' },
    blocked: { type: 'boolean', description: 'true if the agent could not complete (e.g. red test never went green)' },
  },
  required: ['committed', 'changedFiles', 'summary', 'blocked'],
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    committed: { type: 'boolean' },
    // Set when a finding needs an architectural/product decision rather than a mechanical fix —
    // the loop breaks out to the integrator (who asks the human) instead of guessing.
    needsDecision: { type: 'boolean' },
    decisions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { finding: { type: 'string' }, question: { type: 'string' } }, required: ['question'] },
    },
    notes: { type: 'string' },
  },
  required: ['fixed', 'committed'],
}

// Reuses the schema's own item pattern (rather than a second hand-picked regex) so a caller-
// provided designDoc is held to the exact same non-blank-entry invariant as an agent-generated
// design. Mirrors .claude/workflows/lib/design-schema.mjs's isValidDesignShape (see the sync test
// for why this is duplicated instead of imported).
const propertiesItemPattern = new RegExp(DESIGN_SCHEMA.properties.properties.items.pattern)

// Guards a caller-provided `designDoc` against the same shape DESIGN_SCHEMA enforces on a
// generated design, so a malformed/incomplete args.designDoc can't skip PlanReview's invariant
// check by never passing through the schema-constrained agent() call in the first place.
function isValidDesignShape(d) {
  if (!d || typeof d !== 'object') return false
  if (!Array.isArray(d.completionCriteria) || !d.completionCriteria.every((c) => typeof c === 'string')) return false
  if (typeof d.scope !== 'string') return false
  if (
    !d.testScenarios ||
    !Array.isArray(d.testScenarios.unit) ||
    !d.testScenarios.unit.every((u) => typeof u === 'string')
  ) {
    return false
  }
  if (!Array.isArray(d.properties) || d.properties.length < 1) return false
  if (!d.properties.every((p) => typeof p === 'string' && propertiesItemPattern.test(p))) return false
  return true
}

// Gates the design-generation phase. `skipDesign` means "skip generation because a valid design
// was already provided" — NOT "skip generation even after we just discarded that provided design
// as invalid". Mirrors .claude/workflows/lib/design-schema.mjs's shouldGenerateDesign (see the
// sync test for why this is duplicated instead of imported).
function shouldGenerateDesign({ hasDesign, skipDesign, discardedInvalidProvidedDesign }) {
  if (hasDesign) return false
  return !skipDesign || !!discardedInvalidProvidedDesign
}

// --- Phase 1: design ---
let design = PROVIDED_DESIGN
let discardedInvalidProvidedDesign = false
if (design && !isValidDesignShape(design)) {
  log('provided designDoc does not match DESIGN_SCHEMA (missing/invalid completionCriteria, scope, testScenarios.unit, or properties) — discarding it and generating a fresh design instead.')
  design = null
  discardedInvalidProvidedDesign = true
}
if (shouldGenerateDesign({ hasDesign: !!design, skipDesign: SKIP_DESIGN, discardedInvalidProvidedDesign })) {
  phase('Design')
  design = await agent(
    `Write a design doc for this dev task. Task: ${TASK}\nSpec: ${SPEC}\n${cwdNote}\nInspect the relevant code first, then produce: completion criteria, change scope, contract/Zod/type impact, test scenarios (unit/browser/e2e), risks, and \`properties\` — the invariants, round-trips, or metamorphic relations this change must preserve (e.g. parser/serializer round-trip, state-machine invariant, CRDT idempotence/convergence, concurrent-store convergence). \`properties\` must never be empty: for a stateless/pure-UI change with no parser/store/state-machine surface, supply exactly one entry \`"none: <reason>"\` instead. Do NOT write code yet.`,
    { label: 'design', phase: 'Design', schema: DESIGN_SCHEMA },
  )
}

// --- Phase 2: plan-review gate (in-house reviewer + optional Codex second opinion; one retry) ---
let planVerdict = { pass: true, rationale: 'design provided/skipped' }
let codexPlanVerdict = null
if (design) {
  phase('PlanReview')
  const reviewDesign = () =>
    agent(
      `Review this design for completeness before implementation. Task: ${TASK}\nDesign: ${JSON.stringify(design)}\n\nCheck: do the test scenarios cover every completion criterion? Are high-risk angles (negative path, contract/Zod drift, migration/fallback, race/unmount) present? Is scope a single coherent change? FAIL the gate if the design touches state, a parser/serializer, or a store (in-memory, persisted, or CRDT) and \`properties\` contains only the \`"none: <reason>"\` sentinel with no real invariant/round-trip/metamorphic property — that combination means an untested state-shape risk. Return pass=false with mustFix[] if not.`,
      { label: 'plan-review', phase: 'PlanReview', agentType: 'plan-reviewer', schema: PLAN_VERDICT_SCHEMA },
    )
  const codexReviewDesign = () =>
    agent(
      `Independently review this implementation design as a gate BEFORE coding starts. Task: ${TASK}\nDesign: ${JSON.stringify(design)}\n\nFlag missing test coverage, contract/Zod-vs-runtime drift risk, hidden edge cases, scope creep, or wrong assumptions about the codebase. FAIL the gate if the design touches state, a parser/serializer, or a store (in-memory, persisted, or CRDT) and \`properties\` contains only the \`"none: <reason>"\` sentinel with no real invariant/round-trip/metamorphic property. Return pass=false with concrete mustFix[] if implementation should not start as-is.`,
      { label: 'plan-review:codex', phase: 'PlanReview', agentType: 'codex:codex-rescue', schema: PLAN_VERDICT_SCHEMA },
    )
  // Both reviewers run; the gate fails if EITHER fails. Codex unavailable (null) never blocks.
  const runGate = async () => {
    const [mine, codex] = await Promise.all([
      reviewDesign(),
      CODEX ? codexReviewDesign() : Promise.resolve(null),
    ])
    codexPlanVerdict = codex
    const pass = !!(mine && mine.pass) && (codex ? codex.pass : true)
    const mustFix = [...((mine && mine.mustFix) || []), ...((codex && codex.mustFix) || [])]
    return { pass, mustFix, rationale: `in-house: ${mine && mine.rationale} | codex: ${codex ? codex.rationale : 'n/a'}` }
  }
  planVerdict = await runGate()
  let planRev = 0
  while (!planVerdict.pass && planRev < MAX_PLAN_REV) {
    planRev += 1
    log(`PlanReview failed (revise ${planRev}/${MAX_PLAN_REV}): ${(planVerdict.mustFix || []).join('; ')}`)
    design = await agent(
      `Revise this design to address the must-fix items, keeping the same schema. Task: ${TASK}\nDesign: ${JSON.stringify(design)}\nMust-fix: ${JSON.stringify(planVerdict.mustFix || [])}`,
      { label: `design-revise:${planRev}`, phase: 'Design', schema: DESIGN_SCHEMA },
    )
    planVerdict = await runGate()
  }
}

// --- Phase 3: implement (TDD, commits in cwd) ---
phase('Implement')
const impl = await agent(
  `Implement this task with TDD. Task: ${TASK}\nSpec: ${SPEC}\nApproved design: ${JSON.stringify(design)}\n${cwdNote}\n${disciplineNote}\n\nSteps: (1) write the smallest failing test at the nearest layer and confirm it RED. (2) make the minimal change to GREEN. (3) run the narrowest test project plus lint/typecheck. (4) COMMIT on the current branch with a Conventional Commit message (\`${GIT} add <only the files you changed, never -A> && ${GIT} commit\`). Report the resulting HEAD sha (\`${GIT} rev-parse HEAD\`), changed files, tests added, and the commands you ran. If you cannot get to green, set blocked=true and explain.`,
  { label: 'implement', phase: 'Implement', agentType: 'developer', schema: IMPL_SCHEMA },
)

if (!impl || impl.blocked || !impl.committed) {
  return {
    taskTitle: TASK,
    design,
    planVerdict,
    implReport: impl,
    review: null,
    openFollowups: [],
    needsHumanGate: true,
    note: 'Implementation did not complete (blocked or not committed); returning to integrator.',
  }
}

// --- Phase 4: simplify ---
phase('Simplify')
const simplify = await agent(
  `Run a simplification pass over the files changed by the last commit only. ${cwdNote}\nUse \`${GIT} show --stat HEAD\` to see them. Improve readability/duplication/over-engineering without changing behavior. Re-run the relevant tests. If you change anything, COMMIT it (\`${GIT} add <only the files you changed, never -A> && ${GIT} commit\`). Report what you changed or that you skipped (with reason).`,
  { label: 'simplify', phase: 'Simplify', agentType: 'code-simplifier:code-simplifier' },
)

// --- Phase 5: review (compose the review workflow over this task's commits) ---
phase('Review')
const reviewRange = `${BASE}..HEAD`
let review = await workflow(
  { scriptPath: '.claude/workflows/review.workflow.mjs' },
  { range: reviewRange, cwd: CWD, files: FILES, dogfood: DOGFOOD, appUrl: APP_URL, codex: CODEX, ...REVIEW_ARGS },
)

// --- Phase 6: triage / fix loop — resolve everything at/above threshold ON THE SPOT, loop until
// review is clean. Break out to the integrator only when a finding needs a human decision, or the
// round cap is hit. Tickets are the exception, not the default — leave nothing half-done. ---
const RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }
const threshold = RANK[FIX_THRESHOLD] || RANK.MEDIUM
const openFollowups = []
let decisions = []
let round = 0
while (review && Array.isArray(review.confirmedFindings)) {
  const actionable = review.confirmedFindings.filter((f) => (RANK[f.severity] || 0) >= threshold)
  const below = review.confirmedFindings.filter((f) => (RANK[f.severity] || 0) < threshold)
  below.forEach((f) => openFollowups.push({ title: f.title, severity: f.severity, file: f.file, detail: f.detail }))

  if (actionable.length === 0 || round >= MAX_FIX) {
    if (actionable.length > 0) {
      // hit the round cap with findings still open — surface to the integrator (do not silently ticket)
      actionable.forEach((f) => openFollowups.push({ title: `[UNFIXED] ${f.title}`, severity: f.severity, file: f.file, detail: f.detail }))
    }
    break
  }

  round += 1
  phase('Triage')
  log(`Fix round ${round}/${MAX_FIX}: ${actionable.length} finding(s) >= ${FIX_THRESHOLD}`)
  const fx = await agent(
    `Resolve these confirmed review findings ON THE SPOT (including nice-to-haves) — the goal is a clean, maintainable increment, not a quick patch. A quick win (a few lines) is ALWAYS worth doing now; never defer it. ${cwdNote}\n${disciplineNote}\nFindings: ${JSON.stringify(actionable.map((f) => ({ severity: f.severity, title: f.title, file: f.file, detail: f.detail })))}\n\nFor each mechanical fix: add/adjust the nearest-layer test, make the fix behavior-preservingly, re-run the relevant tests, and COMMIT (\`${GIT} add <only the files you changed, never -A> && ${GIT} commit\`). If a finding requires an ARCHITECTURAL/PRODUCT DECISION rather than a mechanical fix, do NOT guess — set needsDecision=true and list it under decisions{finding,question}; still fix everything else first.`,
    { label: `fix:round-${round}`, phase: 'Triage', agentType: 'developer', schema: FIX_SCHEMA },
  )
  if (fx && fx.needsDecision && Array.isArray(fx.decisions) && fx.decisions.length) {
    decisions = decisions.concat(fx.decisions)
    log(`fix round ${round} surfaced ${fx.decisions.length} decision(s) — breaking out to the integrator`)
    break
  }
  // re-review the (now larger) increment
  review = await workflow(
    { scriptPath: '.claude/workflows/review.workflow.mjs' },
    { range: reviewRange, cwd: CWD, files: FILES, codex: CODEX, ...REVIEW_ARGS },
  )
}

// --- Phase 7 (optional): docs sync (technical-writer; commits doc files only) ---
let docsReport = null
if (DOCS) {
  phase('Docs')
  docsReport = await agent(
    `Sync docs with the change in ${BASE}..HEAD.${cwdNote} Read the diff (\`${GIT} diff ${BASE}..HEAD\`), update affected docs to the SHIPPED state (honesty first; no aspirational claims), then commit only the doc files you changed (\`${GIT} add <doc files, never -A> && ${GIT} commit\`) with a \`docs:\` message. Report what you updated, what you left and why, and any user-visible change with no doc home.`,
    { label: 'docs', phase: 'Docs', agentType: 'technical-writer' },
  )
}

return {
  taskTitle: TASK,
  baseRef: BASE,
  cwd: CWD,
  design,
  planVerdict,
  codexPlanVerdict,
  implReport: impl,
  simplify,
  review,
  docsReport,
  fixRounds: round,
  decisions,
  openFollowups,
  needsHumanGate: true,
  note: 'Inner loop complete. Integrator: review the report, then commit-as-is / open PR / merge. Backlog openFollowups to tmp/issues.',
}
