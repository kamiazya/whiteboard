export const meta = {
  name: 'plan-initiative',
  description:
    'Multi-perspective planning for a large initiative: parallel expert panel (architect/security/ux/PM/product) -> synthesized sliced plan -> plan-reviewer + Codex gate -> visualize on the running local whiteboard. Returns the plan, canvas, and openQuestions for the main session to ask the human via AskUserQuestion.',
  whenToUse:
    'Before a large initiative (precedes dev-loop slices). Produces a vetted, sliced plan and a visual artifact on the local whiteboard for AI/human alignment. Pass args:{initiative, contextPaths?, depth?, visualize?, codex?, consult?, consultant?, research?, maxPlanRevisions?}. On a failed gate it auto-revises the plan up to maxPlanRevisions (default 1) before returning. The main session asks the returned openQuestions via AskUserQuestion; iterative consensus is an Agent Team (separate).',
  phases: [
    { title: 'Understand', detail: 'parallel readers build a shared brief from context' },
    { title: 'Panel', detail: 'architect / security / ux / PM / product (+ web research-analyst) in parallel' },
    { title: 'Synthesize', detail: 'merge into one sliced plan; extract human openQuestions' },
    { title: 'Gate', detail: 'plan-reviewer + Codex second opinion' },
    { title: 'Vet', detail: 'optionally consult-adversarial on load-bearing conflicts' },
    { title: 'Investigate', detail: 'optionally ground policy/hygiene/portability questions with evidence (investigate workflow)' },
    { title: 'Visualize', detail: 'lay the plan onto the running local whiteboard via MCP' },
  ],
}

// --- inputs (runtime delivers args as a JSON string) ---
const A = (() => {
  if (typeof args !== 'string') return args && typeof args === 'object' ? args : {}
  // Malformed args is a caller bug with no sane default. Falling back to {} does not stop the
  // run — it completes against empty inputs and reports "nothing was specified" after spending
  // the whole agent budget, which reads as a finding rather than the input error it is.
  try {
    return JSON.parse(args)
  } catch (err) {
    throw new Error(`args is not valid JSON (${err.message}): ${args.slice(0, 200)}`)
  }
})()
const INITIATIVE = A.initiative || ''
const CONTEXT_PATHS = Array.isArray(A.contextPaths) ? A.contextPaths : []
const DEPTH = A.depth === 'detailed' ? 'detailed' : 'concept'
const VISUALIZE = A.visualize !== false
const CODEX = A.codex !== false
// consult: adversarially vet the plan's load-bearing cross-perspective conflicts via the
// consult-adversarial workflow before returning (opt-in — expensive). consultant: agent|codex|panel.
const CONSULT = !!A.consult
const CONSULTANT = ['agent', 'codex', 'panel'].includes(A.consultant) ? A.consultant : 'panel'
// research: add a web-research panelist (best practices / prior art / standards / case studies).
// Default on; set research:false to skip (e.g. offline or purely-internal initiatives).
const RESEARCH = A.research !== false
// maxPlanRevisions: on a failed gate, re-synthesize addressing the must-fix and re-gate, up to N times.
const MAX_PLAN_REV = typeof A.maxPlanRevisions === 'number' ? A.maxPlanRevisions : 1
// investigateQuestions: optional policy/hygiene/portability questions to GROUND with evidence via the
// investigate workflow (e.g. "is it safe to track .claude/ in git?"). Each runs read-only at nesting
// depth 1 (investigate is a leaf workflow — no workflow() of its own). Off unless supplied.
const INVESTIGATE_QUESTIONS = Array.isArray(A.investigateQuestions) ? A.investigateQuestions.filter((q) => typeof q === 'string' && q) : []

if (!INITIATIVE) {
  return { error: 'no initiative supplied', plan: null }
}

