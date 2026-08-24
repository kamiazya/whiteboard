import { serializeOkf } from '@kamiazya/whiteboard-codec'
import {
  coreFacetsArbitrary,
  extensionFacetsArbitrary,
  facetsRawArbitrary,
} from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { createDocumentSetTool } from './document-set.js'
import { exportOkf } from './export-okf.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

/**
 * YAML has no distinct `-0` literal (it round-trips through the parser as
 * `0`) — an inherent encoding ambiguity, not a bug in this tool's core-facet
 * fix. `jsonValue()`-backed `extensionFacetsArbitrary` can generate `-0`
 * inside a facet payload, so it is excluded here the same way codec's
 * own round-trip properties exclude constructs with inherent encoding
 * ambiguities (see package-codec.md).
 */
function containsNegativeZero(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0)
  if (Array.isArray(value)) return value.some(containsNegativeZero)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsNegativeZero)
  }
  return false
}

/**
 * `jsonValue()` can generate an object key literally named `__proto__`.
 * Assigning that key via bracket notation on a plain object (as every
 * plain-object-building parser here does, including js-yaml's) hits
 * `Object.prototype`'s legacy `__proto__` accessor rather than creating a
 * data property, so the value is silently dropped or coerced instead of
 * round-tripping — a JS-object-representation hazard inherent to any
 * consumer of `extensionFacetsSchema`'s `z.record(z.string(), z.unknown())`,
 * not specific to this tool's OKF/YAML path. Same exclusion class as the
 * `-0` case above.
 */
function containsProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProtoKey)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, nested]) => key === '__proto__' || containsProtoKey(nested),
    )
  }
  return false
}

// Extension facet payloads must stay yaml-safe (see codec's
// yaml-safe.ts) — jsonValue() already excludes undefined/NaN/bigint/
// function/symbol, so extensionFacetsArbitrary is already a yaml-safe
// generator; no separate "yaml-safe" arbitrary is needed here.
//
// `facetsRaw` holds the root frontmatter keys this codebase does not model —
// the OKF v0.2 families (`sources`, `generated`, `verified`, `status`,
// `stale_after`) among them. Preserving them end to end is what makes a
// document written elsewhere survive a whiteboard read-edit-write, so the
// property covers the whole chain (parse -> Loro store -> read -> serialize)
// rather than only codec's own round trip.
const okfDocumentArbitrary = fc
  .tuple(
    coreFacetsArbitrary,
    fc
      .option(extensionFacetsArbitrary, { nil: undefined })
      .filter(
        (facets) =>
          facets === undefined || (!containsNegativeZero(facets) && !containsProtoKey(facets)),
      ),
    fc.string({ maxLength: 200 }),
    fc
      .option(facetsRawArbitrary, { nil: undefined })
      .filter((raw) => raw === undefined || !containsNegativeZero(raw)),
  )
  .map(([core, facets, body, facetsRaw]) => ({
    frontmatter: {
      ...core,
      ...(facets === undefined ? {} : { facets }),
      ...(facetsRaw === undefined ? {} : { facetsRaw }),
    },
    body,
  }))

async function setupTools() {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const deps = {
    documentStore: store,
    blobStore: {} as never,
    documentIndex: store.documentIndex,
    documentTeardown: unusedDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  }
  return {
    deps,
    documentSet: createDocumentSetTool(deps),
  }
}

describe('wb_document_set -> the OKF exporter round-trip property', () => {
  fcTest.prop([okfDocumentArbitrary], withDefaults({ numRuns: 50 }))(
    'export(import(x)).frontmatter equals x.frontmatter up to canonical facet-key ordering, body verbatim',
    async (doc) => {
      const { documentSet, deps } = await setupTools()
      const markdown = serializeOkf(doc)

      await documentSet.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, markdown })
      const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

      expect(result.frontmatter.type).toBe(doc.frontmatter.type)
      // Not verbatim: the name lives on the workspace now, and a blank name
      // is no name (they are one state by design), so the round trip
      // normalises a whitespace-only title to absent. Everything else about
      // the title is still verbatim — AGENTS.md allows a round-trip property
      // to assert a well-defined normalisation, not a weaker equality.
      const submittedTitle = doc.frontmatter.title
      const expectedTitle =
        submittedTitle === undefined || submittedTitle.trim() === ''
          ? undefined
          : submittedTitle.trim()
      expect(result.frontmatter.title).toBe(expectedTitle)
      expect(result.frontmatter.tags).toEqual(doc.frontmatter.tags)
      expect(result.frontmatter.view).toBe(doc.frontmatter.view)
      const expectedFacets = 'facets' in doc.frontmatter ? doc.frontmatter.facets : {}
      expect(result.frontmatter.facets).toEqual(expectedFacets)
      // An empty bucket contributes no root keys, so nothing distinguishes it
      // on the way back from having had none.
      const submittedRaw = doc.frontmatter.facetsRaw
      const expectedRaw =
        submittedRaw === undefined || Object.keys(submittedRaw).length === 0
          ? undefined
          : submittedRaw
      expect(result.frontmatter.facetsRaw).toEqual(expectedRaw)
      expect(result.markdown).toContain(doc.body)
    },
  )
})
