import { describe, expect, it } from 'vitest'
import type { ResolvedDoc, ResolvedDocBundle } from './embed-recursion.js'
import { resolveEmbeds } from './embed-recursion.js'

function doc(canvasId: string, title: string, embeds: readonly string[]): ResolvedDoc {
  return { canvasId, title, embeds }
}

describe('resolveEmbeds', () => {
  it('renders a leaf doc with no embeds normally', () => {
    const bundle: ResolvedDocBundle = {
      root: { canvasId: 'A' },
      docs: { A: doc('A', 'Doc A', []) },
    }
    const result = resolveEmbeds(bundle)
    expect(result.kind).toBe('embedResolved')
  })

  it('renders a placeholder at the depth cap (4th nesting level, root=0)', () => {
    // A -> B -> C -> D -> E: E is depth 4, the cap hit.
    const bundle: ResolvedDocBundle = {
      root: { canvasId: 'A' },
      docs: {
        A: doc('A', 'A', ['B']),
        B: doc('B', 'B', ['C']),
        C: doc('C', 'C', ['D']),
        D: doc('D', 'D', ['E']),
        E: doc('E', 'E', []),
      },
    }
    const result = resolveEmbeds(bundle)
    // A(0)->B(1)->C(2)->D(3) all resolved; D's embed of E would be depth 4 -> placeholder.
    expect(result.kind).toBe('embedResolved')
    const d = findByCanvasId(result, 'D')
    expect(d?.kind).toBe('embedResolved')
    const placeholder = d && d.kind === 'embedResolved' ? d.children[0] : undefined
    expect(placeholder?.kind).toBe('embedPlaceholder')
    if (placeholder?.kind === 'embedPlaceholder') {
      expect(placeholder.reason).toBe('depthCap')
      expect(placeholder.canvasId).toBe('E')
    }
  })

  it('renders a placeholder for a path-local cycle re-visit (self-embed)', () => {
    const bundle: ResolvedDocBundle = {
      root: { canvasId: 'A' },
      docs: { A: doc('A', 'A', ['A']) },
    }
    const result = resolveEmbeds(bundle)
    expect(result.kind).toBe('embedResolved')
    const child = result.kind === 'embedResolved' ? result.children[0] : undefined
    expect(child?.kind).toBe('embedPlaceholder')
    if (child?.kind === 'embedPlaceholder') expect(child.reason).toBe('cycle')
  })

  it('renders a placeholder for a mutual A<->B cycle', () => {
    const bundle: ResolvedDocBundle = {
      root: { canvasId: 'A' },
      docs: { A: doc('A', 'A', ['B']), B: doc('B', 'B', ['A']) },
    }
    const result = resolveEmbeds(bundle)
    const b = result.kind === 'embedResolved' ? result.children[0] : undefined
    expect(b?.kind).toBe('embedResolved')
    const backToA = b?.kind === 'embedResolved' ? b.children[0] : undefined
    expect(backToA?.kind).toBe('embedPlaceholder')
    if (backToA?.kind === 'embedPlaceholder') expect(backToA.reason).toBe('cycle')
  })

  it('renders a disjoint-path re-reference (diamond) normally twice, not as a placeholder', () => {
    // A embeds B twice (via C and via D), B has no further embeds: each B is
    // reached on a disjoint path (A->C->B and A->D->B), so neither is a cycle.
    const bundle: ResolvedDocBundle = {
      root: { canvasId: 'A' },
      docs: {
        A: doc('A', 'A', ['C', 'D']),
        C: doc('C', 'C', ['B']),
        D: doc('D', 'D', ['B']),
        B: doc('B', 'B', []),
      },
    }
    const result = resolveEmbeds(bundle)
    expect(result.kind).toBe('embedResolved')
    const c = findByCanvasId(result, 'C')
    const d = findByCanvasId(result, 'D')
    const bViaC = c?.kind === 'embedResolved' ? c.children[0] : undefined
    const bViaD = d?.kind === 'embedResolved' ? d.children[0] : undefined
    expect(bViaC?.kind).toBe('embedResolved')
    expect(bViaD?.kind).toBe('embedResolved')
  })

  it('renders a placeholder for a missing bundle key', () => {
    const bundle: ResolvedDocBundle = {
      root: { canvasId: 'A' },
      docs: { A: doc('A', 'A', ['missing']) },
    }
    const result = resolveEmbeds(bundle)
    const child = result.kind === 'embedResolved' ? result.children[0] : undefined
    expect(child?.kind).toBe('embedPlaceholder')
    if (child?.kind === 'embedPlaceholder') {
      expect(child.reason).toBe('unresolvable')
      expect(child.title).toBe('missing') // falls back to canvasId
    }
  })

  it('renders a placeholder for an explicitly unresolved bundle entry', () => {
    const bundle: ResolvedDocBundle = {
      root: { canvasId: 'A' },
      docs: { A: doc('A', 'A', ['B']), B: { unresolved: true } },
    }
    const result = resolveEmbeds(bundle)
    const child = result.kind === 'embedResolved' ? result.children[0] : undefined
    expect(child?.kind).toBe('embedPlaceholder')
    if (child?.kind === 'embedPlaceholder') expect(child.reason).toBe('unresolvable')
  })

  it('never throws and terminates over a dense cyclic bundle', () => {
    const docs: ResolvedDocBundle['docs'] = {}
    const ids = ['A', 'B', 'C', 'D', 'E']
    for (const id of ids) {
      docs[id] = doc(
        id,
        id,
        ids.filter((other) => other !== id),
      )
    }
    expect(() => resolveEmbeds({ root: { canvasId: 'A' }, docs })).not.toThrow()
  })
})

function findByCanvasId(
  node: ReturnType<typeof resolveEmbeds>,
  canvasId: string,
): ReturnType<typeof resolveEmbeds> | undefined {
  if (node.kind === 'embedResolved' && node.canvasId === canvasId) return node
  if (node.kind === 'embedResolved') {
    for (const child of node.children) {
      const found = findByCanvasId(child as ReturnType<typeof resolveEmbeds>, canvasId)
      if (found) return found
    }
  }
  return undefined
}
