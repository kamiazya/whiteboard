import { lease, type RecordLease } from '@kamiazya/whiteboard-loro-adapter'
import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { saveAndAnnounce } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { BrowserWorkspaceRecords } from './browser-workspace-records.js'

/**
 * Edits the browser workspace's record held as an engine lease: the record is
 * opened, `edit` answers what to write (nothing for no change), and a change
 * is saved as one incremental update and announced to every open page. The
 * lease is released whatever happens.
 *
 * The keeper judges what it is pushed, so the writes make no judging copy of a
 * record that holds every document. Answers `value`, or throws `unopened`'s
 * message when the record could not be opened.
 */
export async function editWorkspaceRecord<T>(
  unopened: string,
  dbName: string | undefined,
  edit: (record: RecordLease) => Promise<{ value: T; writes: wire.Write[] }>,
): Promise<T> {
  const records = new BrowserWorkspaceRecords(dbName)
  // The id read sits inside the isolation, as `openWorkspaceOrNull`'s does:
  // a throwing accessor is an unopened record, not an escape past this check.
  const held = await (async () => {
    try {
      const workspaceId = getBrowserWorkspaceId()
      const opened = await records.open(workspaceId)
      return opened === null ? null : { workspaceId, opened }
    } catch {
      return null
    }
  })()
  if (held === null) throw new Error(unopened)
  const { workspaceId, opened } = held
  return lease.withLease(opened, async (record) => {
    const { value, writes } = await edit(record)
    if (writes.length === 0) return value
    lease.write(record, writes, { judge: 'none' })
    await saveAndAnnounce(records, workspaceId, record)
    return value
  })
}
