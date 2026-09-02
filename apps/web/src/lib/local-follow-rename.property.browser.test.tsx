/**
 * Command-sequence model test for the BROWSER keeper's follow pass — the
 * parity half of server-core's reference-semantics property: both keepers
 * are held to one independent naive model of the follow semantics, so they
 * cannot disagree with each other without one of them disagreeing with it.
 *
 * Markdown-only and small on purpose: this runs against real IndexedDB,
 * where shrinking is slow, so the semantic depth (spatial nodes, subtree
 * collisions, ambiguity clusters) lives in the daemon-side property and the
 * example tests. What THIS one pins is the browser wiring: entriesBefore
 * taken on the right side of the mutation, the plan applied to every
 * candidate, the rewrite persisted.
 */

import { scanReferences } from '@kamiazya/whiteboard-codec'
import {
  readMarkdownBody,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { createLocalFilesSource } from './local-files-source.js'
import { LoroStore } from './loro-store.js'

claimIsolatedWhiteboardDb('local-follow-rename-property')

const SLOTS = [0, 1, 2] as const
// Suffixes; every run prefixes them, so runs sharing one IndexedDB cannot
// claim each other's aliases (the plan is computed over the whole listing).
const PATHS = ['alpha', 'alpha/leaf', 'beta', 'gamma'] as const

type Cmd =
  | { t: 'create'; slot: number; path: (typeof PATHS)[number]; name?: 'Plan' }
  | { t: 'writeBody'; slot: number; refs: readonly (typeof PATHS | string)[number][] }
  | { t: 'move'; slot: number; to: (typeof PATHS)[number] }
  | { t: 'setName'; slot: number; name?: 'Plan' }

const slotArb = fc.constantFrom(...SLOTS)
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('create' as const),
      slot: slotArb,
      path: fc.constantFrom(...PATHS),
      name: fc.constantFrom<'Plan' | undefined>('Plan', undefined),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('writeBody' as const),
      slot: slotArb,
      refs: fc.array(fc.constantFrom<string>(...PATHS, 'Plan'), { minLength: 1, maxLength: 2 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('move' as const),
      slot: slotArb,
      to: fc.constantFrom(...PATHS),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('setName' as const),
      slot: slotArb,
      name: fc.constantFrom<'Plan' | undefined>('Plan', undefined),
    }),
  },
)

interface ModelDoc {
  id: string
  path: string
  name?: string
  tokens: string[]
}

/** Same independent oracle as the daemon-side property, markdown-only. */
class Model {
  docs = new Map<string, ModelDoc>()

  byPath(path: string): ModelDoc | undefined {
    for (const d of this.docs.values()) if (d.path === path) return d
    return undefined
  }

  movedBy(from: string): ModelDoc[] {
    return [...this.docs.values()].filter((d) => d.path === from || d.path.startsWith(`${from}/`))
  }

  followMove(from: string, to: string): void {
    const rows = () =>
      [...this.docs.values()].map((d) => ({ id: d.id, path: d.path, name: d.name }))
    const ownersIn = (alias: string, table: { id: string; path: string; name?: string }[]) => {
      const out = new Set<string>()
      for (const r of table) if (r.path === alias || r.name === alias) out.add(r.id)
      return out
    }
    const before = rows()
    const moved = this.movedBy(from)
    const moves = moved.map((d) => ({ id: d.id, from: d.path, to: to + d.path.slice(from.length) }))
    for (const d of moved) d.path = to + d.path.slice(from.length)
    const after = rows()
    const plan = new Map<string, string>()
    for (const m of moves) {
      if (m.to === m.from) continue
      if (before.some((e) => e.id === m.from)) continue
      const ob = ownersIn(m.from, before)
      if (!(ob.size === 1 && ob.has(m.id))) continue
      const oa = ownersIn(m.to, after)
      const unique = oa.size === 1 && oa.has(m.id) && !after.some((e) => e.id === m.to)
      plan.set(m.from, unique ? m.to : m.id)
    }
    for (const d of this.docs.values()) d.tokens = d.tokens.map((t) => plan.get(t) ?? t)
  }
}

async function writeBodyOf(documentId: string, body: string): Promise<void> {
  const store = new LoroStore()
  const doc = new Loro()
  const loaded = await store.load(documentId)
  if (loaded.kind === 'ok') {
    doc.import(loaded.snapshot)
    for (const delta of loaded.deltas ?? []) doc.import(delta)
  } else {
    writeDocumentKind(doc, 'markdown')
  }
  writeMarkdownBody(doc, body)
  await store.save(documentId, doc.export({ mode: 'snapshot' }))
}

async function tokensOf(documentId: string): Promise<string[]> {
  const loaded = await new LoroStore().load(documentId)
  if (loaded.kind !== 'ok') throw new Error(`unreadable: ${loaded.kind}`)
  const doc = new Loro()
  doc.import(loaded.snapshot)
  for (const delta of loaded.deltas ?? []) doc.import(delta)
  return scanReferences(readMarkdownBody(doc)).map((m) => m.target)
}

let runSeq = 0