// --- schemas ---
const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { source: { type: 'string' }, summary: { type: 'string' }, keyFacts: { type: 'array', items: { type: 'string' } } },
  required: ['summary'],
}
const PERSPECTIVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    perspective: { type: 'string' },
    analysis: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['perspective', 'analysis', 'recommendations'],
}
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    goal: { type: 'string' },
    slices: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          scope: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          risk: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
          parallelizable: { type: 'boolean' },
        },
        required: ['title', 'scope', 'risk'],
      },
    },
    sequencing: { type: 'string' },
    crossPerspectiveConflicts: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'slices', 'openQuestions'],
}
const PLAN_VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { pass: { type: 'boolean' }, mustFix: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
  required: ['pass', 'rationale'],
}
const VISUAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    canvasUrl: { type: 'string' },
    layoutMap: { type: 'string', description: 'what was placed where, so reviewers can navigate' },
    friction: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] } },
  },
  required: ['layoutMap'],
}

// --- Phase 1: Understand (parallel readers over context) ---
phase('Understand')
const briefs = CONTEXT_PATHS.length
  ? (await parallel(
      CONTEXT_PATHS.map((p) => () =>
        agent(`Read ${p} and extract what a planner needs for this initiative: "${INITIATIVE}". Summarize the relevant design/constraints/contracts.`,
          { label: `understand:${p.split('/').pop()}`, phase: 'Understand', agentType: 'Explore', schema: BRIEF_SCHEMA }),
      ),
    )).filter(Boolean)
  : []
const briefText = briefs.length ? briefs.map((b) => `- ${b.source || ''}: ${b.summary}`).join('\n') : '(no context paths supplied; read the repo as needed)'

// --- Phase 2: Panel (parallel expert perspectives) ---
const PANEL = [
  'architect',
  'security-architect',
  'ux-designer',
  'project-manager',
  'product-manager',
  ...(RESEARCH ? ['research-analyst'] : []),
]
const panel = (
  await parallel(
    PANEL.map((role) => () =>
      agent(
        `Initiative: ${INITIATIVE}\n\nShared brief:\n${briefText}\n\nProvide your perspective's analysis, recommendations, risks, and openQuestions (decisions that are the human's to make).`,
        { label: `panel:${role}`, phase: 'Panel', agentType: role, schema: PERSPECTIVE_SCHEMA },
      ),
    ),
  )
).filter(Boolean)

// --- Phase 3: Synthesize ---
phase('Synthesize')
let plan = await agent(
  `Synthesize ONE coherent, sliced implementation plan for this initiative from the expert panel. Initiative: ${INITIATIVE}\n\nPanel:\n${JSON.stringify(panel)}\n\nProduce: goal; ordered slices (each ONE acceptance boundary / ~one write scope, with dependsOn, risk, parallelizable) so each can run as a dev-loop task; sequencing; crossPerspectiveConflicts you resolved or that remain; and openQuestions the human must decide (merge/dedupe the panel's). Prefer small safe increments.`,
  { label: 'synthesize', phase: 'Synthesize', agentType: 'architect', schema: PLAN_SCHEMA },
)

