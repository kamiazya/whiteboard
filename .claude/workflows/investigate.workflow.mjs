export const meta = {
  name: 'investigate',
  description:
    'Lightweight, read-only investigation of a repo-hygiene / policy / portability question: fan out one investigator per concern dimension (in parallel), then synthesize a go/no-go recommendation with a risk table and the fixes required before adopting. No edits — feeds a human decision.',
  whenToUse:
    'When a decision needs grounded evidence before committing to it (e.g. "should we track .claude/ in git", "is it safe to commit X", "what breaks for other contributors") but it is not worth a full plan-initiative. Pass args:{question, dimensions?, cwd?}. dimensions defaults to a repo-hygiene set. Read-only; returns a recommendation for the integrator to act on.',
  phases: [
    { title: 'Investigate', detail: 'one repo-hygiene-investigator per concern dimension, in parallel' },
    { title: 'Synthesize', detail: 'merge findings into a go/no-go recommendation + required pre-steps' },
  ],
}

// --- inputs (runtime delivers args as a JSON string) ---
const A = (() => {
  try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} }
})()
const QUESTION = A.question || ''
const CWD = A.cwd || null
const GIT = CWD ? `git -C ${CWD}` : 'git'
// Investigator agentType. IMPORTANT: a custom agent added mid-session (e.g. repo-hygiene-investigator)
// is NOT in the agentType registry until a session reload — agent({agentType}) throws "not found".
// So default to an always-registered, read-only agent (Explore: has Read/Grep/Glob/Bash, cannot Edit/Write),
// and let callers override to the tuned custom agent once it is loaded: args.investigatorAgent.
const INVESTIGATOR = A.investigatorAgent || 'Explore'
const cwdHint = CWD ? ` Investigate the repo under ${CWD} (run git as \`${GIT} ...\`, Read at that absolute path).` : ' Investigate the repo at the session root.'
// Default dimensions tuned for "should we track this dir in git" questions; override via args.
const DIMENSIONS = Array.isArray(A.dimensions) && A.dimensions.length
  ? A.dimensions
  : [
      'secret-leak — tokens/credentials/private endpoints that would become public',
      'machine-specific-paths — absolute paths, usernames, hardcoded ports, anything that breaks on another machine (workflow scripts composing via absolute scriptPath are a known landmine here)',
      'build-artifacts-and-heavy-dirs — what must STAY ignored even if the parent is tracked (worktrees, node_modules, logs, caches, transcripts)',
      'tooling-convention — Claude Code shared-vs-local split (settings.json vs settings.local.json), whether agents/skills/workflows are meant to be shared, what the tool expects',
      'contributor-portability — what breaks or surprises a fresh clone / a different contributor; hooks that assume local state',
      'history-churn-and-local-private-intent — frequently-rewritten local state that would create noise; content deliberately kept off the shared remote',
    ]

if (!QUESTION) {
  return { error: 'args.question is required' }
}

log(`investigate: "${QUESTION}" across ${DIMENSIONS.length} dimension(s)`)

// --- schemas ---
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          issue: { type: 'string' },
          evidence: { type: 'string', description: 'concrete: path:line, grep hit, git check-ignore result' },
          mitigation: { type: 'string', description: 'fix before adopting, or "inherent"' },
        },
        required: ['severity', 'issue', 'evidence'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['dimension', 'risks'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recommendation: { enum: ['adopt', 'adopt-with-changes', 'do-not-adopt'] },
    summary: { type: 'string' },
    requiredBeforeAdopting: { type: 'array', items: { type: 'string' }, description: 'ordered, concrete pre-steps' },
    proposedPolicy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        track: { type: 'array', items: { type: 'string' } },
        keepIgnored: { type: 'array', items: { type: 'string' } },
      },
    },
    residualRisks: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'anything needing a human call' },
  },
  required: ['recommendation', 'summary', 'requiredBeforeAdopting'],
}

// --- Phase 1: fan out one investigator per dimension ---
phase('Investigate')
const findings = (
  await parallel(
    DIMENSIONS.map((dim) => () =>
      agent(
        `Investigate this concern dimension of the following question.\n\nQUESTION: ${QUESTION}\n\nDIMENSION: ${dim}\n${cwdHint}\n\nGround every risk in concrete evidence (path:line, grep counts, \`${GIT} check-ignore -v\` / \`${GIT} ls-files\` output). Propose a mitigation per risk. Do not edit anything.`,
        { label: `investigate:${dim.split(' ')[0]}`, phase: 'Investigate', agentType: INVESTIGATOR, schema: FINDINGS_SCHEMA },
      ),
    ),
  )
).filter(Boolean)

// --- Phase 2: synthesize a single recommendation ---
phase('Synthesize')
const allRisks = findings.flatMap((f) => (f.risks || []).map((r) => ({ ...r, dimension: f.dimension })))
const synthesis = await agent(
  `Synthesize ONE grounded recommendation for this decision from the per-dimension investigation findings.\n\nQUESTION: ${QUESTION}\n\nFINDINGS (by dimension): ${JSON.stringify(findings)}\n\n` +
    `Weigh the risks honestly (a single CRITICAL secret-leak or every-contributor breakage dominates). If the only blockers are fixable (e.g. make a path repo-relative, move a value to settings.local.json, add a narrower ignore for worktrees/artifacts), recommend "adopt-with-changes" and list requiredBeforeAdopting as ordered, concrete steps. Propose a track/keepIgnored split. Surface anything needing a human call as openQuestions. Be concise and decision-ready.`,
  { label: 'synthesize', phase: 'Synthesize', agentType: 'architect', schema: SYNTH_SCHEMA },
)

return {
  question: QUESTION,
  dimensionsInvestigated: findings.map((f) => f.dimension),
  riskCount: allRisks.length,
  criticalOrHigh: allRisks.filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH'),
  findings,
  recommendation: synthesis,
  needsHumanGate: true,
  note: 'Read-only investigation. Integrator: surface the recommendation + requiredBeforeAdopting to the human before changing ignore rules.',
}
