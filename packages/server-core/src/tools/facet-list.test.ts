// The other half of the visibility gap: increment 6a made an agent's
// facet write visible to a human, and this makes the human's registered
// facets discoverable to an agent — which until now had to guess a key.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import {
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import {
  bundledPlugins,
  VISUAL_STENCILS_KEY,
  VISUAL_TAGS_KEY,
} from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createFacetListTool, facetListOutputSchema } from './facet-list.js'
import { STENCIL_LIBRARY_PATH } from './stencil-library.js'
import { TAG_LIBRARY_PATH } from './tag-library.js'

const planning = definePlugin({
  id: 'planning',
  displayName: 'Planning',
  facets: [
    defineFacet({
      name: 'due',
      displayName: 'Due',
      version: 'v0',
      targets: ['document', 'node'],
      schema: z.object({ date: z.string(), urgent: z.boolean().optional() }),
    }),
  ],
})

const tool = (registry = createFacetRegistry([...bundledPlugins, planning])) =>
  createFacetListTool({ facetRegistry: registry } as never)

describe('wb_facet_list', () => {
  test('answers every registered facet with the key an agent must write', async () => {
    const result = await tool().execute({})
    const keys = result.facets.map((facet) => facet.key)
    expect(keys).toContain('visual.shape/v0')
    expect(keys).toContain('visual.symbol/v0')
    expect(keys).toContain('planning.due/v0')
    // Ordered by key, so two calls agree and a diff of the output is stable.
    expect(keys).toEqual([...keys].sort())
  })

  test('each entry carries its plugin, targets and payload schema', async () => {
    const result = await tool().execute({})
    const due = result.facets.find((facet) => facet.key === 'planning.due/v0')
    if (due === undefined) throw new Error('planning.due/v0 missing from the list')
    expect(due.namespace).toBe('planning')
    expect(due.displayName).toBe('Planning')
    expect(due.targets).toEqual(['document', 'node'])
    // The schema is what makes the answer actionable: an agent can build a
    // valid payload from it rather than guessing field names.
    expect(due.schema).toMatchObject({ type: 'object' })
    const properties = (due.schema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties)).toEqual(['date', 'urgent'])
  })

  test('filters to one target when asked', async () => {
    // `visual.symbol/v0` appears under every target: a symbol answers the
    // same question of a node, a canvas and a document, so it is one facet
    // attachable to all three rather than three facets.
    const canvasOnly = await tool().execute({ target: 'canvas' })
    expect(canvasOnly.facets.map((f) => f.key)).toEqual([
      // `visual.axes/v0` is canvas-only for the reason ADR-0036 §1 gives:
      // naming a semantic axis is a statement about the whole drawing, and
      // the same sentence attached to one node says nothing a reader could
      // act on.
      'visual.axes/v0',
      'visual.edges/v0',
      'visual.symbol/v0',
      'visual.theme/v0',
    ])
    // `visual.stencils/v0` is a document facet for a reason worth reading
    // off this list: it is what makes a document a stencil LIBRARY, so it
    // attaches to the document rather than to anything drawn.
    const documentOnly = await tool().execute({ target: 'document' })
    expect(documentOnly.facets.map((f) => f.key)).toEqual([
      'planning.due/v0',
      'visual.stencils/v0',
      'visual.symbol/v0',
      // …and `visual.tags/v0` for the same reason: it is what makes a
      // document a TAG library (ADR-0040 decision 5).
      'visual.tags/v0',
    ])
  })

  /**
   * The measured gap this closes (ADR-0031's round 15, 0 of 3 trials): asked
   * to tell two things apart at once, every trial called this tool with
   * `target: 'node'` — the right question while dressing boxes — and so
   * never saw `visual.axes/v0`, which is canvas-only and is the ONE facet
   * that records what a colour MEANS. All three coloured by health and all
   * three recorded nothing, so the board drew a distinction the document
   * could not state.
   *
   * A description saying so was measured next and changed nothing (round 16,
   * still `target: 'node'` x3). This is the structural form of the same
   * repair: what the filter removes is DATA in the answer, not a sentence
   * the model may or may not act on.
   */
  test('a filtered answer still names what the other scopes hold', async () => {
    const nodeOnly = await tool(createFacetRegistry([...bundledPlugins])).execute({
      target: 'node',
    })
    expect(nodeOnly.facets.map((f) => f.key)).not.toContain('visual.axes/v0')
    // Pinned whole rather than by `toContain`, so a facet that stops being
    // reported is a failure and not a silently shorter list.
    expect(nodeOnly.otherTargets).toEqual({
      canvas: ['visual.axes/v0', 'visual.edges/v0', 'visual.theme/v0'],
      edge: ['visual.edges/v0'],
      document: ['visual.stencils/v0', 'visual.tags/v0'],
    })
    // `visual.symbol/v0` attaches to canvas, node AND document, so the
    // filter KEPT it — and it must not also be listed under its other
    // scopes. Repeating what the answer already named is what would bury
    // the entries that are genuinely missing, which is the whole point.
    expect(Object.values(nodeOnly.otherTargets ?? {}).flat()).not.toContain('visual.symbol/v0')
  })

  /**
   * Omitted rather than empty when nothing was filtered — the same rule
   * `assetRefs` follows, and for the same reason: a key present on every
   * answer is bytes that say nothing.
   */
  test('an unfiltered answer has nothing to say about elsewhere', async () => {
    const all = await tool().execute({})
    expect(all.otherTargets).toBeUndefined()
  })

  test('the output validates against its own schema', async () => {
    const result = await tool().execute({})
    expect(facetListOutputSchema.safeParse(result).success).toBe(true)
  })

  test('publishes only the targets the engine actually accepts', async () => {
    // ADR-0013 reserves `workspace`; advertising it would promise a write
    // no registry can take. `edge` is implemented and carries visual.edges.
    const result = await tool().execute({})
    const targets = new Set(result.facets.flatMap((facet) => facet.targets))
    expect([...targets].sort()).toEqual(['canvas', 'document', 'edge', 'node'])
  })

  test('a schema JSON Schema cannot express degrades to no schema, and still validates OVER THE WIRE', async () => {
    // z.toJSONSchema refuses a date (and transforms, maps, custom types), so
    // a third-party plugin can reach this. The entry must survive — the key
    // and targets are useful without a schema — and the tool's own output
    // contract must accept the result AFTER serialization, which is what
    // the MCP layer actually sends. Asserting on the in-process object alone
    // passes against a payload the wire would reject.
    const dated = definePlugin({
      id: 'legacy',
      displayName: 'Legacy',
      facets: [
        defineFacet({
          name: 'stamped',
          displayName: 'Stamped',
          version: 'v0',
          targets: ['document'],
          schema: z.object({ at: z.date() }),
        }),
      ],
    })
    const result = await tool(createFacetRegistry([dated])).execute({})
    const entry = result.facets[0]
    if (entry === undefined) throw new Error('legacy.stamped/v0 missing from the list')
    expect(entry.key).toBe('legacy.stamped/v0')
    expect(entry.targets).toEqual(['document'])
    expect(entry.schema).toBeUndefined()
    const overTheWire = JSON.parse(JSON.stringify(result))
    expect(facetListOutputSchema.safeParse(overTheWire).success).toBe(true)
  })

  test('refuses an invalid target or an unknown key, rather than answering something', async () => {
    // The MCP boundary rebuilds a non-strict validator from `.shape`, so a
    // direct server-core caller is the only one this schema's own strictness
    // protects — and an unfiltered or empty answer to a typo'd key is worse
    // than a refusal, because it looks like a result.
    await expect(tool().execute({ target: 'workspace' } as never)).rejects.toThrow()
    await expect(tool().execute({ taget: 'node' } as never)).rejects.toThrow()
  })

  test('a registry with no plugins answers an empty list, not an error', async () => {
    const result = await tool(createFacetRegistry([])).execute({})
    expect(result.facets).toEqual([])
  })
})

