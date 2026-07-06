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
const RAW_DIMENSIONS = Array.isArray(A.dimensions) && A.dimensions.length
  ? A.dimensions
  : [
      'wiring-gaps — features that build/typecheck but do not actually function (placeholder/stub renders, _-prefixed-but-load-bearing values, TODO/FIXME/not-implemented, UI with no backend, backend with no caller, dead routes). The "looks done, isn\'t" class.',
      'architecture — leaky/violated seams, browser importing server internals, god modules, circular deps, a contract defined in two places, abstractions that do not pay for themselves.',
      'maintainability — files >800 lines, deep nesting, duplication, dead code, lying comments, mutation where immutability is the rule.',
      'contract-drift — hand-written TS interface paralleling a Zod schema, casts around process boundaries (as unknown/as any), persisted JSON parsed without a schema, client/server response shapes typed separately.',
      'test-gaps — critical paths with no nearest-layer test, .skip/xfail/todo tests, browser-only behavior covered only in jsdom, a contract with no conformance test.',
      'dev-experience — broken/incorrect setup steps, scripts that fail on a clean clone, flaky local services, missing/stale docs for a real workflow, new-contributor friction.',
    ]
// Normalize each dimension to {name, content}. Legacy callers pass a plain descriptive
// string (criteria stays embedded in the codebase-auditor agent); newer callers pass
// {name, content} where content is the authoritative externalized criteria (see the
// audit-triage skill's resources/*.md) injected straight into the auditor prompt.
const DIMENSIONS = RAW_DIMENSIONS.map((d) =>
  typeof d === 'string' ? { name: d.split(' ')[0], content: null, label: d } : { name: d.name, content: d.content || null, label: d.name },
)

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
  properties: {
    dimension: { type: 'string' },
    findings: { type: 'array', items: FINDING },
    notApplicable: { type: 'boolean', description: 'set true when this dimension cannot meaningfully apply to the scope; findings stays [] unless something was still found' },
  },
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
const auditResults = await parallel(
  DIMENSIONS.map((dim) => () =>
    agent(
      `Audit ${SCOPE} for STANDING health problems in this ONE dimension.\n\nDIMENSION: ${dim.label}\n` +
        (dim.content ? `\nAUTHORITATIVE CRITERIA (use this, not your own judgement of what the dimension means):\n${dim.content}\n` : '') +
        `${cwdHint}\n\nReturn evidence-grounded findings worth a ticket (path:line / grep). Severity honestly — precision over recall, no inflation; return an empty list if the dimension is clean in scope. If this dimension cannot meaningfully apply to ${SCOPE}, set notApplicable:true with findings:[]. Each finding needs a task-ready title, area, evidence, whyItMatters, suggestedAction, effort.`,
      { label: `audit:${dim.name}`, phase: 'Audit', agentType: AUDITOR, schema: FINDINGS_SCHEMA },
    ),
  ),
)
// Index-aligned over the NORMALIZED requested dimension list — never partition off the
// agent-returned `dimension` field (a drifted/rephrased label must not silently swap which
// dimension counts as audited).
const failedDimensions = []
const notApplicable = []
const coverageAdvisories = []
const dimensionsAudited = []
const allFindings = []
DIMENSIONS.forEach((dim, i) => {
  const result = auditResults[i]
  if (!result) {
    failedDimensions.push(dim.name)
    coverageAdvisories.push({
      severity: 'LOW',
      title: `dimension not audited — agent failed: ${dim.name}`,
      kind: 'coverage-gap',
      area: dim.name,
      dimension: dim.name,
      evidence: 'audit agent returned no result',
      whyItMatters: 'a silently skipped dimension looks like a clean pass when it never ran',
      suggestedAction: `re-run the ${dim.name} audit dimension individually`,
    })
    return
  }
  const hasFindings = Array.isArray(result.findings) && result.findings.length > 0
  if (result.notApplicable && !hasFindings) {
    notApplicable.push(dim.name)
    return
  }
  if (result.notApplicable && hasFindings) {
    // Inconsistent payload: findings win (the dimension clearly did apply), but flag it.
    coverageAdvisories.push({
      severity: 'LOW',
      title: `dimension reported notApplicable with non-empty findings: ${dim.name}`,
      kind: 'coverage-gap',
      area: dim.name,
      dimension: dim.name,
      evidence: 'agent returned notApplicable:true alongside findings',
      whyItMatters: 'the two signals disagree — treated as audited since findings were produced',
      suggestedAction: 'clarify the auditor prompt or re-run to confirm applicability',
    })
  }
  dimensionsAudited.push(dim.name)
  ;(result.findings || []).forEach((f) => allFindings.push({ ...f, dimension: dim.name }))
})
coverageAdvisories.forEach((f) => allFindings.push(f))
log(`audit: ${allFindings.length} raw findings across ${dimensionsAudited.length} dimensions (${failedDimensions.length} failed, ${notApplicable.length} not applicable)`)

// --- Phase 2: adversarially verify HIGH+ findings (kill false positives) ---
phase('Verify')
const floor = RANK[VERIFY_FLOOR] || RANK.HIGH
// Synthetic coverage-gap advisories are process facts (an agent failed / a dimension
// doesn't apply), not refutable claims about the codebase — never send them to adversarial
// verify, even when verifyFloor is lowered to LOW.
const toVerify = allFindings.filter((f) => f.kind !== 'coverage-gap' && (RANK[f.severity] || 0) >= floor)
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
// Keep: all sub-floor findings as-is + coverage-gap advisories (never filtered by floor) +
// the HIGH+ ones that survived verification (with adjusted severity).
const survivors = [
  ...allFindings.filter((f) => f.kind === 'coverage-gap' || (RANK[f.severity] || 0) < floor),
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
  dimensionsAudited,
  failedDimensions,
  notApplicable,
  rawCount: allFindings.length,
  verifiedHighCount: toVerify.length,
  survivorCount: survivors.length,
  triaged,
  needsHumanGate: true,
  note: 'Read-only audit. Integrator: file triaged.items into Tasks (track=task) / tmp/issues (track=issue); skip dupes of existing tickets. Check failedDimensions before trusting a clean run — it lists dimensions whose auditor agent produced no result.',
}
