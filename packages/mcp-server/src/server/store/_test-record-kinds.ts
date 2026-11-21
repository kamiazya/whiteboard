import { afterEach, beforeEach, describe } from 'vitest'
import type { RecordKindName } from './storage-env.js'

const RECORD_KINDS: readonly RecordKindName[] = ['loro', 'lease']

/**
 * Runs `body` once per record kind the daemon can hold a workspace record as,
 * with the cache holding that kind for the block. For a behaviour both kinds
 * owe: a block that passes under only the default says nothing about the other,
 * which stays selectable by `WHITEBOARD_RECORD_KIND`.
 */
export function describeUnderBothRecordKinds(title: string, body: (kind: RecordKindName) => void) {
  describe.each(RECORD_KINDS)(`%s record: ${title}`, (kind) => {
    beforeEach(async () => {
      const { _setWorkspaceRecordKindForTests } = await import('./workspace-doc-cache.js')
      _setWorkspaceRecordKindForTests(kind)
    })
    afterEach(async () => {
      const { _setWorkspaceRecordKindForTests } = await import('./workspace-doc-cache.js')
      _setWorkspaceRecordKindForTests(null)
    })
    body(kind)
  })
}
