/**
 * Command-based model test for cross-document reference semantics.
 *
 * The MODEL is an independent naive recomputation over plain objects; the
 * SUT is the real pipeline (real tools -> stores -> computeBacklinks). Any
 * command interleaving — creates, body writes, canvas edits, path renames,
 * display-name changes, deletes — must leave the two agreeing on WHO links
 * WHOM, including the cases that make cross-Loro-boundary references hard:
 * a name collision introduced by a THIRD document, a rename that revives a
 * dangling path link, and a delete that takes its outgoing refs with it.
 *
 * A path move also carries the FOLLOW pass, exactly as the daemon's route
 * runs it (movesForPathChange -> followReferencesAfterRename), and the model
 * rewrites its own tokens by an independent naive plan — so follow semantics
 * hold under any interleaving, not just the single-move example tests.
 *
 * The token scanner (codec's scanReferences) is deliberately shared with
 * the SUT: the bracket grammar is not under test here. Aggregation and
 * resolution — the semantics this file exists for — are written out
 * independently below.
 */
import { movesForPathChange, scanReferences } from '@kamiazya/whiteboard-codec'
import { readMarkdownBody, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentId } from '@kamiazya/whiteboard-model'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { computeBacklinks } from '../tools/backlinks.js'
import { createCanvasEditTool } from '../tools/canvas-edit.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { loadOrCreateDocument } from '../tools/document-io.js'
import { createDocumentSearchTool } from '../tools/document-search.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import { computeDocumentTags } from '../tools/document-tags.js'
import { ContentFactsCache } from './content-facts-cache.js'
import { followReferencesAfterRename } from './follow-rename.js'

const WS = 'ws-pbt'
const PATHS = ['alpha', 'alpha/leaf', 'beta', 'beta/leaf', 'gamma'] as const
// 'beta/leaf' as a NAME collides with a path in the pool — and must change
// nothing anywhere, because display names are retired from resolution.
const NAMES = ['Plan', 'Note', 'beta/leaf'] as const
const SLOTS = [0, 1, 2] as const

// ---------------------------------------------------------------- commands

type Cmd =
  | {
      t: 'create'
      slot: number
      path: (typeof PATHS)[number]
      kind: 'markdown' | 'spatial'
      name?: (typeof NAMES)[number]
    }
  | { t: 'writeBody'; slot: number; tokens: readonly Token[] }
  | { t: 'canvasEdit'; slot: number; node: CanvasNodeCmd }
  | { t: 'renamePath'; slot: number; to: (typeof PATHS)[number] }
  | { t: 'setName'; slot: number; name?: (typeof NAMES)[number] }
  | { t: 'delete'; slot: number }

type Token = { k: 'id'; slot: number } | { k: 'name'; text: string } // a NAMES entry or a PATHS entry — reader treats both as aliases

type CanvasNodeCmd =
  | { k: 'embed'; slot: number }
  | { k: 'file'; file: (typeof PATHS)[number] }
  | { k: 'text'; tokens: readonly Token[] }

