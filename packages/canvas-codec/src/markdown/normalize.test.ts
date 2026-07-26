import { mdastRootSchema } from '@kamiazya/whiteboard-canvas-model/internal'
import { mdastRootArbitrary } from '@kamiazya/whiteboard-canvas-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { normalizeMdast } from './normalize.js'

describe('normalizeMdast', () => {
  it('canonicalizes an empty code-fence `meta` to undefined (found by the round-trip property: shrunk from a nested blockquote > blockquote > code node with meta:"")', () => {
    const root = {
      type: 'root' as const,
      children: [{ type: 'code' as const, value: '', lang: null, meta: '' }],
    }

    expect(normalizeMdast(root)).toEqual({
      type: 'root',
      children: [{ type: 'code', value: '', lang: undefined, meta: undefined }],
    })
  })

  it("canonicalizes a langless code fence's whitespace-only `meta` to undefined too (found by the round-trip property: meta has nowhere to render without a lang word)", () => {
    const root = {
      type: 'root' as const,
      children: [{ type: 'code' as const, value: '', lang: null, meta: ' ' }],
    }

    expect(normalizeMdast(root)).toEqual({
      type: 'root',
      children: [{ type: 'code', value: '', lang: undefined, meta: undefined }],
    })
  })

  it('canonicalizes an empty-string `lang` (as distinct from null) to undefined too', () => {
    const root = {
      type: 'root' as const,
      children: [{ type: 'code' as const, value: '', lang: '', meta: null }],
    }

    expect(normalizeMdast(root)).toEqual({
      type: 'root',
      children: [{ type: 'code', value: '', lang: undefined, meta: undefined }],
    })
  })

  it('merges adjacent text siblings (found by the round-trip property: remark-parse never produces two consecutive text nodes)', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'paragraph' as const,
          children: [
            {
              type: 'emphasis' as const,
              children: [
                { type: 'text' as const, value: '0' },
                { type: 'text' as const, value: '1' },
              ],
            },
          ],
        },
      ],
    }

    expect(normalizeMdast(root)).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'emphasis', children: [{ type: 'text', value: '01' }] }],
        },
      ],
    })
  })

  it('trims whitespace-only image/link title/alt to undefined (found by the round-trip property)', () => {
    const root = {
      type: 'root' as const,
      children: [
        {
          type: 'paragraph' as const,
          children: [{ type: 'image' as const, url: 'http://a.aa', title: '  ', alt: '' }],
        },
      ],
    }

    expect(normalizeMdast(root)).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'image', url: 'http://a.aa', title: undefined, alt: undefined }],
        },
      ],
    })
  })

  fcTest.prop([mdastRootArbitrary()], withDefaults())('is idempotent', (root) => {
    expect(normalizeMdast(normalizeMdast(root))).toEqual(normalizeMdast(root))
  })

  fcTest.prop([mdastRootArbitrary()], withDefaults())(
    'never loses content: still validates against mdastRootSchema',
    (root) => {
      expect(mdastRootSchema.safeParse(normalizeMdast(root)).success).toBe(true)
    },
  )
})
