// Canonical, unit-tested reference for dev-loop's fix-loop triage (see fix-loop.test.mjs). The
// Workflow runtime executes dev-loop.workflow.mjs as a standalone function body with no module
// resolution (see the workflow-authoring skill's sandbox gotcha), so it keeps a mirrored inline
// copy; the drift test in fix-loop.test.mjs is what keeps the two in sync.

export const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }

/**
 * Split a review report into what the fix loop must resolve now and what becomes a followup.
 *
 * A FAILED qa-scenario is included alongside the confirmed findings. It used to be counted in the
 * summary and then dropped, because the loop filtered `confirmedFindings` only — so a QA agent
 * that reproduced a defect with a scripted repro still handed the bug straight to the integrator
 * with zero fix attempts. QA carries no severity of its own, so it enters at HIGH: it is evidence
 * that something observably broke, which outranks a static finding of the same name.
 *
 * Total by construction: a null/malformed report yields empty lists rather than throwing, because
 * this runs inside a loop whose failure mode would otherwise be an aborted dev-loop.
 *
 * @param {{confirmedFindings?: unknown, qa?: unknown} | null | undefined} review
 * @param {number} threshold
 * @returns {{actionable: Array<object>, below: Array<object>}}
 */
export function triageReview(review, threshold) {
  const findings = Array.isArray(review?.confirmedFindings) ? review.confirmedFindings : []
  const qa = Array.isArray(review?.qa) ? review.qa : []
  const qaFindings = qa
    .filter((q) => q && q.status === 'fail')
    .map((q) => ({
      severity: 'HIGH',
      title: `QA scenario "${q.scenario}" failed`,
      file: '(qa)',
      detail: q.notes || '',
    }))
  const all = [...findings, ...qaFindings]
  return {
    actionable: all.filter((f) => (SEVERITY_RANK[f.severity] || 0) >= threshold),
    below: all.filter((f) => (SEVERITY_RANK[f.severity] || 0) < threshold),
  }
}
