export const meta = {
  name: 'audit-triage',
  description:
    'Standing whole-codebase health audit: fan out one auditor per health dimension (wiring-gaps / architecture / maintainability / contract-drift / test-gaps / dev-experience), adversarially verify the HIGH+ findings to kill false positives, then triage into a deduped, severity-ranked backlog of task/issue candidates. Read-only — the integrator (main session) files the survivors as Tasks / tmp-issues.',
  whenToUse:
    'Periodically (after a fold, weekly, or before a milestone) to surface standing problems the per-diff review never sees: unwired/incomplete features, architecture debt, maintainability rot, contract drift, missing tests, onboarding friction. Pass args:{scope?, dimensions?, cwd?, auditorAgent?, verifyFloor?}. Not a diff review (use the review workflow for a change). Returns triaged candidates; it cannot create Tasks itself.',
  phases: [
    { title: 'Audit', detail: 'one auditor per health dimension, in parallel, over the repo/scope' },
    { title: 'Verify', detail: 'adversarially verify each HIGH+ finding; drop the unreal' },
    { title: 'Triage', detail: 'dedupe, re-rank, propose task-vs-issue + ordering' },
  ],
}

// --- inputs (runtime delivers args as a JSON string) ---
const A = (() => {
  try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} }
})()
const SCOPE = A.scope || 'the whole repository'
const CWD = A.cwd || null
const GIT = CWD ? `git -C ${CWD}` : 'git'
const cwdHint = CWD ? ` Audit the repo under ${CWD} (run git as \`${GIT} ...\`, Read at that absolute path).` : ' Audit the repo at the session root.'
// Auditor agentType. Custom 'codebase-auditor' is NOT registered until a session reload (see
// workflow-authoring gotcha #7), so default to the always-registered read-only Explore agent and
// let callers override once it is loaded: args.auditorAgent.
const AUDITOR = A.auditorAgent || 'Explore'
// verifyFloor: lowest severity that gets an adversarial verify pass (default HIGH — verify HIGH+).
const VERIFY_FLOOR = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(A.verifyFloor) ? A.verifyFloor : 'HIGH'
const RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }
const DIMENSIONS = Array.isArray(A.dimensions) && A.dimensions.length
  ? A.dimensions
  : [
      'wiring-gaps — features that build/typecheck but do not actually function (placeholder/stub renders, _-prefixed-but-load-bearing values, TODO/FIXME/not-implemented, UI with no backend, backend with no caller, dead routes). The "looks done, isn\'t" class.',
      'architecture — leaky/violated seams, browser importing server internals, god modules, circular deps, a contract defined in two places, abstractions that do not pay for themselves.',
      'maintainability — files >800 lines, deep nesting, duplication, dead code, lying comments, mutation where immutability is the rule.',
      'contract-drift — hand-written TS interface paralleling a Zod schema, casts around process boundaries (as unknown/as any), persisted JSON parsed without a schema, client/server response shapes typed separately.',
      'test-gaps — critical paths with no nearest-layer test, .skip/xfail/todo tests, browser-only behavior covered only in jsdom, a contract with no conformance test.',
      'dev-experience — broken/incorrect setup steps, scripts that fail on a clean clone, flaky local services, missing/stale docs for a real workflow, new-contributor friction.',
    ]

log(`audit-triage: scope="${SCOPE}", ${DIMENSIONS.length} dimensions, auditor=${AUDITOR}, verifyFloor=${VERIFY_FLOOR}`)

// --- schemas ---
const FINDING = {
  type: 'object', additionalProperties: false,
  properties: {
    severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    title: { type: 'string', description: 'task-ready, imperative' },
    kind: { type: 'string', description: 'wiring-gap|architecture|maintainability|contract|test|devx' },
    area: { type: 'string', description: 'file or dir' },
    evidence: { type: 'string', description: 'path:line / grep hit — concrete' },
    whyItMatters: { type: 'string' },
    suggestedAction: { type: 'string' },
    effort: { enum: ['S', 'M', 'L'] },
  },
  required: ['severity', 'title', 'area', 'evidence', 'suggestedAction'],
}
const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { dimension: { type: 'string' }, findings: { type: 'array', items: FINDING } },
  required: ['dimension', 'findings'],
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { title: { type: 'string' }, real: { type: 'boolean' }, severityAdjusted: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] }, why: { type: 'string' } },
  required: ['title', 'real', 'why'],
}
const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' }, severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          kind: { type: 'string' }, area: { type: 'string' }, summary: { type: 'string' },
          suggestedAction: { type: 'string' }, effort: { enum: ['S', 'M', 'L'] },
          track: { enum: ['task', 'issue'], description: 'task = live board (do soon); issue = tmp/issues backlog' },
          relatedTo: { type: 'string', description: 'existing task/area it belongs under, if any' },
        },
        required: ['title', 'severity', 'kind', 'track', 'suggestedAction'],
      },
    },
    summary: { type: 'string' },
    counts: { type: 'string', description: 'by severity and by track' },
  },
  required: ['items', 'summary'],
}