describe('wb_facet_list: the registered ASSETS', () => {
  // The ecosystem half of the same visibility gap (ADR-0034 decision 4). A
  // stencil, a theme and an icon set are all vocabulary a DEPLOYMENT
  // registered, and an agent had no way to learn any of them except by
  // failing a write.
  //
  // Reported here rather than enumerated in `wb_canvas_edit`'s schema, and
  // that is a measurement: an enum of stencil ids costs that tool ~38 bytes
  // per stencil per op on every turn — +4838 at 120 stencils, 13% of the
  // whole tool table — for a vocabulary most conversations never touch.
  // This answer costs nothing until somebody asks for it.
  const packed = definePlugin({
    id: 'infra',
    displayName: 'Infra',
    facets: [],
    assets: {
      stencils: {
        bucket: { displayName: 'Bucket', color: '2' },
        lambda: { displayName: 'Lambda', color: '3' },
      },
    },
  })

  test('answers the ids a write must use, namespaced, with what to call them', async () => {
    const result = await tool(createFacetRegistry([...bundledPlugins, packed])).execute({})
    const stencils = result.assets.filter((asset) => asset.kind === 'stencils')
    expect(stencils.map((asset) => asset.id)).toEqual([
      'visual.datastore',
      'visual.service',
      'visual.gateway',
      'visual.queue',
      'visual.actor',
      'visual.external',
      'infra.bucket',
      'infra.lambda',
    ])
    expect(stencils.find((asset) => asset.id === 'infra.bucket')?.displayName).toBe('Bucket')
  })

  test('drops no KIND the registry holds, since a theme is as undiscoverable as a stencil', async () => {
    // Asserted as a PROPERTY over the registry, not against a literal list
    // of kinds. The first version pinned `['stencils', 'themes']` and went
    // red the moment main registered an icon set — an exact-set assertion
    // over a surface whose whole point is that deployments extend it is
    // brittle by construction, and it failed on the merge ref rather than
    // on this branch, which is the expensive way to find out.
    const registry = createFacetRegistry([...bundledPlugins, packed])
    const result = await tool(registry).execute({})
    const reported = new Set(result.assets.map((asset) => asset.kind))
    const held = (['themes', 'icons', 'stencils'] as const).filter(
      (kind) => registry.assetIds(kind).length > 0,
    )
    expect(held.filter((kind) => !reported.has(kind))).toEqual([])
    // ...and the probe has to find something, or "drops nothing" is a pass
    // over an empty question.
    expect(held.length).toBeGreaterThan(1)
  })

  test('filters to one kind, so asking for stencils does not pay for icons', async () => {
    const result = await tool(createFacetRegistry([...bundledPlugins, packed])).execute({
      assetKind: 'stencils',
    })
    expect(result.assets.every((asset) => asset.kind === 'stencils')).toBe(true)
    // ...and the facets are still there: the filter names what to ADD, not
    // a mode that replaces the answer.
    expect(result.facets.length).toBeGreaterThan(0)
  })

  test('answers a registry with no assets as an empty list, not a missing key', async () => {
    const bare = definePlugin({ id: 'bare', displayName: 'Bare', facets: [] })
    const result = await tool(createFacetRegistry([bare])).execute({})
    expect(result.assets).toEqual([])
    // The output schema has to accept it, or the tool violates its own
    // contract exactly when a deployment ships no vocabulary.
    expect(facetListOutputSchema.safeParse(result).success).toBe(true)
  })
})

