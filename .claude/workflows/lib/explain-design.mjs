// The per-checkpoint half of the design gate. `isValidDesignShape` answers yes/no, which is all
// the workflow needs; someone working inline in the main session needs to know WHICH checkpoint is
// missing so the design can be brought up to the same bar one field at a time.
//
// Each entry below is one checkpoint. Keeping them as data rather than a chain of `if`s is what
// makes the gate divisible: a caller can report all of them, or one, or filter to the ones a
// particular task actually touches.

const nonBlankList = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && /\S/.test(x))
// Kept identical to DESIGN_SCHEMA's `benefit` pattern by design-schema.test.mjs; spelled out here
// because this module deliberately does not import the schema (it is the inline-mode half).
const benefitClaim = /^(delta|relocation|elimination|obvious):\s*\S/

// A malformed value is named against the type the gate wanted: `scope` is one string while the
// fields around it are lists, and "malformed" alone sends a reader the wrong way.
const LIST = 'a non-empty list of strings, none blank'

const CHECKPOINTS = [
  {
    field: 'completionCriteria',
    ok: (d) => nonBlankList(d.completionCriteria),
    expects: LIST,
    supply: 'a list of observable criteria, each one a test could check',
  },
  {
    field: 'scope',
    ok: (d) => typeof d.scope === 'string',
    expects: 'a string',
    supply: 'the files you intend to edit',
  },
  {
    field: 'testScenarios.unit',
    ok: (d) =>
      !!d.testScenarios &&
      typeof d.testScenarios === 'object' &&
      nonBlankList(d.testScenarios.unit),
    expects: LIST,
    supply: 'at least one nearest-layer test scenario (see the test-layer-selection skill)',
  },
  {
    field: 'properties',
    ok: (d) => nonBlankList(d.properties),
    expects: LIST,
    supply: 'the invariants/round-trips this change must preserve, or one "none: <reason>" entry',
  },
  {
    field: 'blastRadius',
    ok: (d) => nonBlankList(d.blastRadius),
    expects: LIST,
    supply:
      'who else in the codebase this reaches and whether a test watches them, or one "none: <reason>" / "unavailable: <reason>" entry',
  },
  {
    field: 'userReach',
    ok: (d) => nonBlankList(d.userReach),
    expects: LIST,
    supply:
      'the entry point that makes this reachable by a user, or one "foundation: <reason> — wired by <named follow-up>" entry',
  },
  {
    field: 'benefit',
    ok: (d) => typeof d.benefit === 'string' && benefitClaim.test(d.benefit),
    expects: 'a string starting with "delta:", "relocation:", "elimination:" or "obvious:"',
    supply:
      'which kind of benefit this claims, prefixed with the column that decides the instrument — "delta: <the metric and the bench>", "relocation: <what the waited-on path stops doing, and what the handover costs>", "elimination: <the class of mistake, and what fails when it recurs>", or "obvious: <reason>" (see the measured-change skill)',
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
  for (const { field, ok, expects, supply } of CHECKPOINTS) {
    if (ok(design)) continue
    const raw = field.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), design)
    const state =
      raw === undefined ? 'missing' : `present but empty or malformed (expected ${expects})`
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