// --- Phase 1: audit (one auditor per dimension) ---
phase('Audit')
const audits = (
  await parallel(
    DIMENSIONS.map((dim) => () =>
      agent(
        `Audit ${SCOPE} for STANDING health problems in this ONE dimension.\n\nDIMENSION: ${dim}\n${cwdHint}\n\nReturn evidence-grounded findings worth a ticket (path:line / grep). Severity honestly — precision over recall, no inflation; return an empty list if the dimension is clean in scope. Each finding needs a task-ready title, area, evidence, whyItMatters, suggestedAction, effort.`,
        { label: `audit:${dim.split(' ')[0]}`, phase: 'Audit', agentType: AUDITOR, schema: FINDINGS_SCHEMA },
      ),
    ),
  )
).filter(Boolean)
const allFindings = audits.flatMap((a) => (a.findings || []).map((f) => ({ ...f, dimension: a.dimension })))
log(`audit: ${allFindings.length} raw findings across ${audits.length} dimensions`)

// --- Phase 2: adversarially verify HIGH+ findings (kill false positives) ---
phase('Verify')
const floor = RANK[VERIFY_FLOOR] || RANK.HIGH
const toVerify = allFindings.filter((f) => (RANK[f.severity] || 0) >= floor)
const verifiedHigh = (
  await parallel(
    toVerify.map((f) => () =>
      agent(
        `Adversarially verify this codebase-audit finding. Try to REFUTE it against the real repo — is it actually true, or overstated/already-handled/a false positive?\n\nFINDING: ${f.title}\nSEVERITY: ${f.severity}\nAREA: ${f.area}\nEVIDENCE CLAIMED: ${f.evidence}\nWHY: ${f.whyItMatters || ''}\n${cwdHint}\n\nRead the cited code. Set real=false if the evidence does not hold up or the issue is already mitigated; set real=true with a tightened severity only if it genuinely stands. "why" must cite what you looked at.`,
        { label: `verify:${f.title.slice(0, 30)}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ),
    ),
  )
).filter(Boolean)
const verdictByTitle = new Map(verifiedHigh.map((v) => [v.title, v]))
// Keep: all sub-floor findings as-is + the HIGH+ ones that survived verification (with adjusted severity).
const survivors = [
  ...allFindings.filter((f) => (RANK[f.severity] || 0) < floor),
  ...toVerify
    .map((f) => ({ f, v: verdictByTitle.get(f.title) }))
    .filter(({ v }) => !v || v.real) // if a verdict is missing (agent died), keep rather than silently drop
    .map(({ f, v }) => ({ ...f, severity: (v && v.severityAdjusted) || f.severity })),
]
log(`verify: ${toVerify.length} HIGH+ checked, ${survivors.length} findings survive`)

// --- Phase 3: triage into a deduped, ranked backlog ---
phase('Triage')
const triaged = await agent(
  `Triage these verified codebase-audit findings into a clean backlog for the integrator to file. Findings: ${JSON.stringify(survivors)}\n\n` +
    `Dedupe (merge findings that are the same root issue across dimensions), re-rank by severity then leverage, and for each decide track: "task" (live board — do soon, blocks real capability) vs "issue" (tmp/issues backlog — debt to schedule). Note relatedTo when it belongs under an existing area (e.g. apps/web migration). Be concise and decision-ready; do not invent findings not present in the input.`,
  { label: 'triage', phase: 'Triage', agentType: 'architect', schema: TRIAGE_SCHEMA },
)

return {
  scope: SCOPE,
  dimensionsAudited: audits.map((a) => a.dimension),
  rawCount: allFindings.length,
  verifiedHighCount: toVerify.length,
  survivorCount: survivors.length,
  triaged,
  needsHumanGate: true,
  note: 'Read-only audit. Integrator: file triaged.items into Tasks (track=task) / tmp/issues (track=issue); skip dupes of existing tickets.',
}
