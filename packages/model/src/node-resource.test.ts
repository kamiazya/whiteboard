/**
 * The registry is what keeps the exhaustiveness the node-kind union had.
 *
 * ADR-0038 decision 3 dissolves that union, and with it the `switch` guard
 * `searchable-texts.ts` names outright. The stored shape stays OCIF-faithful
 * — a mimeType, inline content or a location, no discriminant we invented —
 * and the closed set lives in `RESOURCE_KINDS` instead, so `ResourceKind` is
 * still a closed union and a `switch` over it still narrows to `never`.
 */
import { describe, expect, it } from 'vitest'
import {
  type NodeResource,
  nodeResourceSchema,
  RESOURCE_KINDS,
  type ResourceKind,
  resourceKind,
} from './node-resource.js'
import { fc, fcTest, withDefaults } from './test-utils/index.js'

const KIND_IDS = Object.keys(RESOURCE_KINDS) as ResourceKind[]

describe('what a resource IS', () => {
  it('reads inline markdown as text, a uri-list as a link, any other location as a file', () => {
    expect(resourceKind({ mimeType: 'text/markdown', content: '# hi' })).toBe('text')
    expect(resourceKind({ mimeType: 'text/uri-list', location: 'https://example.com' })).toBe(
      'link',
    )
    expect(resourceKind({ mimeType: 'text/markdown', location: 'notes.md' })).toBe('file')
  })

  it('answers undefined for content it does not understand, instead of guessing', () => {
    // The improvement over the union: a foreign document's resource used to
    // fail `spatialNodeSchema` and take its whole node with it. Unreadable
    // content is now a node that survives and says so.
    expect(resourceKind({ mimeType: 'application/x-foreign' })).toBeUndefined()
  })

  /**
   * Order-independence is the property that lets `resourceKind` be a plain
   * lookup rather than a chain whose order is load-bearing. Mutation-checked:
   * widening text's matcher to any `text/markdown` makes this red, because a
   * markdown FILE then matches two kinds.
   */
  fcTest.prop(
    [
      fc.record(
        {
          mimeType: fc.constantFrom(
            'text/markdown',
            'text/uri-list',
            'image/png',
            'application/x-foreign',
          ),
          content: fc.option(fc.string(), { nil: undefined }),
          location: fc.option(fc.string(), { nil: undefined }),
        },
        { requiredKeys: ['mimeType'] },
      ),
    ],
    withDefaults({ numRuns: 300 }),
  )('at most one kind claims any resource', (resource) => {
    const claimed = KIND_IDS.filter((id) => RESOURCE_KINDS[id].matches(resource as NodeResource))
    expect(claimed.length).toBeLessThanOrEqual(1)
    expect(resourceKind(resource as NodeResource)).toBe(claimed[0])
  })

  it('every kind in the table is reachable by some resource', () => {
    // A matcher nothing can satisfy is a row that reads as covered and is not.
    const reached = new Set(
      [
        { mimeType: 'text/markdown', content: '' },
        { mimeType: 'text/uri-list', location: 'https://x' },
        { mimeType: 'image/png', location: 'a.png' },
      ].map((r) => resourceKind(r)),
    )
    expect([...reached].sort()).toEqual([...KIND_IDS].sort())
  })

  it('the stored shape refuses a key it does not name', () => {
    expect(nodeResourceSchema.safeParse({ mimeType: 'text/markdown', kind: 'text' }).success).toBe(
      false,
    )
  })

  /**
   * The claim the registry exists for, pinned where it is made rather than
   * asserted in prose: the exhaustiveness the node-kind union gave is still
   * here, at COMPILE time, in both directions.
   */
  it('a reader that names every kind compiles, and one that misses a kind does not', () => {
    const searchable = {
      text: (r: NodeResource) => r.content,
      link: (r: NodeResource) => r.location,
      file: () => undefined,
    } satisfies Record<ResourceKind, (resource: NodeResource) => string | undefined>

    // `file` is missing. Adding a fourth kind to the table breaks every
    // reader written this way, which is the guard the union used to give
    // through `switch` + `never`. The directive sits on the `satisfies`
    // clause because that is where the error lands — on the assertion, not on
    // the literal.
    const incomplete = {
      text: (r: NodeResource) => r.content,
      link: (r: NodeResource) => r.location,
      // @ts-expect-error a reader that misses a kind must not compile
    } satisfies Record<ResourceKind, (resource: NodeResource) => string | undefined>

    // And a switch still narrows to `never`, because `ResourceKind` is a
    // closed union derived from the table.
    const label = (kind: ResourceKind): string => {
      switch (kind) {
        case 'text':
          return 'text'
        case 'link':
          return 'link'
        case 'file':
          return 'file'
        default: {
          const unreached: never = kind
          return unreached
        }
      }
    }

    expect(searchable.text({ mimeType: 'text/markdown', content: 'a' })).toBe('a')
    expect(Object.keys(incomplete)).toHaveLength(2)
    expect(KIND_IDS.map(label).sort()).toEqual([...KIND_IDS].sort())
  })
})
