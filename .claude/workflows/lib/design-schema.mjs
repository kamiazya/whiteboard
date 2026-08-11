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
        'Invariants, round-trip, and metamorphic relations this change must preserve (e.g. "parse(serialize(x)) === x", "reconcile is idempotent"). At least one entry must answer the CROSS-FEATURE question: what stays true where this change meets an existing cross-cutting concept — containers/groups, selection, z-order, hit-testing vs painted geometry, locking, theming/the CSS reset? A change that genuinely meets none of them says so with one "no-interaction: <reason>" entry. Never empty. For a stateless/pure-UI change with no parser/store/state-machine surface, supply exactly one entry of the form "none: <reason>".',
    },
    // The change's OUTWARD reach, which nothing else in the flow computes: `scope` is what the
    // author intends to edit, this is who else is affected by that edit. typecheck already
    // catches the callers a signature break reaches; the gap this closes is the caller whose
    // types still compile but whose behavior changed, and that has no test to notice.
    // Never empty, and fail-open by construction: `unavailable: <reason>` is a valid answer, so a
    // contributor with no impact-graph tool on their machine is never blocked by this field.
    blastRadius: {
      type: 'array',
      items: { type: 'string', pattern: '\\S' },
      minItems: 1,
      description:
        'Existing call sites/consumers this change reaches, each flagged with whether a test would fail if the change broke it (e.g. "canvas-viewer/CanvasViewer.tsx calls layoutSpatialCanvas — covered by canvas-viewer-jsdom"; "mcp-server/export.ts — NO test"). Never empty. Supply exactly one entry "none: <reason>" for a leaf change with no existing callers, or "unavailable: <reason>" when no impact-graph tool is available on this machine.',
    },
    // `blastRadius` asks who this change reaches INSIDE the codebase; this asks whether it reaches
    // a USER at all. A slice can build, typecheck and pass its tests while nothing registers,
    // mounts, renders or routes it — the tests pass precisely because they call the new code
    // directly. That increment reads as finished and merges as finished, and the gap comes back
    // later as rework. A foundation-only slice is legitimate; a silently foundation-only one is
    // the defect, so the sentinel demands the follow-up that wires it.
    userReach: {
      type: 'array',
      items: { type: 'string', pattern: '\\S' },
      minItems: 1,
      description:
        'The concrete path by which a user reaches this change, naming the entry point that makes it reachable and confirming this increment adds it (e.g. "registered via registerToolWithAnnotations + called by smoke:e2e"; "rendered by CanvasList, reachable from /w/:ws"; "mounted on the Hono app in createServer"). Never empty. When the increment deliberately lands unwired, supply exactly one entry "foundation: <reason> — wired by <named follow-up>"; an unwired slice with no named follow-up is not an acceptable answer.',
    },
  },
  required: ['completionCriteria', 'scope', 'testScenarios', 'properties', 'blastRadius', 'userReach'],
}

// Reuses the schema's own item pattern (rather than a second hand-picked regex) so a caller-
// provided designDoc that bypasses the schema-constrained `agent()` call is held to the exact
// same non-blank-entry invariant as an agent-generated design. One guard covers every
// minItems:1 + `\S` list field (properties/blastRadius/userReach) — they share one pattern.
const nonBlankItem = new RegExp(DESIGN_SCHEMA.properties.properties.items.pattern)
const isNonBlankList = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && nonBlankItem.test(x))

// Kept in lockstep with DESIGN_SCHEMA's `additionalProperties: false` at both the top level and
// inside `testScenarios` — isValidDesignShape below must reject any key outside these lists or a
// caller-provided designDoc could carry fields the schema-constrained agent() path can never
// produce.
const ALLOWED_TOP_LEVEL_KEYS = [
  'completionCriteria',
  'scope',
  'contractChanges',
  'testScenarios',
  'risks',
  'properties',
  'blastRadius',
  'userReach',
]
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
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false
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
  if (!isNonBlankList(d.properties)) return false
  if (!isNonBlankList(d.blastRadius)) return false
  if (!isNonBlankList(d.userReach)) return false
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
