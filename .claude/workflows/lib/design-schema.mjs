// Extracted so it can be unit-tested with node:test (see design-schema.test.mjs) without pulling
// in the workflow-runtime globals (`args`, `agent`, `workflow`, ...) that dev-loop.workflow.mjs
// only has when actually run inside a workflow.
export const DESIGN_SCHEMA = {
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

// Reuses the schema's own item pattern (rather than a second hand-picked regex) so a caller-
// provided designDoc that bypasses the schema-constrained `agent()` call is held to the exact
// same non-blank-entry invariant as an agent-generated design.
const propertiesItemPattern = new RegExp(DESIGN_SCHEMA.properties.properties.items.pattern)

// Kept in lockstep with DESIGN_SCHEMA's `additionalProperties: false` at both the top level and
// inside `testScenarios` — isValidDesignShape below must reject any key outside these lists or a
// caller-provided designDoc could carry fields the schema-constrained agent() path can never
// produce.
const ALLOWED_TOP_LEVEL_KEYS = ['completionCriteria', 'scope', 'contractChanges', 'testScenarios', 'risks', 'properties']
const ALLOWED_TEST_SCENARIO_KEYS = ['unit', 'browser', 'e2e']

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

// Guards a caller-provided `designDoc` against the same shape DESIGN_SCHEMA enforces on a
// generated design, so a malformed/incomplete args.designDoc can't skip PlanReview's invariant
// check by never passing through the schema-constrained agent() call in the first place. Checks
// every field DESIGN_SCHEMA constrains (types, additionalProperties:false at both levels), not
// just the four required ones, otherwise a caller-supplied document can carry schema-violating
// values (wrong-typed optional fields, unknown keys) straight into PlanReview and implementation.
export function isValidDesignShape(d) {
  if (!d || typeof d !== 'object') return false
  if (!Object.keys(d).every((k) => ALLOWED_TOP_LEVEL_KEYS.includes(k))) return false
  if (!Array.isArray(d.completionCriteria) || !d.completionCriteria.every((c) => typeof c === 'string')) return false
  if (typeof d.scope !== 'string') return false
  if (d.contractChanges !== undefined && typeof d.contractChanges !== 'string') return false
  if (!d.testScenarios || typeof d.testScenarios !== 'object') return false
  if (!Object.keys(d.testScenarios).every((k) => ALLOWED_TEST_SCENARIO_KEYS.includes(k))) return false
  if (!isStringArray(d.testScenarios.unit)) return false
  if (d.testScenarios.browser !== undefined && !isStringArray(d.testScenarios.browser)) return false
  if (d.testScenarios.e2e !== undefined && !isStringArray(d.testScenarios.e2e)) return false
  if (d.risks !== undefined && !isStringArray(d.risks)) return false
  if (!Array.isArray(d.properties) || d.properties.length < 1) return false
  if (!d.properties.every((p) => typeof p === 'string' && propertiesItemPattern.test(p))) return false
  return true
}

// Gates dev-loop's design-generation phase. `skipDesign` means "skip generation because a valid
// design was already provided" — NOT "skip generation even after we just discarded that provided
// design as invalid". Without `discardedInvalidProvidedDesign` in the OR, an invalid designDoc
// passed alongside skipDesign:true would leave `design` null forever, silently skipping both
// design and PlanReview instead of falling back to a freshly generated design.
export function shouldGenerateDesign({ hasDesign, skipDesign, discardedInvalidProvidedDesign }) {
  if (hasDesign) return false
  return !skipDesign || !!discardedInvalidProvidedDesign
}

// Gates dev-loop's Implement phase on the PlanReview gate's final verdict. Without this, a design
// that keeps failing PlanReview past the revision cap (e.g. a state/store design carrying only the
// `none:` properties sentinel) still proceeds into Implement labeled "Approved design," making the
// gate advisory instead of blocking. `hasDesign` is false when design/PlanReview was skipped
// entirely (skipDesign with a pre-approved designDoc) — that case must not block.
export function shouldBlockOnFailedPlanReview({ hasDesign, pass }) {
  return !!hasDesign && !pass
}
