export const meta = {
  name: 'dogfood-triage',
  description:
    'Persona-driven exploratory dogfooding of the whole running product via real browser, then triage friction into dedup-aware, classified, verified findings for tmp/issues',
  whenToUse:
    'Periodically or pre-release, to find real user friction (not diff-scoped). Requires the web app + MCP daemon already running. Pass args:{personaCount?, appUrl?, existingIssues?, theme?}.',
  phases: [
    { title: 'Personas', detail: 'invent diverse user personas + their jobs-to-be-done' },
    { title: 'Dogfood', detail: 'each persona drives the real browser end-to-end (sequential — browser is a shared singleton)' },
    { title: 'Triage', detail: 'dedup vs existing issues, classify, adversarially verify bug claims' },
  ],
}

// --- inputs ---
// The runtime delivers `args` as a JSON *string* (not an object), so normalize first.
const A = (() => {
  try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} }
})()
const PERSONA_COUNT = A.personaCount || 3
const APP_URL = A.appUrl || 'http://localhost:5173'
// existingIssues: array of short titles/slugs already tracked under tmp/issues, for dedup.
const EXISTING = Array.isArray(A.existingIssues) ? A.existingIssues : []
// theme: optional nudge so successive runs explore different angles (e.g. 'mobile', 'first-run', 'power-user').
const THEME = A.theme || 'a broad mix of first-time and returning users'

// --- schemas ---
const PERSONAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          context: { type: 'string', description: 'who they are, device, expertise' },
          goal: { type: 'string', description: 'the concrete job they came to do' },
          successLooksLike: { type: 'string' },
        },
        required: ['name', 'context', 'goal', 'successLooksLike'],
      },
    },
  },
  required: ['personas'],
}

const FRICTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goalAchieved: { enum: ['yes', 'partial', 'no'] },
    summary: { type: 'string', description: 'narrative of what the persona did and where it broke down' },
    friction: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { enum: ['bug', 'missing-affordance', 'confusing', 'slow', 'dead-end'] },
          severity: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
          title: { type: 'string' },
          where: { type: 'string', description: 'screen / control / URL where it happened' },
          detail: { type: 'string', description: 'what the user expected vs what happened, repro steps' },
        },
        required: ['kind', 'severity', 'title', 'detail'],
      },
    },
  },
  required: ['goalAchieved', 'summary', 'friction'],
}

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isDuplicate: { type: 'boolean' },
    duplicateOf: { type: 'string' },
    verifiedReal: { type: 'boolean', description: 'for bug-kind: confirmed reproducible; for non-bug: is it a genuine UX gap' },
    severity: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
    disposition: { enum: ['fix-now', 'backlog', 'wont-fix'] },
    rationale: { type: 'string' },
    issueSlug: { type: 'string', description: 'kebab-case slug for the tmp/issues note if kept' },
  },
  required: ['isDuplicate', 'verifiedReal', 'severity', 'disposition', 'rationale'],
}

// --- Phase 1: personas ---
phase('Personas')
const personaResult = await agent(
  `Invent ${PERSONA_COUNT} distinct, realistic user personas for a collaborative whiteboard product, spanning ${THEME}. Each must have a different job-to-be-done and a different entry context (device, expertise, motivation). Avoid generic personas — make their goals concrete enough to attempt in a real session. EXACTLY ONE persona must be a feature-mixer whose job forces composing features on a single canvas: groups containing nodes AND edges between the members, a non-default edge routing style, multi-node selection dragged from different members, and in-place text editing — the recurring defect class lives at these pairwise intersections, which single-feature personas never reach. Do NOT open a browser; just design the personas.`,
  { label: 'personas', phase: 'Personas', schema: PERSONAS_SCHEMA },
)
const personas = (personaResult && personaResult.personas) || []
log(`Generated ${personas.length} personas`)