// --- Phase 4: Gate (plan-reviewer + Codex), with auto-revise on failure ---
phase('Gate')
const runGate = async (pl) => {
  const [mineV, codexV] = await Promise.all([
    agent(`Review this initiative plan for completeness before slicing into dev-loops. Plan: ${JSON.stringify(pl)}. Fail with mustFix if slices aren't single-scope, dependencies/risks are missing, fixture/test paths or assertions would break, or high-risk angles are unaddressed.`,
      { label: 'gate:plan-reviewer', phase: 'Gate', agentType: 'plan-reviewer', schema: PLAN_VERDICT_SCHEMA }),
    CODEX
      ? agent(`Independently review this initiative plan as a gate. Plan: ${JSON.stringify(pl)}. Read the repo to check assumptions; flag scope/sequencing/risk/assumption problems; fail with concrete mustFix if it should not proceed.`,
          { label: 'gate:codex', phase: 'Gate', agentType: 'codex:codex-rescue', schema: PLAN_VERDICT_SCHEMA })
      : Promise.resolve(null),
  ])
  return {
    pass: !!(mineV && mineV.pass) && (codexV ? codexV.pass : true),
    mustFix: [...((mineV && mineV.mustFix) || []), ...((codexV && codexV.mustFix) || [])],
    reviewer: mineV,
    codex: codexV,
  }
}
let gate = await runGate(plan)
let planRev = 0
while (!gate.pass && planRev < MAX_PLAN_REV) {
  planRev += 1
  log(`plan gate failed (revise ${planRev}/${MAX_PLAN_REV}): ${gate.mustFix.length} must-fix`)
  phase('Synthesize')
  plan = await agent(
    `Revise this initiative plan to resolve the must-fix items, keeping the same schema and the same slice structure where sound. Initiative: ${INITIATIVE}\nPlan: ${JSON.stringify(plan)}\nMust-fix: ${JSON.stringify(gate.mustFix)}\n\nApply each correction concretely (e.g. name the test project per slice, update both fixture paths AND assertions, add missing dependency edges, fix wrong link claims). Do not drop slices unless a must-fix says to.`,
    { label: `synthesize:revise-${planRev}`, phase: 'Synthesize', agentType: 'architect', schema: PLAN_SCHEMA },
  )
  phase('Gate')
  gate = await runGate(plan)
}
gate.revisions = planRev

// --- Phase 4.5 (optional): adversarially vet the plan's load-bearing technical conflicts ---
// consult-adversarial is a leaf workflow (no workflow() of its own), so this stays at nesting depth 1.
const consults = []
if (CONSULT && plan && Array.isArray(plan.crossPerspectiveConflicts) && plan.crossPerspectiveConflicts.length) {
  phase('Vet')
  for (const conflict of plan.crossPerspectiveConflicts.slice(0, 2)) {
    const r = await workflow(
      { scriptPath: '.claude/workflows/consult-adversarial.workflow.mjs' },
      { question: `Resolve this design conflict for the initiative "${INITIATIVE}": ${conflict}`, consultant: CONSULTANT, codex: CODEX, maxRounds: 2 },
    )
    if (r) consults.push({ conflict, vetted: r })
  }
}

// --- Phase 4.6 (optional): ground policy/hygiene/portability questions with evidence ---
// investigate is a leaf workflow (parallel investigators + synth, no workflow() of its own), so this
// stays at nesting depth 1 — same constraint as the consult hook above.
const investigations = []
if (INVESTIGATE_QUESTIONS.length) {
  phase('Investigate')
  for (const q of INVESTIGATE_QUESTIONS.slice(0, 3)) {
    const r = await workflow(
      { scriptPath: '.claude/workflows/investigate.workflow.mjs' },
      { question: q },
    )
    if (r) investigations.push({ question: q, result: r })
  }
}

// --- Phase 5: Visualize on the running local whiteboard ---
let visual = null
if (VISUALIZE) {
  phase('Visualize')
  visual = await agent(
    `Visualize this plan on the running local whiteboard via its MCP tools, depth=${DEPTH}. Plan: ${JSON.stringify(plan)}\n` +
      `Lay out frames per phase/slice, sticky notes per decision/risk/open-question, arrows for dependencies (and UI mockups if depth=detailed). Make it readable for AI + human alignment. Dogfood as you go: report any friction or bugs you hit. Return the canvas URL, a layoutMap, and friction.`,
    { label: 'visualize', phase: 'Visualize', agentType: 'whiteboard-designer', schema: VISUAL_SCHEMA },
  )
}

return {
  initiative: INITIATIVE,
  brief: briefs,
  panel,
  plan,
  gate,
  consults,
  investigations,
  visual,
  // The main session asks these via AskUserQuestion, then re-runs synthesis / drives the Agent Team consensus loop.
  openQuestions: (plan && plan.openQuestions) || [],
  note: 'Plan + visual artifact ready. Main session: ask openQuestions via AskUserQuestion; iterate consensus on the canvas via an Agent Team; then run dev-loop per slice and reconcile.',
}
