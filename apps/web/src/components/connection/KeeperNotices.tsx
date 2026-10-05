import { UnsavedChangesNotice } from './UnsavedChangesNotice.js'
import { WriteRefusedNotice } from './WriteRefusedNotice.js'

/**
 * What the keeper says about the person's writes: a change it refused, and
 * changes it has not received yet. Both read stores a document page fills,
 * so every frame that can hold a document page mounts this one component —
 * a frame that mounted only one notice, or neither, would roll a refused
 * edit back in silence and let the tab close over unsaved changes.
 */
export function KeeperNotices() {
  return (
    <>
      <UnsavedChangesNotice />
      <WriteRefusedNotice />
    </>
  )
}
