import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { TrashSection } from './TrashSection.js'

/**
 * The trash section over a files source, present exactly when the source can
 * list and restore — the capability is optional, and a keeper without it
 * shows nothing rather than a restore that cannot happen. Destroying an entry
 * is a further capability the section offers only when the source has it.
 *
 * Not while the host's list is loading (`listLoaded`). The trash is a SECOND
 * list of the departed workspace's documents and reads on its own, so left
 * mounted it keeps showing that workspace's rows under the new address until
 * its own read answers — measured with a trash read that never answers,
 * which is the window this closes.
 *
 * `onRestored` re-reads the host's list. A restore that landed but whose
 * refresh failed leaves the list stale, not the restore undone — the same
 * rule as every other write in the panel, so the trash section never invents
 * its own error shape.
 */
export function SourceTrashSection({
  source,
  revision,
  listLoaded,
  onRestored,
}: Readonly<{
  source: WorkspaceFilesSource
  revision: unknown
  listLoaded: boolean
  onRestored: () => void
}>) {
  if (!listLoaded) return null
  if (source.listTrash === undefined || source.restoreFromTrash === undefined) return null
  return (
    <TrashSection
      listTrash={source.listTrash.bind(source)}
      restoreFromTrash={source.restoreFromTrash.bind(source)}
      purgeFromTrash={source.purgeFromTrash?.bind(source)}
      revision={revision}
      onRestored={onRestored}
    />
  )
}