const slotArb = fc.constantFrom(...SLOTS)
// Aliases are weighted toward ONE name ('Plan') on purpose: the interesting
// resolution states are collisions (two docs claiming an alias) and their
// undoing, and a uniform pool reaches them too rarely — the last-wins
// mutation of the ambiguity rule SURVIVED this property until the
// distribution was skewed this way. Density, not numRuns (AGENTS.md).
// ... and toward PATH aliases with equal weight since the follow pass
// landed: a moved document only drags references written as its PATH, so a
// name-heavy pool never reaches the states the follow plan decides.
// Measured: with paths at weight 1-in-8, a no-op'd followReferencesAfterRename
// SURVIVED this property at numRuns 40.
const aliasArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant<string>('Plan') },
  { weight: 2, arbitrary: fc.constantFrom<string>(...PATHS) },
  { weight: 1, arbitrary: fc.constantFrom<string>(...NAMES) },
)
const tokenArb: fc.Arbitrary<Token> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ k: fc.constant('id' as const), slot: slotArb }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('name' as const), text: aliasArb }) },
)
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record(
      {
        t: fc.constant('create' as const),
        slot: slotArb,
        path: fc.constantFrom(...PATHS),
        // markdown-heavy: wikilink resolution is where the hard states live
        kind: fc.oneof(
          { weight: 3, arbitrary: fc.constant('markdown' as const) },
          { weight: 1, arbitrary: fc.constant('spatial' as const) },
        ),
        name: fc.oneof(
          { weight: 3, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>('Plan') },
          { weight: 1, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>('Note') },
          { weight: 1, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>('beta/leaf') },
          { weight: 1, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>(undefined) },
        ),
      },
      { noNullPrototype: true },
    ),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('writeBody' as const),
      slot: slotArb,
      tokens: fc.array(tokenArb, { minLength: 1, maxLength: 3 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('canvasEdit' as const),
      slot: slotArb,
      node: fc.oneof<fc.Arbitrary<CanvasNodeCmd>[]>(
        fc.record({ k: fc.constant('embed' as const), slot: slotArb }),
        fc.record({ k: fc.constant('file' as const), file: fc.constantFrom(...PATHS) }),
        fc.record({
          k: fc.constant('text' as const),
          tokens: fc.array(tokenArb, { minLength: 1, maxLength: 2 }),
        }),
      ),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('renamePath' as const),
      slot: slotArb,
      to: fc.constantFrom(...PATHS),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('setName' as const),
      slot: slotArb,
      name: fc.oneof(
        { weight: 3, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>('Plan') },
        { weight: 1, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>('Note') },
        { weight: 1, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>('beta/leaf') },
        { weight: 1, arbitrary: fc.constant<(typeof NAMES)[number] | undefined>(undefined) },
      ),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('delete' as const), slot: slotArb }) },
)

// ------------------------------------------------------------------- model

interface ModelDoc {
  id: string
  path: string
  name?: string
  kind: 'markdown' | 'spatial'
  bodyTokens: string[] // wikilink tokens, in order
  embedIds: string[]
  fileRefs: string[]
}

class Model {
  docs = new Map<string, ModelDoc>() // by id, alive only

  byPath(path: string): ModelDoc | undefined {
    for (const d of this.docs.values()) if (d.path === path) return d
    return undefined
  }

  /**
   * The reader's alias table: PATHS only. Display names are retired from
   * resolution (path + id are the only written forms; names appear at
   * render time), so a name matching an alias must change nothing here.
   */
  private owners(alias: string): Set<string> {
    const out = new Set<string>()
    for (const d of this.docs.values()) {
      if (d.path === alias) out.add(d.id)
    }
    return out
  }

  private resolveAlias(alias: string): string | null {
    const owners = this.owners(alias)
    const [only] = owners
    return owners.size === 1 && only !== undefined ? only : null
  }

  /** Documents a subtree move at `from` carries, in listing order. */
  movedBy(from: string): ModelDoc[] {
    return [...this.docs.values()].filter((d) => d.path === from || d.path.startsWith(`${from}/`))
  }

  /**
   * The intended follow semantics, written out independently of
   * planReferenceRewrite: apply the subtree's path change, then rewrite
   * every moved path — paths are unique by the index's own constraint, so
   * the only alias question left is the reader's id-first rule: an old
   * path spelling a live document id is never rewritten, and a new path
   * spelling one falls back to the moved document's id.
   */
  followMove(from: string, to: string): void {
    const liveIds = new Set([...this.docs.values()].map((d) => d.id))
    const moved = this.movedBy(from)
    const moves = moved.map((d) => ({ id: d.id, from: d.path, to: to + d.path.slice(from.length) }))
    for (const d of moved) d.path = to + d.path.slice(from.length)
    const plan = new Map<string, string>()
    for (const m of moves) {
      if (m.to === m.from) continue
      if (liveIds.has(m.from)) continue
      plan.set(m.from, liveIds.has(m.to) ? m.id : m.to)
    }
    for (const d of this.docs.values()) {
      d.bodyTokens = d.bodyTokens.map((t) => plan.get(t) ?? t)
      d.fileRefs = d.fileRefs.map((t) => plan.get(t) ?? t)
    }
  }

  /** sourceId -> reference count into `targetId`. Independent of the SUT. */
  backlinksOf(targetId: string): Map<string, number> {
    const target = this.docs.get(targetId)
    const out = new Map<string, number>()
    if (target === undefined) return out
    const isUlid = (t: string) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(t)
    for (const d of this.docs.values()) {
      if (d.id === targetId) continue
      let n = 0
      for (const t of d.bodyTokens) {
        const resolved = isUlid(t) ? t : this.resolveAlias(t)
        if (resolved === targetId) n++
      }
      for (const id of d.embedIds) if (id === targetId) n++
      for (const f of d.fileRefs) if (f === target.path) n++
      if (n > 0) out.set(d.id, n)
    }
    return out
  }
}