describe('local rename follow parity', () => {
  fcTest.prop([fc.array(cmdArb, { minLength: 1, maxLength: 6 })], withDefaults({ numRuns: 8 }))(
    'the browser keeper agrees with the naive follow model',
    async (cmds) => {
      const prefix = `pr${runSeq++}`
      const P = (suffix: string) => `${prefix}/${suffix}`
      const NAME = `Plan-${prefix}`
      const alias = (a: string) => (a === 'Plan' ? NAME : P(a))
      const index = new IdbDocumentIndex()
      await ensureLocalWorkspace(index)
      const source = createLocalFilesSource({ index })
      const model = new Model()
      const slots: (string | null)[] = [null, null, null]

      const create = async (path: string, name?: string): Promise<string> => {
        const entry = await index.createDocument({
          workspaceId: getBrowserWorkspaceId(),
          path,
          kind: 'markdown',
          ...(name === undefined ? {} : { name }),
        })
        const doc = new Loro()
        writeDocumentKind(doc, 'markdown')
        await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))
        return entry.documentId
      }

      // Seed: a target, a descendant, and a source referencing both — the
      // state the follow pass exists for (without it the sequences almost
      // never assemble one; measured daemon-side).
      const targetId = await create(P('alpha'))
      model.docs.set(targetId, { id: targetId, path: P('alpha'), tokens: [] })
      slots[0] = targetId
      const leafId = await create(P('alpha/leaf'))
      model.docs.set(leafId, { id: leafId, path: P('alpha/leaf'), tokens: [] })
      const seedBody = `see [[${P('alpha')}]] and [[${P('alpha/leaf')}]] and [[${NAME}]]`
      const sourceId = await create(P('gamma'))
      await writeBodyOf(sourceId, seedBody)
      model.docs.set(sourceId, {
        id: sourceId,
        path: P('gamma'),
        tokens: scanReferences(seedBody).map((m) => m.target),
      })
      slots[1] = sourceId

      for (const cmd of cmds) {
        switch (cmd.t) {
          case 'create': {
            if (model.byPath(P(cmd.path)) !== undefined) break
            const id = await create(P(cmd.path), cmd.name === undefined ? undefined : NAME)
            slots[cmd.slot] = id
            model.docs.set(id, {
              id,
              path: P(cmd.path),
              ...(cmd.name === undefined ? {} : { name: NAME }),
              tokens: [],
            })
            break
          }
          case 'writeBody': {
            const id = slots[cmd.slot]
            const doc = id === null ? undefined : model.docs.get(id)
            if (doc === undefined) break
            const body = cmd.refs.map((r) => `mention [[${alias(r)}]] here.`).join('\n')
            await writeBodyOf(doc.id, body)
            doc.tokens = scanReferences(body).map((m) => m.target)
            break
          }
          case 'move': {
            const id = slots[cmd.slot]
            const doc = id === null ? undefined : model.docs.get(id)
            if (doc === undefined) break
            const from = doc.path
            const to = P(cmd.to)
            // Error paths are the daemon property's job; parity only needs
            // the moves that succeed, so invalid ones are skipped up front.
            if (to === from || to.startsWith(`${from}/`)) break
            const movedPaths = model.movedBy(from).map((d) => d.path)
            const produced = (path: string) => to + path.slice(from.length)
            const collides = movedPaths.some((path) => {
              const holder = model.byPath(produced(path))
              return holder !== undefined && !movedPaths.includes(holder.path)
            })
            if (collides) break
            await source.renameDocumentPath(from, to)
            model.followMove(from, to)
            break
          }
          case 'setName': {
            const id = slots[cmd.slot]
            const doc = id === null ? undefined : model.docs.get(id)
            if (doc === undefined) break
            const entries = await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
            const entry = entries.find((e) => e.documentId === doc.id)
            if (entry === undefined) break
            await source.setDocumentName(entry, cmd.name === undefined ? undefined : NAME)
            if (cmd.name === undefined) delete doc.name
            else doc.name = NAME
            break
          }
        }

        for (const doc of model.docs.values()) {
          expect(await tokensOf(doc.id), `tokens of ${doc.path}`).toEqual(doc.tokens)
        }
      }

      // Witness epilogue: one move that ALWAYS carries a reference, on
      // off-pool paths the commands cannot disturb. The random sequences
      // alone reach a followed move only probabilistically at this budget —
      // measured: a dropped followReferences call survived a full pass.
      const wTargetId = await create(P('wtarget'))
      model.docs.set(wTargetId, { id: wTargetId, path: P('wtarget'), tokens: [] })
      const wBody = `see [[${P('wtarget')}]]`
      const wSourceId = await create(P('wsource'))
      await writeBodyOf(wSourceId, wBody)
      model.docs.set(wSourceId, {
        id: wSourceId,
        path: P('wsource'),
        tokens: scanReferences(wBody).map((m) => m.target),
      })
      await source.renameDocumentPath(P('wtarget'), P('wdest'))
      model.followMove(P('wtarget'), P('wdest'))
      for (const doc of model.docs.values()) {
        expect(await tokensOf(doc.id), `tokens of ${doc.path}`).toEqual(doc.tokens)
      }
    },
    60_000,
  )
})
