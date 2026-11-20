/**
 * What a consumer of a workspace record may do through `RecordOps`, held over
 * BOTH kinds: a keeper written once over the seam must see the same refusals,
 * the same since-reads and the same past views whichever holds the record.
 */
import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { createCrdtEngine } from './engine/engine.js'
import { leaseKind } from './engine/lease-kind.js'
import { leaseOps } from './engine/lease-ops.js'
import { loroDocKind } from './legacy-record-kind.js'
import { legacyRecordOps } from './legacy-record-ops.js'
import { writeMarkdownBody } from './markdown-body.js'
import type { RecordKind } from './record-kind.js'
import { bindRecordOps, type RecordOps } from './record-ops.js'
import {
  BOARD,
  documentNode,
  NOTE,
  seedRecord,
} from './test-utils/crdt-engine-conformance-workspace-sync.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  importWorkspaceSubtree,
  readWorkspaceDocuments,
} from './workspace-tree.js'

const engine = createCrdtEngine()

interface Held<R> {
  readonly name: string
  readonly kind: RecordKind<R>
  readonly ops: RecordOps<R>
}

const KINDS: Array<Held<unknown>> = [
  { name: 'a LoroDoc', kind: loroDocKind, ops: legacyRecordOps },
  { name: 'an engine lease', kind: leaseKind(() => Promise.resolve(engine)), ops: leaseOps },
] as Array<Held<unknown>>

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

/** One history every record and every client starts from, so an update's dependencies exist. */
const SEED = seedRecord()
const seedSnapshot = () => new Uint8Array(SEED.export({ mode: 'snapshot' }))

