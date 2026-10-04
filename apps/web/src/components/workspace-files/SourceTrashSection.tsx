import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { TrashSection } from './TrashSection.js'

/**
 * The trash section over a files source, present exactly when the source can
 * list and restore — the capability is optional, and a keeper without it
 * shows nothing rather than a restore that cannot happen. Destroying an entry
 * is a further capability the section offers only when the source has it.
 */
export function SourceTrashSection({
  source,
  revision,
  onRestored,
}: Readonly<{
  source: WorkspaceFilesSource
  revision: unknown
  onRestored: () => void
}>) {
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