describe('wb_facet_list: a WORKSPACE’s own vocabulary', () => {
  // The half `wb_facet_list` could not answer until now (足場4b). A stencil
  // library is CONTENT — a document in the workspace — so the deployment's
  // registry cannot see it, and a model had no way to learn `workspace.*`
  // ids except by reading the library document itself. The how-to said so
  // as a known limit; this closes it.
  const LIBRARY_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
  const WORKSPACE_ID = 'ws-1'
  const OTHER_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V9'

  const withLibrary = async (stencils: Record<string, unknown> | undefined) => {
    const store = new FakeDocumentStore()
    // A workspace exists because it HOLDS something: the index throws
    // `WorkspaceNotFoundError` for one it has never seen, which is what the
    // refusal below rests on.
    await seedDoc(store, OTHER_ID, (doc) => writeDocumentKind(doc, 'markdown'))
    await registerDocumentInWorkspace(store, WORKSPACE_ID, OTHER_ID)
    if (stencils !== undefined) {
      await seedDoc(store, LIBRARY_ID, (doc) => {
        writeDocumentKind(doc, 'markdown')
        writeFacets(doc, { [VISUAL_STENCILS_KEY]: { stencils } } as never)
      })
      store.documentIndex.seed({
        workspaceId: WORKSPACE_ID,
        documentId: LIBRARY_ID,
        path: STENCIL_LIBRARY_PATH,
        kind: 'markdown',
      })
    }
    return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  }

  const lakehouse = {
    lakehouse: { displayName: 'Lakehouse', color: '3' },
    ledger: { displayName: 'Ledger', color: '6' },
  }

  test('answers the library’s stencils beside the deployment’s, under the id a write must use', async () => {
    const deps = await withLibrary(lakehouse)
    const result = await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    const stencils = result.assets.filter((asset) => asset.kind === 'stencils')
    // The deployment's six are still there — a library EXTENDS a vocabulary,
    // it does not replace one.
    expect(stencils.map((asset) => asset.id)).toEqual([
      'visual.datastore',
      'visual.service',
      'visual.gateway',
      'visual.queue',
      'visual.actor',
      'visual.external',
      'workspace.lakehouse',
      'workspace.ledger',
    ])
    const found = stencils.find((asset) => asset.id === 'workspace.lakehouse')
    expect(found?.displayName).toBe('Lakehouse')
    // `namespace` is what separates the two scopes, and it needs no field of
    // its own: the id's first segment already says which registry answered.
    expect(found?.namespace).toBe('workspace')
  })

  test('a library adds ASSETS and no facets, so the two halves stay separable', async () => {
    // The synthetic plugin carries stencils only. A library that could add a
    // FACET would be the runtime schema definition ADR-0013 decision 3
    // forbids, and this is where that would first become visible.
    const deps = await withLibrary(lakehouse)
    const withWorkspace = await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    const without = await createFacetListTool(deps).execute({})
    expect(withWorkspace.facets).toEqual(without.facets)
  })

  test('reads no library at all when no workspaceId is named', async () => {
    // The same cost decision `wb_canvas_edit` pins: finding a library is a
    // listing plus a read, and a caller asking what the DEPLOYMENT has must
    // not pay for a workspace it never mentioned.
    const deps = await withLibrary(lakehouse)
    let listings = 0
    const listDocuments = deps.documentIndex.listDocuments.bind(deps.documentIndex)
    deps.documentIndex.listDocuments = (arg) => {
      listings += 1
      return listDocuments(arg)
    }
    await createFacetListTool(deps).execute({})
    expect(listings).toBe(0)
    await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    expect(listings).toBe(1)
  })

  test('refuses a workspace that does not exist, rather than answering the deployment’s list', async () => {
    // C11, and the same rule this file already applies to a typo'd key: an
    // answer to a workspace nobody has is worse than a refusal, because
    // "the deployment's six" reads as "this workspace defines none".
    //
    // The write tools deliberately degrade here instead — they are about to
    // refuse the same id more specifically — but `workspaceId` is the only
    // thing this caller named, so there is no better refusal to make room
    // for.
    const deps = await withLibrary(lakehouse)
    await expect(
      createFacetListTool(deps).execute({ workspaceId: 'ws-nobody-made' }),
    ).rejects.toThrow(/ws-nobody-made/)
  })

  test('a workspace with no library answers the deployment’s vocabulary, not an error', async () => {
    const deps = await withLibrary(undefined)
    const result = await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    const stencils = result.assets.filter((asset) => asset.kind === 'stencils')
    expect(stencils.map((asset) => asset.id)).toEqual([
      'visual.datastore',
      'visual.service',
      'visual.gateway',
      'visual.queue',
      'visual.actor',
      'visual.external',
    ])
  })

  test('a malformed library reads as no library, so one bad document does not break discovery', async () => {
    // The read path degrades everywhere else for this reason, and discovery
    // is the surface where it matters most: a library nobody can parse must
    // not make the deployment's own vocabulary unlistable.
    const deps = await withLibrary({ 'Not A Name': { displayName: 'x' } })
    const result = await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    expect(result.assets.some((asset) => asset.namespace === 'workspace')).toBe(false)
    expect(result.assets.length).toBeGreaterThan(0)
  })

  test('the filters still narrow what a workspace added, and the output still validates', async () => {
    const deps = await withLibrary(lakehouse)
    const result = await createFacetListTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      assetKind: 'stencils',
    })
    expect(result.assets.every((asset) => asset.kind === 'stencils')).toBe(true)
    expect(result.assets.some((asset) => asset.id === 'workspace.lakehouse')).toBe(true)
    const overTheWire = JSON.parse(JSON.stringify(result))
    expect(facetListOutputSchema.safeParse(overTheWire).success).toBe(true)
  })

  /**
   * Pinned because a reading depended on it and could otherwise only INFER
   * it. Round 17's trials all passed `workspaceId`, so "the model was told
   * about `visual.axes/v0`" rests on the composed registry answering the
   * same way the deployment's own does — a superset, since a library adds
   * assets and no facets. Asserting it here makes that a guarantee rather
   * than a reading of the source.
   */
  test('a workspace-composed registry still names the canvas scope it filtered out', async () => {
    const deps = await withLibrary(lakehouse)
    const dressing = await createFacetListTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      target: 'node',
    })
    expect(dressing.facets.map((f) => f.key)).not.toContain('visual.axes/v0')
    expect(dressing.otherTargets?.canvas).toContain('visual.axes/v0')
  })
})