// ------------------------------------------------------------------ runner

function tokenText(model: Model, slots: (string | null)[], token: Token): string | null {
  if (token.k === 'name') return token.text
  const id = slots[token.slot]
  return id !== null && id !== undefined && model.docs.has(id) ? id : null
}

describe('reference semantics under command sequences', () => {
  fcTest.prop([fc.array(cmdArb, { minLength: 1, maxLength: 12 })], withDefaults({ numRuns: 40 }))(
    'the real pipeline agrees with an independent model after every command',
    async (cmds) => {
      const deps = makeTestDeps({ documentStore: createInMemoryDocumentStore() })
      // The workspace exists because this run says so, not as a side effect of
      // whichever command happens to create first: creating one is ADR-0019's
      // MINT boundary, which keys it by a fresh ULID — and here that would
      // also make the identity depend on the generated command sequence.
      await deps.documentIndex.createWorkspace({ workspaceId: WS })
      const setTool = createDocumentSetTool(deps)
      const editTool = createCanvasEditTool(deps)
      const model = new Model()
      // ONE cache across the whole command sequence — the differential half:
      // stamp-validated incremental answers must match a fresh full scan
      // after every command, whatever interleaving of writes produced it.
      const cache = new ContentFactsCache()
      const cachedSearch = createDocumentSearchTool(deps, cache)
      // slot -> documentId of the doc created into it (dead ids stay, model ignores)
      const slots: (string | null)[] = [null, null, null]
      let nodeSeq = 0

      // Every run OPENS on the state the follow pass exists for — a document
      // and a reference spelling its path — and the commands then mutate it.
      // Without this seed the sequences almost never assemble it themselves:
      // measured at numRuns 40, zero runs held a path reference at move time,
      // and a no-op'd followReferencesAfterRename survived the property.
      const seedTarget = await wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'alpha',
        kind: 'markdown',
      })
      slots[0] = seedTarget.documentId
      model.docs.set(seedTarget.documentId, {
        id: seedTarget.documentId,
        path: 'alpha',
        kind: 'markdown',
        bodyTokens: [],
        embedIds: [],
        fileRefs: [],
      })
      const seedLeaf = await wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'alpha/leaf',
        kind: 'markdown',
      })
      model.docs.set(seedLeaf.documentId, {
        id: seedLeaf.documentId,
        path: 'alpha/leaf',
        kind: 'markdown',
        bodyTokens: [],
        embedIds: [],
        fileRefs: [],
      })
      const seedSource = await wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'gamma',
        kind: 'markdown',
      })
      slots[1] = seedSource.documentId
      // A SHADOW attempt on non-pool paths: X's path is also Y's display
      // name — and that must change NOTHING, because display names are
      // retired from resolution. '[[shadowed]]' resolves to X and follows
      // X's moves, Y's name notwithstanding. Off-pool so it never contends
      // with command traffic; X sits in slot 2 so the commands can move it.
      const seedShadowed = await wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'shadowed',
        kind: 'markdown',
      })
      slots[2] = seedShadowed.documentId
      model.docs.set(seedShadowed.documentId, {
        id: seedShadowed.documentId,
        path: 'shadowed',
        kind: 'markdown',
        bodyTokens: [],
        embedIds: [],
        fileRefs: [],
      })
      const seedShadowHolder = await wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'shadow-holder',
        kind: 'markdown',
        name: 'shadowed',
      })
      model.docs.set(seedShadowHolder.documentId, {
        id: seedShadowHolder.documentId,
        path: 'shadow-holder',
        name: 'shadowed',
        kind: 'markdown',
        bodyTokens: [],
        embedIds: [],
        fileRefs: [],
      })
      // The DESCENDANT reference makes every successful move of 'alpha'
      // exercise subtree derivation: with it absent, dropping descendants
      // from movesForPathChange survived this property.
      const seedBody =
        'mention [[alpha]] here.\nmention [[alpha/leaf]] here.\nmention [[shadowed]] here.\nmention [[Plan]] here.'
      await setTool.execute({
        workspaceId: WS,
        documentId: seedSource.documentId,
        markdown: `---\ntype: markdown\n---\n${seedBody}`,
      })
      model.docs.set(seedSource.documentId, {
        id: seedSource.documentId,
        path: 'gamma',
        kind: 'markdown',
        bodyTokens: scanReferences(seedBody).map((m) => m.target),
        embedIds: [],
        fileRefs: [],
      })

      for (const cmd of cmds) {
        switch (cmd.t) {
          case 'create': {
            if (model.byPath(cmd.path) !== undefined) {
              await expect(
                wbDocumentCreate(deps, {
                  workspaceId: WS,
                  path: cmd.path,
                  kind: cmd.kind,
                  ...(cmd.name === undefined ? {} : { name: cmd.name }),
                }),
              ).rejects.toThrow()
              break
            }
            const created = await wbDocumentCreate(deps, {
              workspaceId: WS,
              path: cmd.path,
              kind: cmd.kind,
              ...(cmd.name === undefined ? {} : { name: cmd.name }),
            })
            slots[cmd.slot] = created.documentId
            model.docs.set(created.documentId, {
              id: created.documentId,
              path: cmd.path,
              kind: cmd.kind,
              ...(cmd.name === undefined ? {} : { name: cmd.name }),
              bodyTokens: [],
              embedIds: [],
              fileRefs: [],
            })
            break
          }
          case 'writeBody': {
            const id = slots[cmd.slot]
            const doc = id === null || id === undefined ? undefined : model.docs.get(id)
            if (doc === undefined || doc.kind !== 'markdown') break
            const texts = cmd.tokens
              .map((t) => tokenText(model, slots, t))
              .filter((t): t is string => t !== null)
            const body = texts.map((t) => `mention [[${t}]] here.`).join('\n')
            await setTool.execute({
              workspaceId: WS,
              documentId: doc.id,
              markdown: `---\ntype: markdown\n---\n${body}`,
            })
            doc.bodyTokens = scanReferences(body).map((m) => m.target)
            break
          }
          case 'canvasEdit': {
            const id = slots[cmd.slot]
            const doc = id === null || id === undefined ? undefined : model.docs.get(id)
            if (doc === undefined || doc.kind !== 'spatial') break
            const nodeId = `n${nodeSeq++}`
            if (cmd.node.k === 'embed') {
              const targetId = slots[cmd.node.slot]
              if (targetId === null || targetId === undefined) break
              await editTool.execute({
                workspaceId: WS,
                documentId: doc.id,
                ops: [
                  {
                    op: 'node.add',
                    node: {
                      id: nodeId,
                      type: 'file',
                      file: 'embed-placeholder',
                      'x-whiteboard': { kind: 'embed', documentId: targetId },
                    },
                  },
                ],
              })
              doc.embedIds.push(targetId)
            } else if (cmd.node.k === 'file') {
              await editTool.execute({
                workspaceId: WS,
                documentId: doc.id,
                ops: [{ op: 'node.add', node: { id: nodeId, type: 'file', file: cmd.node.file } }],
              })
              doc.fileRefs.push(cmd.node.file)
            } else {
              const texts = cmd.node.tokens
                .map((t) => tokenText(model, slots, t))
                .filter((t): t is string => t !== null)
              const text = texts.map((t) => `see [[${t}]]`).join(' ')
              await editTool.execute({
                workspaceId: WS,
                documentId: doc.id,
                ops: [{ op: 'node.add', node: { id: nodeId, type: 'text', text } }],
              })
              doc.bodyTokens.push(...scanReferences(text).map((m) => m.target))
            }
            break
          }
          case 'renamePath': {
            const id = slots[cmd.slot]
            const doc = id === null || id === undefined ? undefined : model.docs.get(id)
            if (doc === undefined) break
            const from = doc.path
            const attempt = () =>
              deps.documentIndex.moveDocument({ workspaceId: WS, from, to: cmd.to })
            if (cmd.to === from || cmd.to.startsWith(`${from}/`)) {
              await expect(attempt()).rejects.toThrow()
              break
            }
            // A subtree move fails when any PRODUCED path is already taken
            // by a document the move does not carry.
            const movedPaths = model.movedBy(from).map((d) => d.path)
            const produced = (path: string) => cmd.to + path.slice(from.length)
            const collides = movedPaths.some((path) => {
              const holder = model.byPath(produced(path))
              return holder !== undefined && !movedPaths.includes(holder.path)
            })
            if (collides) {
              await expect(attempt()).rejects.toThrow()
              break
            }
            // The route's own glue, verbatim: list before, move, follow.
            const entriesBefore = await deps.documentIndex.listDocuments({ workspaceId: WS })
            await attempt()
            const follow = await followReferencesAfterRename(deps, {
              workspaceId: WS,
              entriesBefore,
              moves: movesForPathChange(entriesBefore, from, cmd.to),
            })
            expect(follow.failedDocumentIds).toEqual([])
            model.followMove(from, cmd.to)
            break
          }
          case 'setName': {
            const id = slots[cmd.slot]
            const doc = id === null || id === undefined ? undefined : model.docs.get(id)
            if (doc === undefined) break
            await deps.documentIndex.setDocumentName({
              workspaceId: WS,
              documentId: doc.id,
              ...(cmd.name === undefined ? {} : { name: cmd.name }),
            })
            if (cmd.name === undefined) delete doc.name
            else doc.name = cmd.name
            break
          }
          case 'delete': {
            const id = slots[cmd.slot]
            const doc = id === null || id === undefined ? undefined : model.docs.get(id)
            if (doc === undefined) break
            if (model.movedBy(doc.path).length > 1) {
              // Descendants exist — the index refuses the delete.
              await expect(
                deps.documentIndex.deleteDocument({ workspaceId: WS, path: doc.path }),
              ).rejects.toThrow()
              break
            }
            await deps.documentIndex.deleteDocument({ workspaceId: WS, path: doc.path })
            model.docs.delete(doc.id)
            break
          }
        }

        // After EVERY command: what each document SAYS agrees with the model
        // token-for-token — the follow pass rewrote exactly what the naive
        // plan says it should, and nothing else.
        for (const doc of model.docs.values()) {
          const real = await loadOrCreateDocument(deps, WS, doc.id as DocumentId)
          if (doc.kind === 'markdown') {
            expect(
              scanReferences(readMarkdownBody(real)).map((m) => m.target),
              `body tokens of ${doc.path}`,
            ).toEqual(doc.bodyTokens)
          } else {
            const canvas = readSpatialCanvas(real)
            const textTokens = canvas.nodes
              .filter((node) => node.type === 'text')
              .flatMap((node) => scanReferences(node.text).map((m) => m.target))
            expect([...textTokens].sort(), `text tokens of ${doc.path}`).toEqual(
              [...doc.bodyTokens].sort(),
            )
            const plainFiles = canvas.nodes
              .filter((node) => {
                if (node.type !== 'file') return false
                const ext = node['x-whiteboard']
                return !(ext !== undefined && 'kind' in ext && ext.kind === 'embed')
              })
              .map((node) => (node.type === 'file' ? node.file : ''))
            expect(plainFiles.sort(), `file refs of ${doc.path}`).toEqual([...doc.fileRefs].sort())
          }
        }
        // And the CACHED pipeline agrees with the model, byte-for-byte with
        // a fresh full scan (backlinks AND mentions).
        for (const doc of model.docs.values()) {
          const cached = await computeBacklinks(
            deps,
            { workspaceId: WS, documentId: doc.id },
            cache,
          )
          const fresh = await computeBacklinks(deps, { workspaceId: WS, documentId: doc.id })
          expect(cached, `cache transparency for ${doc.path}`).toEqual(fresh)
          const expected = model.backlinksOf(doc.id)
          const got = new Map(cached.backlinks.map((b) => [b.documentId, b.contexts.length]))
          expect(got, `backlinks of ${doc.path} (${doc.id})`).toEqual(expected)
        }
        if (model.docs.size > 0) {
          expect(await computeDocumentTags(deps, { workspaceId: WS }, cache)).toEqual(
            await computeDocumentTags(deps, { workspaceId: WS }),
          )
          expect(await cachedSearch.execute({ workspaceId: WS, query: 'Plan' })).toEqual(
            await createDocumentSearchTool(deps).execute({ workspaceId: WS, query: 'Plan' }),
          )
        }
      }
    },
    // Budget, not numRuns: the seeded state + per-command full-content
    // assertions price a 40-run pass at 3.5-6s on an idle machine (worst
    // observed 7.3s under load), so the 5s default reads as a property
    // failure that never happened.
    30_000,
  )
})
