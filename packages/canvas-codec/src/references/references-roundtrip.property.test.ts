import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/internal'
import { canonicalUlidArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { resolveReferences } from './resolve.js'
import { resolveReferencesForExport } from './resolve-for-export.js'

function wikiLinkRoot(canvasId: string, alias: string | undefined): MdastRoot {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'wikiLink', canvasId, alias }] }],
  }
}

function embedRoot(canvasId: string): MdastRoot {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'embed', canvasId }] }],
  }
}

function firstParagraphChild(root: MdastRoot) {
  const paragraph = root.children[0]
  if (paragraph.type !== 'paragraph') throw new Error('expected paragraph')
  return paragraph.children[0]
}

describe('references export/import round-trip properties', () => {
  fcTest.prop(
    [
      canonicalUlidArbitrary,
      fc.option(
        // `]`/`|` are the wikiLink grammar's own delimiters (see
        // findNextReference in resolve.ts) — an alias containing either is
        // an inherent encoding ambiguity, not a round-trip bug, so it is
        // excluded the same way canvas-codec's markdown round-trip property
        // excludes other delimiter-collision classes.
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((s) => !s.includes(']') && !s.includes('|')),
        { nil: undefined },
      ),
    ],
    withDefaults(),
  )(
    'unresolved wikiLink degrades to literal text that resolveReferences re-parses into the same canvasId/alias',
    (canvasId, alias) => {
      const exported = resolveReferencesForExport(wikiLinkRoot(canvasId, alias), () => null)
      const reimported = resolveReferences(exported)

      const node = firstParagraphChild(reimported)
      expect(node).toEqual({ type: 'wikiLink', canvasId, alias })
    },
  )

  fcTest.prop([canonicalUlidArbitrary], withDefaults())(
    'unresolved embed degrades to literal text that resolveReferences re-parses preserving canvasId',
    (canvasId) => {
      const exported = resolveReferencesForExport(embedRoot(canvasId), () => null)
      const reimported = resolveReferences(exported)

      const node = firstParagraphChild(reimported)
      // The export fallback text for an embed is indistinguishable from a
      // wikiLink's (`[[canvas:ID]]`, no `!` marker survives the degrade), so
      // only the canvasId linkage — not the wikiLink/embed distinction — is
      // guaranteed to survive this cycle.
      expect(node.type === 'wikiLink' || node.type === 'embed').toBe(true)
      if (node.type === 'wikiLink' || node.type === 'embed') {
        expect(node.canvasId).toBe(canvasId)
      }
    },
  )

  fcTest.prop([canonicalUlidArbitrary, fc.constantFrom('wikiLink', 'embed')], withDefaults())(
    'a bijective resolver keeps the canvasId recoverable from the exported text',
    (canvasId, kind) => {
      const root = kind === 'wikiLink' ? wikiLinkRoot(canvasId, undefined) : embedRoot(canvasId)
      const path = `/notes/${canvasId}.md`
      const exported = resolveReferencesForExport(root, (id) => (id === canvasId ? path : null))

      const node = firstParagraphChild(exported)
      expect(node).toEqual({ type: 'text', value: expect.stringContaining(canvasId) })
    },
  )

  fcTest.prop(
    [fc.uniqueArray(canonicalUlidArbitrary, { minLength: 2, maxLength: 2 })],
    withDefaults(),
  )(
    'a non-bijective resolver (two canvasIds mapping to the same path) never throws and exports both',
    ([canvasIdA, canvasIdB]) => {
      const collidingPath = '/notes/shared.md'
      const resolver = () => collidingPath

      const exportedA = resolveReferencesForExport(wikiLinkRoot(canvasIdA, undefined), resolver)
      const exportedB = resolveReferencesForExport(wikiLinkRoot(canvasIdB, undefined), resolver)

      expect(firstParagraphChild(exportedA)).toEqual({
        type: 'text',
        value: `[${collidingPath}](${collidingPath})`,
      })
      expect(firstParagraphChild(exportedB)).toEqual({
        type: 'text',
        value: `[${collidingPath}](${collidingPath})`,
      })
    },
  )

  fcTest.prop(
    [fc.array(fc.tuple(canonicalUlidArbitrary, fc.boolean()), { minLength: 1, maxLength: 5 })],
    withDefaults(),
  )(
    'a partial resolver preserves canvasId for resolvable entries and degrades unresolvable ones to text',
    (entries) => {
      const resolvableIds = new Set(
        entries.filter(([, resolvable]) => resolvable).map(([id]) => id),
      )
      const resolver = (id: string) => (resolvableIds.has(id) ? `/notes/${id}.md` : null)

      for (const [canvasId, resolvable] of entries) {
        const exported = resolveReferencesForExport(wikiLinkRoot(canvasId, undefined), resolver)
        const value = firstParagraphChild(exported)
        expect(value.type).toBe('text')
        if (value.type !== 'text') continue

        if (resolvable) {
          expect(value.value).toContain(`/notes/${canvasId}.md`)
        } else {
          expect(value.value).toBe(`[[canvas:${canvasId}]]`)
          const reimported = resolveReferences(
            resolveReferencesForExport(wikiLinkRoot(canvasId, undefined), resolver),
          )
          expect(firstParagraphChild(reimported)).toEqual({
            type: 'wikiLink',
            canvasId,
            alias: undefined,
          })
        }
      }
    },
  )

  fcTest.prop(
    [
      canonicalUlidArbitrary,
      fc.option(
        // `]`/`|` are the wikiLink grammar's own delimiters (see
        // findNextReference in resolve.ts) — an alias containing either is
        // an inherent encoding ambiguity, not a round-trip bug, so it is
        // excluded the same way canvas-codec's markdown round-trip property
        // excludes other delimiter-collision classes.
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((s) => !s.includes(']') && !s.includes('|')),
        { nil: undefined },
      ),
    ],
    withDefaults(),
  )(
    'resolveReferencesForExport is idempotent for a resolved wikiLink: applying twice equals applying once',
    (canvasId, alias) => {
      const resolver = () => `/notes/${canvasId}.md`
      const root = wikiLinkRoot(canvasId, alias)

      const once = resolveReferencesForExport(root, resolver)
      const twice = resolveReferencesForExport(once, resolver)

      expect(twice).toEqual(once)
    },
  )
})
