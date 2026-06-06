import { describe, it, expect } from 'vitest'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { reconcileElementsOnDoc } from './reconcile-elements.js'

type El = Record<string, unknown>

function docOf(elements: El[]): LoroDoc {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  for (const el of elements) {
    const m = list.insertContainer(list.length, new LoroMap())
    for (const [k, v] of Object.entries(el)) {
      m.set(k, v as Parameters<LoroMap['set']>[1])
    }
  }
  doc.commit()
  return doc
}

function snapshot(doc: LoroDoc): El[] {
  return doc.getMovableList('elements').toJSON() as El[]
}

function byId(elements: El[]): Record<string, El> {
  return Object.fromEntries(elements.map((el) => [el.id as string, el]))
}

describe('reconcileElementsOnDoc', () => {
  describe('branch 1: element present in both current and past', () => {
    it('updates a changed field to match the past value', () => {
      const current = docOf([{ id: 'a', type: 'rectangle', fill: 'red' }])
      const past = docOf([{ id: 'a', type: 'rectangle', fill: 'blue' }])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      expect(els).toHaveLength(1)
      expect(els[0]?.fill).toBe('blue')
    })

    it('preserves unchanged fields without mutation', () => {
      const current = docOf([{ id: 'a', type: 'rectangle', fill: 'red', x: 10 }])
      const past = docOf([{ id: 'a', type: 'rectangle', fill: 'red', x: 20 }])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      expect(els[0]?.fill).toBe('red')
      expect(els[0]?.x).toBe(20)
    })

    it('removes a field that is absent in past', () => {
      const current = docOf([{ id: 'a', type: 'rectangle', extra: 'gone' }])
      const past = docOf([{ id: 'a', type: 'rectangle' }])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      expect(els[0]).not.toHaveProperty('extra')
    })
  })

  describe('branch 2: element present only in current (not in past)', () => {
    it('sets isDeleted to true on a current-only element', () => {
      const current = docOf([{ id: 'a', type: 'rectangle', isDeleted: false }])
      const past = docOf([])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      expect(els).toHaveLength(1)
      expect(els[0]?.isDeleted).toBe(true)
    })

    it('does not double-tombstone an already-deleted current-only element', () => {
      const current = docOf([{ id: 'a', type: 'rectangle', isDeleted: true }])
      const past = docOf([])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      expect(els[0]?.isDeleted).toBe(true)
    })

    it('tombstones current-only while leaving shared elements untouched', () => {
      const current = docOf([
        { id: 'shared', type: 'rectangle' },
        { id: 'extra', type: 'ellipse' },
      ])
      const past = docOf([{ id: 'shared', type: 'rectangle' }])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = byId(snapshot(current))
      expect(els['extra']?.isDeleted).toBe(true)
      expect(els['shared']?.isDeleted).toBeUndefined()
    })
  })

  describe('branch 3: element present only in past (not in current)', () => {
    it('inserts a past-only element into the current doc', () => {
      const current = docOf([])
      const past = docOf([{ id: 'b', type: 'text', content: 'hello' }])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      expect(els).toHaveLength(1)
      expect(els[0]?.id).toBe('b')
      expect(els[0]?.type).toBe('text')
      expect(els[0]?.content).toBe('hello')
    })

    it('copies all fields from the past element on insert', () => {
      const pastEl = { id: 'c', type: 'rectangle', x: 5, y: 10, fill: '#fff' }
      const current = docOf([])
      const past = docOf([pastEl])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      expect(els[0]).toMatchObject(pastEl)
    })

    it('inserts past-only elements after any existing current elements', () => {
      const current = docOf([{ id: 'a', type: 'rectangle' }])
      const past = docOf([
        { id: 'a', type: 'rectangle' },
        { id: 'new', type: 'ellipse' },
      ])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = snapshot(current)
      const ids = els.map((e) => e.id)
      expect(ids).toContain('a')
      expect(ids).toContain('new')
    })
  })

  describe('combined: all three branches at once', () => {
    it('handles field-merge + tombstone + insert in a single call', () => {
      const current = docOf([
        { id: 'both', type: 'rectangle', fill: 'red' }, // both → field update
        { id: 'currentOnly', type: 'ellipse' },          // current-only → tombstone
      ])
      const past = docOf([
        { id: 'both', type: 'rectangle', fill: 'green' }, // field changed
        { id: 'pastOnly', type: 'text', content: 'hi' },  // past-only → insert
      ])

      reconcileElementsOnDoc(current, past)
      current.commit()

      const els = byId(snapshot(current))

      expect(els['both']?.fill).toBe('green')
      expect(els['currentOnly']?.isDeleted).toBe(true)
      expect(els['pastOnly']?.content).toBe('hi')
    })
  })
})
