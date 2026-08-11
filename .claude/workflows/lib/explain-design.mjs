// The per-checkpoint half of the design gate. `isValidDesignShape` answers yes/no, which is all
// the workflow needs; someone working inline in the main session needs to know WHICH checkpoint is
// missing so the design can be brought up to the same bar one field at a time.
//
// Each entry below is one checkpoint. Keeping them as data rather than a chain of `if`s is what
// makes the gate divisible: a caller can report all of them, or one, or filter to the ones a
// particular task actually touches.

const nonBlankList = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && /\S/.test(x))
const stringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')

const CHECKPOINTS = [
  {
    field: 'completionCriteria',
    ok: (d) => stringList(d.completionCriteria) && d.completionCriteria !== undefined,
    supply: 'a list of observable criteria, each one a test could check',
  },
  {
    field: 'scope',
    ok: (d) => typeof d.scope === 'string',
    supply: 'the files you intend to edit',
  },
  {
    field: 'testScenarios.unit',
    ok: (d) => !!d.testScenarios && typeof d.testScenarios === 'object' && stringList(d.testScenarios.unit) && d.testScenarios.unit !== undefined,
    supply: 'at least one nearest-layer test scenario (see the test-layer-selection skill)',
  },
  {
    field: 'properties',
    ok: (d) => nonBlankList(d.properties),
    supply: 'the invariants/round-trips this change must preserve, or one "none: <reason>" entry',
  },
  {
    field: 'blastRadius',
    ok: (d) => nonBlankList(d.blastRadius),
    supply:
      'who else in the codebase this reaches and whether a test watches them, or one "none: <reason>" / "unavailable: <reason>" entry',
  },
  {
    field: 'userReach',
    ok: (d) => nonBlankList(d.userReach),
    supply:
      'the entry point that makes this reachable by a user, or one "foundation: <reason> — wired by <named follow-up>" entry',
  },
]

/**
 * List what a design is still missing, one checkpoint per entry. Empty means it clears the same
 * bar the workflow's PlanReview gate enforces.
 *
 * @param {unknown} design
 * @returns {string[]}
 */
export function explainDesignShape(design) {
  if (!design || typeof design !== 'object' || Array.isArray(design)) {
    return ['design: supply a design object with the checkpoint fields (see DESIGN_SCHEMA)']
  }
  const problems = []
  for (const { field, ok, supply } of CHECKPOINTS) {
    if (ok(design)) continue
    const raw = field.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), design)
    const state = raw === undefined ? 'missing' : 'present but empty or malformed'
    problems.push(`${field}: ${state} — supply ${supply}`)
  }
  return problems
}

/**
 * Decide whether a run should stop and hand the design back to the main session instead of
 * implementing it.
 *
 * The pipeline's `developer` agent has Read/Edit/Write/Bash/Glob/Grep and no browser, so it cannot
 * perform AGENTS.md step 3 — it can only report the debt afterwards, which is what an observed run
 * did after spending its whole budget. When the design itself says the change needs looking at in
 * a running app, the cheapest moment to switch execution mode is here: the design is already
 * written and reviewed, so the main session resumes from an approved plan rather than restarting.
 *
 * Fail-safe by construction: an absent or blank answer preserves the previous behaviour rather
 * than halting runs whose designs predate the field. `dogfood: true` means the caller already
 * arranged a live browser lane, so the verification has somewhere to happen inside the run.
 *
 * @param {{manualVerification?: unknown, dogfood?: boolean}} input
 * @returns {{handBack: boolean, recommendation: string}}
 */
export function shouldHandBackForLiveVerification({ manualVerification, dogfood }) {
  const answer = typeof manualVerification === 'string' ? manualVerification.trim() : ''
  if (answer === '' || answer.startsWith('none:') || dogfood) {
    return { handBack: false, recommendation: '' }
  }
  return {
    handBack: true,
    recommendation:
      `This change needs verifying in a running app (${answer}), which no pipeline agent can do. ` +
      'Recommend implementing it from the main session, which has the browser tools, then running ' +
      'review.workflow.mjs over the resulting diff for the independent dimensions and QA. ' +
      'Re-run this dev-loop with dogfood:true + appUrl instead if a persona pass is enough.',
  }
}
