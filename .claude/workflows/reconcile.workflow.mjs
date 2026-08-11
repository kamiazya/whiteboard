export const meta = {
  name: 'reconcile',
  description:
    'Pre-merge reconciliation for parallel in-flight branches: detect textual + semantic/intent conflicts against the integration tip and each other, then propose a conflict-minimizing serial merge plan. Detection/judgement only — the integrator (main session) performs the actual fold + single push.',
  whenToUse:
    'When several dev-loop branches converge and the single integrator needs to fold them without textual or intent conflicts. Pass args:{integrationTip, branches:[{name, ref, designDoc?, summary?}], cwd?}.',
  phases: [
    { title: 'Detect', detail: 'textual conflict (git merge-tree) + overlapping files/symbols vs the integration tip' },
    { title: 'IntentAlign', detail: 'semantic/intent conflict of each branch vs the tip and the other branches' },
    { title: 'Order', detail: 'propose a conflict-minimizing serial merge plan' },
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
const TIP = A.integrationTip || 'HEAD'
const BRANCHES = Array.isArray(A.branches) ? A.branches : []
const CWD = A.cwd || null
const GIT = CWD ? `git -C ${CWD}` : 'git'
const cwdHint = CWD ? ` Run git as \`${GIT} ...\` (repo/worktree at ${CWD}).` : ''

if (BRANCHES.length === 0) {
  return { error: 'no branches supplied', integrationTip: TIP, mergePlan: null }
}

// --- schemas ---
const CONFLICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branch: { type: 'string' },
    mergesCleanly: { type: 'boolean' },
    textualConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { file: { type: 'string' }, note: { type: 'string' } },
        required: ['file'],
      },
    },
    changedFiles: { type: 'array', items: { type: 'string' } },
    changedSymbols: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'mergesCleanly', 'textualConflicts', 'changedFiles'],
}

const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branch: { type: 'string' },
    compatible: { type: 'boolean' },
    semanticConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          with: { type: 'string', description: 'the integration tip or another branch name' },
          severity: { enum: ['HIGH', 'MEDIUM', 'LOW'] },
          description: { type: 'string', description: 'the conflicting intent/invariant/assumption' },
        },
        required: ['with', 'severity', 'description'],
      },
    },
    resolution: { type: 'string', description: 'how to reconcile, or empty if none needed' },
  },
  required: ['branch', 'compatible', 'semanticConflicts'],
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    order: { type: 'array', items: { type: 'string' }, description: 'branch names in recommended merge order' },
    perBranch: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          branch: { type: 'string' },
          action: { enum: ['merge', 'rebase-then-merge', 'send-back', 'hold'] },
          reason: { type: 'string' },
          resolution: { type: 'string' },
        },
        required: ['branch', 'action', 'reason'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['order', 'perBranch'],
}

const branchList = BRANCHES.map((b) => `${b.name} (ref ${b.ref})`).join(', ')

// --- Phase 1: detect textual conflicts + change surface (parallel; barrier — Order needs all) ---
const conflicts = (
  await parallel(
    BRANCHES.map((b) => () =>
      agent(
        `Detect how branch "${b.name}" (ref ${b.ref}) would merge into the integration tip ${TIP}.${cwdHint}\n` +
          `Use a non-destructive 3-way check: \`${GIT} merge-tree --write-tree ${TIP} ${b.ref}\` (modern git lists conflicted files and exits non-zero on conflict; if unavailable, fall back to \`${GIT} merge-base ${TIP} ${b.ref}\` + \`${GIT} merge-tree <base> ${TIP} ${b.ref}\` and look for <<<<<<< markers). Also list the files this branch changes vs the merge base (\`${GIT} diff --name-only $(${GIT} merge-base ${TIP} ${b.ref})..${b.ref}\`) and, by reading those diffs, the notable functions/types/exports it touches (changedSymbols). Do NOT modify the working tree or create commits.`,
        { label: `detect:${b.name}`, phase: 'Detect', schema: CONFLICT_SCHEMA },
      ),
    ),
  )
).filter(Boolean)

// Cross-branch file overlap: branches off the same tip each merge cleanly vs the tip, but
// folding them serially can still collide. Surface files touched by >1 branch for Order.
const fileOwners = {}
conflicts.forEach((c) => (c.changedFiles || []).forEach((f) => { (fileOwners[f] ||= []).push(c.branch) }))
const overlaps = Object.entries(fileOwners)
  .filter(([, bs]) => bs.length > 1)
  .map(([file, branches]) => ({ file, branches }))

// --- Phase 2: intent alignment (parallel; each agent gets all-branch context + its own conflict report) ---
const intents = (
  await parallel(
    BRANCHES.map((b) => () => {
      const myConflict = conflicts.find((c) => c.branch === b.name) || null
      const others = BRANCHES.filter((x) => x.name !== b.name)
        .map((x) => `- ${x.name}: ${x.summary || x.designDoc || '(no summary)'}`)
        .join('\n')
      return agent(
        `Judge whether branch "${b.name}" is INTENT-compatible with the integration tip ${TIP} and the other in-flight branches.${cwdHint}\n` +
          `This branch's intent/design: ${b.summary || b.designDoc || '(none provided — infer from its diff)'}\n` +
          `Read its diff: \`${GIT} diff $(${GIT} merge-base ${TIP} ${b.ref})..${b.ref}\`.\n` +
          `Textual-merge result for this branch: ${myConflict ? JSON.stringify({ mergesCleanly: myConflict.mergesCleanly, changedFiles: myConflict.changedFiles, changedSymbols: myConflict.changedSymbols }) : '(unknown)'}\n` +
          `Other in-flight branches:\n${others || '(none)'}\n\n` +
          `Look beyond textual conflicts: even if it merges cleanly, do two branches implement the SAME invariant twice, assume contradictory contracts/data-models (e.g. one migrates a type, the other still assumes the old shape), or drift an API/schema the other depends on? Report semanticConflicts (with whom, severity, the conflicting assumption) and a resolution.`,
        { label: `intent:${b.name}`, phase: 'IntentAlign', schema: INTENT_SCHEMA },
      )
    }),
  )
).filter(Boolean)

// --- Phase 3: order (single agent synthesizes a serial merge plan) ---
const plan = await agent(
  `Produce a conflict-minimizing SERIAL merge plan for the integrator to fold these branches into ${TIP} under single-push discipline.\n` +
    `Branches: ${branchList}\n` +
    `Textual detection (each branch vs tip): ${JSON.stringify(conflicts)}\n` +
    `Cross-branch file overlap (files touched by >1 branch — likely serial-fold collisions): ${JSON.stringify(overlaps)}\n` +
    `Intent alignment: ${JSON.stringify(intents)}\n\n` +
    `Rules: branches that touch disjoint files and are intent-compatible can merge in any order. When two branches overlap files OR have a semantic conflict, pick an order (or rebase) that minimizes rework, and prefer merging the foundational/contract change first. A branch with an unresolved HIGH semantic conflict or a hard textual conflict gets action=send-back (return to its dev-loop) or hold, with a concrete reason. Output the recommended order and a per-branch action+resolution.`,
  { label: 'order', phase: 'Order', schema: PLAN_SCHEMA },
)

return {
  integrationTip: TIP,
  branches: BRANCHES.map((b) => b.name),
  conflicts,
  overlaps,
  intents,
  mergePlan: plan,
  note: 'Detection/judgement only. The integrator performs the actual fold + single push, applying mergePlan.order and per-branch actions; send-back/hold items return to their dev-loop.',
}
