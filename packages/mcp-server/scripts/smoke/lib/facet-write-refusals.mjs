/**
 * A facets bucket is judged on WRITE, on every op that carries one: a
 * registered facet whose payload its schema rejects, and a bucket that is not
 * a record at all, are each refused. Checked by REASON, so a refusal for
 * another cause does not pass — and a silent drop answers, which
 * `callToolExpectingError` reports as a failure on its own.
 *
 * Patches the smoke's `link` edge, which every step before this one leaves in
 * place.
 */
export async function assertCanvasFacetWritesRefused(
  callToolExpectingError,
  workspaceId,
  documentId,
) {
  const patch = (facets) =>
    callToolExpectingError('wb_canvas_edit', {
      workspaceId,
      documentId,
      mode: 'apply',
      ops: [{ op: 'edge.patch', id: 'link', patch: { facets } }],
    })
  const badPayload = await patch({ 'visual.edges/v0': { routing: 'spiral' } })
  if (!/visual\.edges\/v0/.test(badPayload)) {
    throw new Error(
      `wb_canvas_edit accepted an invalid registered facet payload, or refused it for another reason: ${badPayload}`,
    )
  }
  const badBucket = await patch(5)
  if (!/record/.test(badBucket)) {
    throw new Error(
      `wb_canvas_edit accepted a non-record facets bucket, or refused it for another reason: ${badBucket}`,
    )
  }
}
