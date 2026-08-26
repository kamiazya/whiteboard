import type { Migration } from 'kysely'
import { migration as init } from './0001-init.js'
import { migration as canvasesLastCompactedAt } from './0002-canvases-last-compacted-at.js'
import { migration as documentStore } from './0003-canvas-doc-store.js'
import { migration as workspaceIndex } from './0004-workspace-index.js'
import { migration as canvasesKind } from './0005-canvases-kind.js'
import { migration as dropWorkspaceIndex } from './0006-drop-workspace-index.js'
import { migration as adoptWorkspaceTree } from './0007-adopt-workspace-tree.js'
import { migration as ulidLegacyCanvasIds } from './0008-ulid-legacy-canvas-ids.js'
import { migration as documentVocabulary } from './0009-document-vocabulary.js'
import { migration as documentPath } from './0010-document-path.js'
import { migration as importFsBlobs } from './0011-import-fs-blobs.js'
import { migration as ulidRemainingDocumentIds } from './0012-ulid-remaining-document-ids.js'
import { migration as documentDocKeyPrefix } from './0013-document-dockey-prefix.js'
import { migration as versionsWorkspaceScoped } from './0014-versions-workspace-scoped.js'
import { migration as versionsBranchesWorkspaceId } from './0015-versions-branches-workspace-id.js'

// Ordered map; kysely sorts by key so the numeric prefix decides execution order.
// 0003 still says `canvas-doc-store` after the port it creates was renamed to
// DocumentStore: a key here is recorded in the database (see
// published-migration-names.ts, which pins the list), so it is a historical
// identifier rather than a name. Its FILE keeps the old spelling to match, so
// the two cannot drift.
// 0002-canvases-last-compacted-at is a no-op kept only so databases created by the
// published v0.0.6 release (which recorded it as applied) are not flagged as corrupted.
export const migrations: Record<string, Migration> = {
  '0001-init': init,
  '0002-canvases-last-compacted-at': canvasesLastCompactedAt,
  '0003-canvas-doc-store': documentStore,
  '0004-workspace-index': workspaceIndex,
  '0005-canvases-kind': canvasesKind,
  '0006-drop-workspace-index': dropWorkspaceIndex,
  '0007-adopt-workspace-tree': adoptWorkspaceTree,
  '0008-ulid-legacy-canvas-ids': ulidLegacyCanvasIds,
  '0009-document-vocabulary': documentVocabulary,
  '0010-document-path': documentPath,
  '0011-import-fs-blobs': importFsBlobs,
  '0012-ulid-remaining-document-ids': ulidRemainingDocumentIds,
  '0013-document-dockey-prefix': documentDocKeyPrefix,
  '0014-versions-workspace-scoped': versionsWorkspaceScoped,
  '0015-versions-branches-workspace-id': versionsBranchesWorkspaceId,
}
