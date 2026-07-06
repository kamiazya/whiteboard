// Canonical, unit-tested reference for the dimension-normalization logic inlined into both
// audit-triage.workflow.mjs and review.workflow.mjs. Those workflow scripts are executed by the
// Workflow runtime as standalone function bodies with no module resolution (see the
// workflow-authoring skill, gotcha #5), so they cannot `import` this file — each keeps its own
// mirrored copy in sync with this one, which node:test exercises directly.
//
// Both callers accept a caller-supplied `dimensions` list that is either a legacy plain string
// (criteria stays embedded in the reviewing agent's own prompt/doc) or an externalized
// {name, content} object (content is the authoritative criteria injected straight into the agent
// prompt).
//
// A non-string entry missing `name` must fail fast here: `name` becomes the agent label, the
// lane `key`, and the coverage-tracking identifier (dimensionsAudited/failedDimensions/
// notApplicable). Letting it default to `undefined` would silently degrade those into
// `audit:undefined` / `review:undefined` and corrupt lane-key matching instead of surfacing a
// caller error immediately.

/**
 * @param {unknown} d
 * @returns {{ name: string, content: string | null }}
 */
export function normalizeDimension(d) {
  if (typeof d === 'string') return { name: d, content: null }
  if (d && typeof d === 'object' && typeof d.name === 'string' && d.name.length > 0) {
    return { name: d.name, content: d.content || null }
  }
  throw new Error(
    `invalid dimension entry: expected a string or a {name, content} object with a non-empty "name", got ${JSON.stringify(d)}`,
  )
}
