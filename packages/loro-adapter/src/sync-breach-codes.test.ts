import { SYNC_WRITE_REFUSAL_CODES, type SyncWriteRefusalCode } from '@kamiazya/whiteboard-model'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { SYNC_TEXT_BREACH_CODES, type SyncTextBreach } from './sync-text-limits.js'
import { SYNC_WORKSPACE_BREACH_CODES, type WorkspaceSyncBreach } from './workspace-sync-limits.js'

describe('the code a sync breach is answered with', () => {
  it('names one for every shape the judges raise, as a code a sync write is refused with', () => {
    expectTypeOf(SYNC_TEXT_BREACH_CODES).toExtend<
      Record<SyncTextBreach['shape'], SyncWriteRefusalCode>
    >()
    expectTypeOf(SYNC_WORKSPACE_BREACH_CODES).toExtend<
      Record<WorkspaceSyncBreach['shape'], SyncWriteRefusalCode>
    >()
    const answered = [
      ...Object.values(SYNC_TEXT_BREACH_CODES),
      ...Object.values(SYNC_WORKSPACE_BREACH_CODES),
    ]
    expect(Object.keys(SYNC_TEXT_BREACH_CODES).length).toBeGreaterThan(15)
    expect(Object.keys(SYNC_WORKSPACE_BREACH_CODES).length).toBeGreaterThan(5)
    for (const code of answered) expect(SYNC_WRITE_REFUSAL_CODES).toContain(code)
  })
})
