/**
 * ADR-0053's three address forms through the published artifact: the
 * qualified `<handle>/<segment>` (a daemon's one namespace is `me`) and the
 * canonical id list exactly what the bare segment lists, and a qualified
 * handle in a namespace nobody holds is refused as naming no workspace.
 */
export async function assertWorkspaceAddressForms(callTool, segment, workspaceId) {
  const listed = async (address) =>
    JSON.stringify(
      (await callTool('wb_document_list', { workspaceId: address })).documents
        .map((d) => d.path)
        .sort(),
    )
  const bySegment = await listed(segment)
  for (const address of [`me/${segment}`, workspaceId]) {
    const answered = await listed(address)
    if (answered !== bySegment) {
      throw new Error(
        `wb_document_list by ${address} answered ${answered}, by segment ${bySegment}`,
      )
    }
  }
  const refusal = await callTool('wb_document_list', { workspaceId: `nobody/${segment}` }).then(
    (answered) => `answered ${JSON.stringify(answered)}`,
    (error) => (error instanceof Error ? error.message : String(error)),
  )
  if (!refusal.includes('Workspace not found')) {
    throw new Error(`a qualified handle nobody holds was refused for another reason: ${refusal}`)
  }
  console.log(`[e2e] me/${segment} and the canonical id reach the segment's workspace`)
}
