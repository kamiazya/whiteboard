import { describe, expect, it } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { PersistenceLedger } from './persistence-ledger.js'

function settledLedger() {
  const reports: BrowserPersistenceState['kind'][] = []
  const ledger = new PersistenceLedger(
    (state) => reports.push(state.kind),
    () => false,
  )
  ledger.edited()
  ledger.pushStarted().resolved()
  expect(reports).toEqual(['pending', 'saved'])
  reports.length = 0
  return { ledger, reports }
}

describe('a push no edit announced (an undo, a redo, a re-send)', () => {
  it('reads pending from the push until it lands, then saved', () => {
    const { ledger, reports } = settledLedger()

    const push = ledger.pushStarted()

    expect(reports).toEqual(['pending'])
    push.resolved()
    expect(reports).toEqual(['pending', 'saved'])
  })

  it('stays pending while a second such push is still in flight', () => {
    const { ledger, reports } = settledLedger()
    const first = ledger.pushStarted()
    const second = ledger.pushStarted()

    first.resolved()

    expect(reports.at(-1)).toBe('pending')
    expect(reports).not.toContain('saved')
    second.resolved()
    expect(reports.at(-1)).toBe('saved')
  })
})