/** The update a client holding the seed record sends after `edit`. */
function updateFrom(edit: (client: LoroDoc) => void): Uint8Array {
  const client = SEED.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

/** An update that builds on a change the record has never been sent. */
function updateBuildingOnAMissingOne(): Uint8Array {
  const client = SEED.fork()
  documentNode(client, NOTE).data.set('name', 'one')
  client.commit()
  const middle = client.oplogVersion()
  documentNode(client, NOTE).data.set('name', 'two')
  client.commit()
  return client.export({ mode: 'update', from: middle })
}

/** An update writing a text run past the bound the text judge holds. */
const oversizedBody = () =>
  updateFrom((c) => documentContainers(c, NOTE).getText('body').insert(0, 'y'.repeat(2_000_000)))

const CASES: ReadonlyArray<{ title: string; update: () => Uint8Array }> = [
  {
    title: 'a rename',
    update: () => updateFrom((c) => documentNode(c, NOTE).data.set('name', 'N')),
  },
  {
    title: 'a path the grammar refuses',
    update: () => updateFrom((c) => documentNode(c, NOTE).data.set('segment', 'not a segment')),
  },
  { title: 'an update with a causal gap', update: updateBuildingOnAMissingOne },
]

/** One record per kind from the same seed snapshot, released after `fn`. */
async function onEachKind(
  fn: <R>(held: Held<R>, record: R) => Promise<void> | void,
): Promise<void> {
  const snapshot = seedSnapshot()
  for (const held of KINDS) {
    const record = await held.kind.load(snapshot, [])
    try {
      await fn(held, record)
    } finally {
      held.kind.release(record)
    }
  }
}

function onEachKindOutcome(judge: wire.ImportJudge, update: Uint8Array) {
  return Promise.all(KINDS.map((held) => outcomeOf(held, update, judge)))
}

async function outcomeOf<R>(
  held: Held<R>,
  update: Uint8Array,
  judge: wire.ImportJudge = 'workspace-sync',
) {
  const snapshot = seedSnapshot()
  const record = await held.kind.load(snapshot, [])
  try {
    const result = held.ops.importJudged(record, update, judge)
    return result.outcome === 'refused'
      ? { outcome: result.outcome, shape: result.breach.shape, detail: result.breach.detail }
      : { outcome: result.outcome, changed: result.changed }
  } finally {
    held.kind.release(record)
  }
}

describe('a judged workspace-sync import through RecordOps', () => {
  for (const { title, update } of CASES) {
    it(`answers ${title} the same on every kind`, async () => {
      const bytes = update()
      const answers = await Promise.all(KINDS.map((held) => outcomeOf(held, bytes)))
      expect(answers[0]).toEqual(answers[1])
    })
  }

  for (const judge of ['text', 'workspace-sync'] as const) {
    it(`refuses a text run past the bound under the ${judge} judge on every kind`, async () => {
      const refused = await onEachKindOutcome(judge, oversizedBody())
      expect(refused.map((answer) => answer.outcome)).toEqual(['refused', 'refused'])
      expect(refused[0]).toEqual(refused[1])
    }, 30_000)
  }

  it('leaves placement to the workspace-sync judge: a path the grammar refuses passes the text judge', async () => {
    const bytes = CASES[1]?.update() as Uint8Array
    const answers = await onEachKindOutcome('text', bytes)
    expect(answers.map((answer) => answer.outcome)).toEqual(['applied', 'applied'])
  })

  it("answers the rename as applied and each refusal with the judge's own shape", async () => {
    const answers = await Promise.all(
      CASES.map(({ update }) => outcomeOf(KINDS[1] as Held<unknown>, update())),
    )
    expect(answers.map((answer) => ('shape' in answer ? answer.shape : answer.outcome))).toEqual([
      'applied',
      'invalid-path',
      'causal-gap',
    ])
  })

  it('reads what an applied update touched from the version it was applied at', async () => {
    await onEachKind(async (held, record) => {
      const since = held.ops.versionOf(record).entries.map(({ peer, counter }) => [peer, counter])
      const body = updateFrom((c) => writeMarkdownBody(documentContainers(c, NOTE), 'hello'))
      held.ops.importJudged(record, body, 'workspace-sync')
      const touched = await held.ops.read(
        record,
        { query: 'touchedSince', args: { since } } as wire.Query,
        { parse: (value) => value as Array<{ documentId: string }> },
      )
      expect(touched.map(({ documentId }) => documentId)).toEqual([NOTE])
      const now = held.ops.readNow(
        record,
        { query: 'touchedSince', args: { since } } as wire.Query,
        {
          parse: (value) => value as typeof touched,
        },
      )
      expect(now).toEqual(touched)
    })
  })
})

describe('a batch of writes through RecordOps', () => {
  it('commits as one change and answers the update it made', async () => {
    await onEachKind(async (held, record) => {
      const result = held.ops.write(record, [
        { op: 'setWorkspaceDocumentName', args: { documentId: BOARD, name: 'Board' } },
      ])
      expect(result.localUpdate).toBeDefined()
      const documents = await held.ops.read(
        record,
        { query: 'documents' },
        {
          parse: (value) => value as Array<{ documentId: string; name?: string }>,
        },
      )
      expect(documents.find((entry) => entry.documentId === BOARD)?.name).toBe('Board')
    })
  })

  it('answers no update for a batch that changes nothing', async () => {
    await onEachKind((held, record) => {
      const result = held.ops.write(record, [])
      expect(result).toMatchObject({ outcome: 'applied', changed: [] })
      expect(result.localUpdate).toBeUndefined()
    })
  })
})

describe('a past view through RecordOps', () => {
  it('reads the record as it stood, and moves to the head and back', async () => {
    await onEachKind(async (held, record) => {
      const then = held.ops.versionOf(record).encodedFrontiers
      held.ops.write(record, [
        { op: 'setWorkspaceDocumentName', args: { documentId: BOARD, name: 'Board' } },
      ])
      const now = held.ops.versionOf(record).encodedFrontiers
      const nameIn = async (r: typeof record) =>
        (
          await held.ops.read(
            r,
            { query: 'documents' },
            {
              parse: (value) => value as Array<{ documentId: string; name?: string }>,
            },
          )
        ).find((entry) => entry.documentId === BOARD)?.name
      const view = held.ops.viewAt(record, then)
      try {
        expect(await nameIn(view)).toBeUndefined()
        held.ops.moveView(view, now)
        expect(await nameIn(view)).toBe('Board')
        held.ops.moveView(view, then)
        expect(await nameIn(view)).toBeUndefined()
      } finally {
        held.kind.release(view)
      }
      expect(await nameIn(record)).toBe('Board')
    })
  })
})

describe('a projection exported through RecordOps', () => {
  it('opens to the same content on every kind, and is null for a document the record lacks', async () => {
    const contents: unknown[] = []
    await onEachKind((held, record) => {
      const bytes = held.ops.exportProjection(record, NOTE)
      expect(bytes).not.toBeNull()
      const projected = new LoroDoc()
      projected.import(bytes as Uint8Array)
      contents.push(projected.toJSON())
      expect(held.ops.exportProjection(record, '01BRWAAAAAAAAAAAAAAAAAAAZZ')).toBeNull()
    })
    expect(contents).toHaveLength(2)
    expect(contents[0]).toEqual(contents[1])
  })

  it('exports the same bytes as a snapshot of the record when asked through the kind', async () => {
    await onEachKind((held, record) => {
      expect(base64(held.kind.exportSnapshot(record)).length).toBeGreaterThan(0)
    })
  })
})

const D1 = '01J000000000000000000000D1'
const D2 = '01J000000000000000000000D2'
const D3 = '01J000000000000000000000D3'

type Step = { op: string; args: Record<string, unknown> }
const create = (path: string, documentId: string): Step => ({
  op: 'createWorkspaceDocumentAtPath',
  args: { path, documentId, kind: 'markdown' },
})
const remove = (path: string): Step => ({ op: 'deleteWorkspaceNodeAtPath', args: { path } })
const move = (from: string, to: string): Step => ({
  op: 'moveWorkspaceNodeToPath',
  args: { from, to },
})

/** What the evacuation of `after` over a record built from `seed` comes to, per kind. */
async function evacuated(seed: Step[], after: Step[]) {
  const answers: unknown[] = []
  const bytesPerKind: Uint8Array[][] = []
  const empty = new Uint8Array(await engineEmptySnapshot())
  for (const held of KINDS) {
    const record = await held.kind.load(empty, [])
    try {
      held.ops.write(record, seed as never)
      const since = held.ops.versionOf(record).entries
      held.ops.write(record, after as never)
      const removed = held.ops.removedSince(record, since)
      bytesPerKind.push(removed.map((entry) => entry.bytes))
      answers.push(removed.map(({ bytes, ...rest }) => ({ ...rest, holds: documentIdsIn(bytes) })))
    } finally {
      held.kind.release(record)
    }
  }
  return { answers, bytesPerKind }
}

async function engineEmptySnapshot(): Promise<Uint8Array> {
  const record = await loroDocKind.empty()
  return loroDocKind.exportSnapshot(record)
}

function documentIdsIn(bytes: Uint8Array): string[] {
  const doc = new LoroDoc()
  doc.import(bytes)
  return readWorkspaceDocuments(doc)
    .map((entry) => entry.documentId)
    .sort()
}

describe('the documents removed since a version, through RecordOps', () => {
  const CASES: ReadonlyArray<{
    title: string
    seed: Step[]
    after: Step[]
    removed: Array<{ documentId: string; holds: string[] }>
  }> = [
    {
      title: 'a document removed from a folder that stays',
      seed: [create('folder/a', D1), create('folder/b', D2)],
      after: [remove('folder/a')],
      removed: [{ documentId: D1, holds: [D1] }],
    },
    {
      title: 'a document below a removed one, which rides its bytes',
      seed: [create('a', D1), create('a/b', D2)],
      after: [remove('a')],
      removed: [{ documentId: D1, holds: [D1, D2] }],
    },
    {
      title: 'a survivor moved out of a removed document, cut from its bytes',
      seed: [create('a', D1), create('a/b', D2)],
      after: [move('a/b', 'kept'), remove('a')],
      removed: [{ documentId: D1, holds: [D1] }],
    },
    {
      title: 'several removals in one update, deepest first',
      seed: [create('p', D1), create('q/r', D2), create('s', D3)],
      after: [remove('p'), remove('q/r')],
      removed: [
        { documentId: D2, holds: [D2] },
        { documentId: D1, holds: [D1] },
      ],
    },
    {
      title: 'nothing removed',
      seed: [create('a', D1)],
      after: [move('a', 'b')],
      removed: [],
    },
  ]

  for (const { title, seed, after, removed } of CASES) {
    it(`answers ${title} alike on every kind`, async () => {
      const { answers } = await evacuated(seed, after)
      expect(answers[0]).toEqual(answers[1])
      const seen = (answers[0] as Array<{ documentId: string; holds: string[] }>).map(
        ({ documentId, holds }) => ({ documentId, holds }),
      )
      expect(seen).toEqual(removed)
    })
  }

  it('restores a survivor-cutting evacuee without a second copy of the survivor', async () => {
    const { bytesPerKind } = await evacuated(
      [create('a', D1), create('a/b', D2)],
      [move('a/b', 'kept'), remove('a')],
    )
    for (const [evacuee] of bytesPerKind) {
      const live = new LoroDoc()
      createWorkspaceDocumentAtPath(live, { path: 'kept', documentId: D2, kind: 'markdown' })
      importWorkspaceSubtree(live, evacuee as Uint8Array)
      const ids = readWorkspaceDocuments(live).map((entry) => entry.documentId)
      expect(ids.sort()).toEqual([D1, D2])
    }

describe('a record bound to its operations and its save', () => {
  it('saves the record the session wrote to, and answers its own version and reads', async () => {
    await onEachKind(async (held, record) => {
      const saved: unknown[] = []
      const session = bindRecordOps(held.ops, record, async (each) => {
        saved.push(each)
      })
      const before = session.version().encoded
      session.write([
        { op: 'setWorkspaceDocumentName', args: { documentId: BOARD, name: 'Board' } },
      ])
      await session.save()
      expect(saved).toEqual([record])
      expect(session.version().encoded).not.toEqual(before)
      const documents = session.readNow(
        { query: 'documents' },
        {
          parse: (value) => value as Array<{ documentId: string; name?: string }>,
        },
      )
      expect(documents.find((entry) => entry.documentId === BOARD)?.name).toBe('Board')
    })
  })
})
