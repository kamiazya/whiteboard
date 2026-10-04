import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { isEngineTrap } from './engine-trap.js'

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw')
}

describe('isEngineTrap', () => {
  it('matches the WASM abort by name and message, whichever realm raised it', () => {
    expect(isEngineTrap(Object.assign(new Error('unreachable'), { name: 'RuntimeError' }))).toBe(
      true,
    )
  })

  it('does not match bytes the engine refuses, which leave the document usable', () => {
    const doc = new LoroDoc()
    const refused = thrownBy(() => doc.import(new Uint8Array([1, 2, 3, 4])))
    expect(isEngineTrap(refused)).toBe(false)
    doc.getText('t').insert(0, 'still usable')
    expect(doc.getText('t').toString()).toBe('still usable')
  })

  it('does not match an ordinary failure or a non-error', () => {
    expect(isEngineTrap(new Error('unreachable'))).toBe(false)
    expect(isEngineTrap(Object.assign(new Error('out of bounds'), { name: 'RuntimeError' }))).toBe(
      false,
    )
    expect(isEngineTrap('unreachable')).toBe(false)
  })
})