/**
 * The join the answer used to leave to the reader.
 *
 * The tool returns `facets` and `assets` as two lists. Each is complete on
 * its own and neither says which FIELD of which facet takes an id from
 * which kind of asset — so a model that wants to say what a box is has to
 * guess that `visual.stencil/v0`'s `stencil` field is where a `stencils`
 * asset goes.
 *
 * Measured in round 13 of the eval lane rather than argued: asked to draw a
 * flow whose steps and decisions differ, a model called this tool with
 * `assetKind: 'stencils'` — the right question — and then wrote
 * `visual.shape/v0` with `{kind: 'diamond'}`. That is a registered facet and
 * the write succeeded; it records a SILHOUETTE and not a kind, so the board
 * scored `constructs 0, excess 3`: a distinction a reader sees and the
 * document does not state. The published schema for `visual.shape/v0`
 * enumerates `diamond` outright while `visual.stencil/v0` publishes a
 * pattern-checked string, so the model picked the field it could act on.
 *
 * The registry has held `assetRefs` since assets existed. Only the answer
 * was missing it.
 */
describe('assets and facets join', () => {
  test('a facet says which of its fields names an asset, and of what kind', async () => {
    const result = await tool().execute({})
    const stencil = result.facets.find((facet) => facet.key === 'visual.stencil/v0')
    expect(stencil?.assetRefs).toEqual({ stencil: 'stencils' })

    // The other side of the join resolves: the kind it names is a kind the
    // same answer actually lists, so a model can go from field to id
    // without a second call.
    const ids = result.assets.filter((asset) => asset.kind === 'stencils').map((asset) => asset.id)
    expect(ids.length).toBeGreaterThan(0)
  })

  test('a facet that names no asset omits the key, so the join costs nothing to carry', async () => {
    const result = await tool().execute({})
    // `visual.shape/v0` is the one this finding is about: a plain enum, no
    // asset behind it. It must not grow a field that says `{}`.
    expect(result.facets.find((facet) => facet.key === 'visual.shape/v0')).not.toHaveProperty(
      'assetRefs',
    )
    expect(result.facets.find((facet) => facet.key === 'planning.due/v0')).not.toHaveProperty(
      'assetRefs',
    )
  })
})

