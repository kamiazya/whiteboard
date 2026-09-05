import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { contentStateOf } from './document-state.js'
import { composeOutlineSource } from './outline-source.js'

function docWith(text: string): LoroDoc {
  const doc = new LoroDoc()
  doc.getText('body').insert(0, text)
  doc.commit()
  return doc
}

const noSession = () => null

describe('composeOutlineSource', () => {
  // The defect this exists for, found by opening the app: a browser-kept
  // markdown document lives in its own LoroDoc and never reaches the sync
  // session, so asking the session alone answered `null` and the tab icon
  // never changed however much was typed. No test of the hook above could
  // have caught it — they all inject a source and never make this choice.
  it('reads a markdown document the session does not hold', () => {
    const doc = docWith('# Heading')

    const source = composeOutlineSource('markdown', noSession, { doc, body: '# Heading' })

    expect(source).toEqual({ state: contentStateOf(doc), body: '# Heading' })
  })

  // Where the session DOES hold it — the daemon page's shape — its answer is
  // the authoritative one, and the second owner must not shadow it.
  it('prefers the session when the session holds the document', () => {
    const fromSession = vi.fn(() => ({ state: 'session-v1', body: 'from session' }))

    const source = composeOutlineSource('markdown', fromSession, {
      doc: docWith('other'),
      body: 'from the markdown owner',
    })

    expect(source).toEqual({ state: 'session-v1', body: 'from session' })
  })

  it('leaves a spatial document to the session entirely', () => {
    const snapshot = new Uint8Array([1, 2, 3])
    const fromSession = vi.fn(() => ({ state: 'v1', snapshot }))

    expect(composeOutlineSource('spatial', fromSession, { doc: null, body: null })).toEqual({
      state: 'v1',
      snapshot,
    })
    expect(fromSession).toHaveBeenCalledWith('spatial')
  })

  // Before either owner has hydrated there is no version, and a picture
  // filed under "no version" would be served for as long as the tab is open.
  it('answers nothing while neither owner holds the document', () => {
    expect(composeOutlineSource('markdown', noSession, { doc: null, body: null })).toBeNull()
  })

  it('answers nothing when the markdown owner has a doc but no body yet', () => {
    expect(
      composeOutlineSource('markdown', noSession, { doc: docWith('x'), body: null }),
    ).toBeNull()
  })

  // The version has to move with the document, or the memo above serves the
  // previous picture — the failure the whole key exists to avoid.
  it('answers a different version once the document has changed', () => {
    const doc = docWith('# One')
    const before = composeOutlineSource('markdown', noSession, { doc, body: '# One' })

    doc.getText('body').insert(5, ' more')
    doc.commit()
    const after = composeOutlineSource('markdown', noSession, { doc, body: '# One more' })

    expect(after?.state).not.toBe(before?.state)
  })
})
