import { VISUAL_TAGS_KEY } from '@kamiazya/whiteboard-plugin-visual/tag-library'
import type { ServerDeps } from '../server-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createFacetSetTool } from './facet-set.js'
import { TAG_LIBRARY_PATH } from './tag-library.js'
import {
  type SetTagLibraryInput,
  type SetTagLibraryOutput,
  setTagLibraryInputSchema,
} from './tag-library-write.schemas.js'
import { listWorkspaceDocuments } from './workspace-library-document.js'

export {
  type SetTagLibraryInput,
  type SetTagLibraryOutput,
  setTagLibraryInputSchema,
  setTagLibraryOutputSchema,
} from './tag-library-write.schemas.js'

/**
 * Writes the workspace's tag library into the document at `tags`, creating
 * that markdown document when the workspace has none.
 *
 * The facet goes through `wb_facet_set`, so the registry judges the library
 * and an agent and a person writing it meet the same refusals; the document's
 * other facets and its body are left as they were.
 *
 * ponytail: the lookup and the create are two steps, so two first writes
 * racing can both create; the second create refuses on the taken path.
 */
export async function setTagLibrary(
  deps: ServerDeps,
  input: SetTagLibraryInput,
): Promise<SetTagLibraryOutput> {
  const { workspaceId, library } = setTagLibraryInputSchema.parse(input)
  const listed = await listWorkspaceDocuments(deps, workspaceId, 'refuse')
  const existing = listed.find((entry) => entry.path === TAG_LIBRARY_PATH)
  const documentId =
    existing?.documentId ??
    (await wbDocumentCreate(deps, { workspaceId, path: TAG_LIBRARY_PATH, kind: 'markdown' }))
      .documentId
  await createFacetSetTool(deps).execute({
    workspaceId,
    documentIds: [documentId],
    facets: { [VISUAL_TAGS_KEY]: { keys: library } },
  })
  return { documentId }
}