describe('wb_facet_list: the tags a workspace already USES (ADR-0040 decision 5)', () => {
  const WORKSPACE_ID = 'ws-tags'
  const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8W1'
  const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8W2'

  const withTags = async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, NOTE_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeCoreFacets(doc, { type: 'note', tags: ['health:failing', 'Machine Learning'] })
    })
    // Seeded with its KIND: the facts extractor branches on the index entry's
    // kind, and `registerDocumentInWorkspace` registers everything as spatial.
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: NOTE_ID,
      path: 'notes/a',
      kind: 'markdown',
    })
    await seedDoc(store, BOARD_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({
            id: 'a',
            text: 'A',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            tags: ['health:failing'],
          }),
          textNode({ id: 'b', text: 'B', x: 50, y: 0, width: 10, height: 10, tags: ['health:ok'] }),
        ],
        edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, tags: ['health:failing'] }],
        tags: ['phase:design'],
      })
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: BOARD_ID,
      path: 'boards/fleet',
      kind: 'spatial',
    })
    return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  }

  test('counts every tag by what carries it, grouped by key for scoped ones', async () => {
    const deps = await withTags()
    const result = await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    expect(result.tags).toEqual([
      { tag: 'Machine Learning', documents: 1, boards: 0, nodes: 0, edges: 0 },
      {
        tag: 'health:failing',
        key: 'health',
        value: 'failing',
        documents: 1,
        boards: 0,
        nodes: 1,
        edges: 1,
      },
      { tag: 'health:ok', key: 'health', value: 'ok', documents: 0, boards: 0, nodes: 1, edges: 0 },
      {
        tag: 'phase:design',
        key: 'phase',
        value: 'design',
        documents: 0,
        boards: 1,
        nodes: 0,
        edges: 0,
      },
    ])
  })

  test('answers no tags at all without a workspaceId: a deployment has a vocabulary and no usage', async () => {
    const deps = await withTags()
    const result = await createFacetListTool(deps).execute({})
    expect(result).not.toHaveProperty('tags')
  })
})