// --- Phase 2: dogfood (SEQUENTIAL — the browser MCP is a shared singleton, parallel drivers collide) ---
const runs = []
for (let i = 0; i < personas.length; i++) {
  const p = personas[i]
  log(`Dogfooding persona ${i + 1}/${personas.length}: ${p.name}`)
  const run = await agent(
    `You are this user, not a tester:\n- Name: ${p.name}\n- Context: ${p.context}\n- Goal: ${p.goal}\n- Success looks like: ${p.successLooksLike}\n\n` +
      `Drive the REAL running app at ${APP_URL} using the Playwright MCP browser tools (navigate, snapshot, click, type, etc.). Pursue YOUR goal end-to-end as this persona would, touching whatever parts of the product you need. ` +
      `Stay in character: when something is confusing, missing, slow, or broken, note it as the user would feel it. Capture concrete friction with repro steps and where it happened. ` +
      `Be efficient: a handful of meaningful steps toward the goal, not exhaustive crawling. If you hit a hard block, record it and stop. Report whether you achieved the goal and the friction you hit.`,
    { label: `dogfood:${p.name}`, phase: 'Dogfood', agentType: 'dogfood-persona', schema: FRICTION_SCHEMA },
  )
  if (run) runs.push({ persona: p, ...run })
}

// flatten friction with persona attribution
const allFriction = runs.flatMap((r) =>
  (r.friction || []).map((f) => ({ ...f, persona: r.persona.name, goalAchieved: r.goalAchieved })),
)
log(`Collected ${allFriction.length} friction items across ${runs.length} runs`)

// --- Phase 3: triage (parallel; dedup vs existing issues + verify bug claims) ---
const existingList = EXISTING.length ? EXISTING.join('\n- ') : '(none provided)'
const triaged = (
  await parallel(
    allFriction.map((f) => () =>
      agent(
        `Triage this dogfooding friction item for the whiteboard product.\n` +
          `Item: [${f.kind} / ${f.severity}] ${f.title}\nWhere: ${f.where || 'n/a'}\nDetail: ${f.detail}\nReported by persona: ${f.persona}\n\n` +
          `Existing tracked issues (dedup against these):\n- ${existingList}\n\n` +
          `Steps: (1) decide if it duplicates an existing issue. (2) If kind=bug, adversarially verify it is genuinely reproducible from the code/app — default verifiedReal=false if you cannot substantiate it; you may inspect the repo. For non-bug UX gaps, judge whether it is a real gap worth tracking. (3) Assign a final severity and a disposition (fix-now / backlog / wont-fix) with a one-line rationale, and a kebab-case issueSlug if kept.`,
        { label: `triage:${(f.title || '').slice(0, 30)}`, phase: 'Triage', schema: TRIAGE_SCHEMA },
      ).then((t) => ({ ...f, triage: t })),
    ),
  )
).filter(Boolean)

const keep = triaged.filter((f) => f.triage && !f.triage.isDuplicate && f.triage.verifiedReal && f.triage.disposition !== 'wont-fix')
const fixNow = keep.filter((f) => f.triage.disposition === 'fix-now')

return {
  appUrl: APP_URL,
  personas: personas.map((p) => ({ name: p.name, goal: p.goal })),
  runs: runs.map((r) => ({ persona: r.persona.name, goalAchieved: r.goalAchieved, summary: r.summary })),
  summary: {
    totalFriction: allFriction.length,
    kept: keep.length,
    fixNow: fixNow.length,
    duplicates: triaged.filter((f) => f.triage && f.triage.isDuplicate).length,
  },
  // sorted: fix-now first, then by severity
  findings: keep
    .map((f) => ({
      title: f.title,
      kind: f.kind,
      severity: f.triage.severity,
      disposition: f.triage.disposition,
      persona: f.persona,
      where: f.where,
      detail: f.detail,
      rationale: f.triage.rationale,
      issueSlug: f.triage.issueSlug,
    }))
    .sort((a, b) => (a.disposition === 'fix-now' ? -1 : 1)),
}
