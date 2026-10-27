/**
 * `wb_workspace_edit`'s `folder.rename`: a folder's display name, apart from
 * its path. The folder exists because a document hangs from it, and naming
 * it moves nothing; a name holding "/" is refused at the boundary.
 */
export async function folderRenameNamesAFolder({ callTool, expectToolError, workspaceId }) {
  const named = await callTool('wb_workspace_edit', {
    workspaceId,
    ops: [
      { op: 'document.create', path: 'e2e-folder/inner', kind: 'markdown' },
      { op: 'folder.rename', path: 'e2e-folder', name: 'E2E folder' },
    ],
  })
  if (named.applied !== 2 || named.results[1]?.path !== 'e2e-folder') {
    throw new Error(`folder.rename returned unexpected shape: ${JSON.stringify(named)}`)
  }
  await expectToolError(
    'wb_workspace_edit',
    { workspaceId, ops: [{ op: 'folder.rename', path: 'e2e-folder', name: 'a/b' }] },
    'with a folder name holding "/"',
    'cannot contain',
  )
  console.log('[e2e] wb_workspace_edit → folder.rename names a folder, refuses a "/"')
}
