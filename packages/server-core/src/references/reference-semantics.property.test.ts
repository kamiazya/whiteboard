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
 * The token scanner (codec's scanReferences) is deliberately shared with
 * the SUT: the bracket grammar is not under test here. Aggregation and
 * resolution — the semantics this file exists for — are written out
 * independently below.
 */
import { scanReferences } from '@kamiazya/whiteboard-codec'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { computeBacklinks } from '../tools/backlinks.js'
import { createCanvasEditTool } from '../tools/canvas-edit.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { createDocumentSearchTool } from '../tools/document-search.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import { computeDocumentTags } from '../tools/document-tags.js'
import { ContentFactsCache } from './content-facts-cache.js'

const WS = 'ws-pbt'
const PATHS = ['alpha', 'beta', 'gamma', 'delta'] as const
const NAMES = ['Plan', 'Note'] as const
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
const aliasArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant<string>('Plan') },
  { weight: 1, arbitrary: fc.constantFrom<string>(...NAMES, ...PATHS) },
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
    weight: 2,
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

  /** The reader's alias table: one entry per path + one per display name. */
  private resolveAlias(alias: string): string | null {
    let found: string | null = null
    let hits = 0
    for (const d of this.docs.values()) {
      if (d.path === alias) {
        hits++
        found = d.id
      }
      if (d.name === alias) {
        hits++
        found = d.id
      }
    }
    return hits === 1 ? found : null
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
            if (doc.path === cmd.to) break // real moveDocument refuses from===to? skip both ways
            if (model.byPath(cmd.to) !== undefined) {
              await expect(
                deps.documentIndex.moveDocument({ workspaceId: WS, from: doc.path, to: cmd.to }),
              ).rejects.toThrow()
              break
            }
            await deps.documentIndex.moveDocument({ workspaceId: WS, from: doc.path, to: cmd.to })
            doc.path = cmd.to
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
            await deps.documentIndex.deleteDocument({ workspaceId: WS, path: doc.path })
            model.docs.delete(doc.id)
            break
          }
        }

        // After EVERY command: the CACHED pipeline agrees with the model,
        // and byte-for-byte with a fresh full scan (backlinks AND mentions).
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
  )
})
