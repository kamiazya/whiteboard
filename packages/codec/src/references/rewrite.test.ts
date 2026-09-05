import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  movesForPathChange,
  planReferenceRewrite,
  rewriteCanvasReferences,
  rewriteReferenceTargets,
} from './rewrite.js'

const MOVED = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

describe('rewriteReferenceTargets', () => {
  const map = new Map([['design/login', 'archive/login']])

  it('rewrites only the target slice, keeping brackets, bang and label', () => {
    expect(rewriteReferenceTargets('see [[design/login]] here', map)).toBe(
      'see [[archive/login]] here',
    )
    expect(rewriteReferenceTargets('![[design/login]]', map)).toBe('![[archive/login]]')
    expect(rewriteReferenceTargets('[[design/login|the login flow]]', map)).toBe(
      '[[archive/login|the login flow]]',
    )
  })

  it('moves the document half and keeps a #fragment where it was', () => {
    expect(
      rewriteReferenceTargets('![[design/login#Sign in]] [[design/login#Sign in|x]]', map),
    ).toBe('![[archive/login#Sign in]] [[archive/login#Sign in|x]]')
  })

  it('leaves every other target byte-identical', () => {
    const body = '[[design/logout]] and [[Login flow]] and plain [[design/login-notes]]'
    expect(rewriteReferenceTargets(body, map)).toBe(body)
  })

  it('leaves text that only LOOKS like a reference alone', () => {
    // The scanner never matches these, so the rewriter must not either —
    // what gets rewritten must equal what resolves (ADR-0014's bar).
    const body = '[[design/login and [design/login] and [[]]'
    expect(rewriteReferenceTargets(body, map)).toBe(body)
  })

  it('rewrites every occurrence, not just the first', () => {
    expect(rewriteReferenceTargets('[[design/login]] twice [[design/login]]', map)).toBe(
      '[[archive/login]] twice [[archive/login]]',
    )
  })
})

describe('rewriteCanvasReferences', () => {
  const map = new Map([['design/login', 'archive/login']])
  const canvas: SpatialCanvas = {
    nodes: [
      { id: 't1', x: 0, y: 0, width: 100, height: 40, type: 'text', text: 'see [[design/login]]' },
      { id: 'f1', x: 0, y: 60, width: 100, height: 40, type: 'file', file: 'design/login' },
      { id: 'f2', x: 0, y: 120, width: 100, height: 40, type: 'file', file: 'design/logout' },
    ],
    edges: [],
  }

  it('rewrites text-node wikilinks and file-node targets, and reports exactly which changed', () => {
    const out = rewriteCanvasReferences(canvas, map)
    expect(out.changed).toBe(true)
    // The CHANGED list is what a caller writes back — one targeted write per
    // node, never the whole canvas, so records the current schema cannot
    // read are never deleted by a resync.
    expect(out.changedNodes.map((n) => n.id)).toEqual(['t1', 'f1'])
    const nodes = out.canvas.nodes
    expect(nodes[0]).toMatchObject({ text: 'see [[archive/login]]' })
    expect(nodes[1]).toMatchObject({ file: 'archive/login' })
    // An untouched node keeps its identity, not just its value.
    expect(nodes[2]).toBe(canvas.nodes[2])
  })

  it('answers changed: false — and the same canvas object — when nothing matches', () => {
    const out = rewriteCanvasReferences(canvas, new Map([['nowhere', 'else']]))
    expect(out.changed).toBe(false)
    expect(out.canvas).toBe(canvas)
  })
})

describe('planReferenceRewrite', () => {
  const table = (docs: readonly { id: string; path: string; name?: string }[]) => docs

  it('maps the old path to the new path on a move', () => {
    const plan = planReferenceRewrite({
      entries: table([
        { id: MOVED, path: 'design/login', name: 'Login flow' },
        { id: OTHER, path: 'notes/other' },
      ]),
      moves: [{ movedId: MOVED, from: 'design/login', to: 'archive/login' }],
    })
    expect(plan.get('design/login')).toBe('archive/login')
    expect(plan.has('Login flow')).toBe(false)
  })

  it('a display name cannot shadow a path — names are retired from resolution', () => {
    // Another document NAMED exactly the old or new path changes nothing:
    // the alias space is paths + ids only (display names appear at render
    // time instead), so the path resolved before and the new path resolves
    // after, name collisions notwithstanding.
    const plan = planReferenceRewrite({
      entries: table([
        { id: MOVED, path: 'design/login' },
        { id: OTHER, path: 'b/two', name: 'design/login' },
        { id: '01DX5ZZKBKACTAV9WEVGEMMVRC', path: 'c/three', name: 'archive/login' },
      ]),
      moves: [{ movedId: MOVED, from: 'design/login', to: 'archive/login' }],
    })
    expect(plan.get('design/login')).toBe('archive/login')
  })

  it('falls back to the id when the NEW path spells a live document id', () => {
    // The reader resolves a direct id first, so a path that IS some
    // document's id would resolve to that document, not the moved one.
    const plan = planReferenceRewrite({
      entries: table([
        { id: MOVED, path: 'a/one' },
        { id: OTHER, path: OTHER },
      ]),
      moves: [{ movedId: MOVED, from: 'a/one', to: OTHER }],
    })
    expect(plan.get('a/one')).toBe(MOVED)
  })

  it('never rewrites an alias that is also a live document id', () => {
    // A path can legally spell 26 Crockford characters. The reader resolves
    // a direct id FIRST, so [[<OTHER>]] points at OTHER even while it is
    // the moved document's path — rewriting it would break OTHER's link.
    const plan = planReferenceRewrite({
      entries: table([
        { id: MOVED, path: OTHER },
        { id: OTHER, path: 'b/two' },
      ]),
      moves: [{ movedId: MOVED, from: OTHER, to: 'archive/login' }],
    })
    expect(plan.has(OTHER)).toBe(false)
  })

  it('plans every descendant of a subtree move', () => {
    const CHILD = '01CX5ZZKBKACTAV9WEVGEMMVRA'
    const entries = table([
      { id: MOVED, path: 'folder' },
      { id: CHILD, path: 'folder/child' },
    ])
    const moves = movesForPathChange(entries, 'folder', 'archive/folder')
    expect(moves).toEqual([
      { movedId: MOVED, from: 'folder', to: 'archive/folder' },
      { movedId: CHILD, from: 'folder/child', to: 'archive/folder/child' },
    ])
    const plan = planReferenceRewrite({ entries, moves })
    expect(plan.get('folder')).toBe('archive/folder')
    expect(plan.get('folder/child')).toBe('archive/folder/child')
  })

  it('does not sweep a sibling whose path merely starts with the same word', () => {
    const SIB = '01CX5ZZKBKACTAV9WEVGEMMVRB'
    const moves = movesForPathChange(
      table([
        { id: MOVED, path: 'folder' },
        { id: SIB, path: 'folder-notes' },
      ]),
      'folder',
      'archive/folder',
    )
    expect(moves).toEqual([{ movedId: MOVED, from: 'folder', to: 'archive/folder' }])
  })

  it('produces no entry when nothing changed', () => {
    const plan = planReferenceRewrite({
      entries: table([{ id: MOVED, path: 'a/one', name: 'Login flow' }]),
      moves: [{ movedId: MOVED, from: 'a/one', to: 'a/one' }],
    })
    expect(plan.size).toBe(0)
  })
})