describe('wb_facet_list and a workspace tag library (ADR-0040 decision 5)', () => {
  const WORKSPACE_ID = 'ws-tags'
  const OTHER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
  const TAGS_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
  async function withTagLibrary(declared = true) {
    const store = new FakeDocumentStore()
    await seedDoc(store, OTHER_ID, (doc) => writeDocumentKind(doc, 'markdown'))
    await registerDocumentInWorkspace(store, WORKSPACE_ID, OTHER_ID)
    if (!declared) return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
    await seedDoc(store, TAGS_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeFacets(doc, {
        [VISUAL_TAGS_KEY]: {
          keys: {
            tier: { values: { web: {}, db: { color: '2' } } },
            health: {
              description: 'Serving?',
              exclusive: true,
              values: { ok: { color: '4' }, failing: { color: '1', description: 'Paged' } },
            },
            owner: { description: 'On call' },
          },
        },
      } as never)
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: TAGS_ID,
      path: TAG_LIBRARY_PATH,
      kind: 'markdown',
    })
    return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  }

  test('answers the declared keys by name, each with its values by name, only with a workspaceId', async () => {
    const deps = await withTagLibrary()
    const result = await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    expect(result.tagLibrary).toEqual([
      {
        key: 'health',
        description: 'Serving?',
        exclusive: true,
        values: [
          { value: 'failing', color: '1', description: 'Paged' },
          { value: 'ok', color: '4' },
        ],
      },
      { key: 'owner', description: 'On call' },
      { key: 'tier', values: [{ value: 'db', color: '2' }, { value: 'web' }] },
    ])
    expect(facetListOutputSchema.safeParse(result).success).toBe(true)
    expect((await createFacetListTool(deps).execute({})).tagLibrary).toBeUndefined()
  })

  test('a workspace with no library answers an empty declaration, not an absent one', async () => {
    // Absent means "not asked"; empty means "asked, and nothing declared".
    const deps = await withTagLibrary(false)
    const result = await createFacetListTool(deps).execute({ workspaceId: WORKSPACE_ID })
    expect(result.tagLibrary).toEqual([])
  })
})
