/**
 * Writes one entry of the cross-version corpus: a workspace record built by
 * this package's own writers, exported in every mode a keeper stores or
 * ships, under the loro-crdt version installed right now.
 *
 * Run it BEFORE a loro-crdt bump, with the old version still installed, and
 * commit what it writes. The entry's `expected.json` is that version's own
 * reading of its bytes, so `cross-version-corpus.test.ts` judges the newer
 * version against an oracle the newer version had no part in producing.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../loro-adapter/scripts/write-cross-version-fixture.ts
 *
 * Peer ids and timestamps are fixed and Loro records no wall clock by
 * default, so a re-run under the same version writes the same bytes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { writeCommentThread } from '../src/comment-threads.js'
import { writeSpatialCanvas } from '../src/loro-bridge.js'
import { writeMarkdownBody } from '../src/markdown-body.js'
import { markThreadPassages } from '../src/thread-marks.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  moveWorkspaceNodeToPath,
  setWorkspaceDocumentName,
} from '../src/workspace-tree.js'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const loroVersion: string = JSON.parse(
  readFileSync(require.resolve('loro-crdt/package.json'), 'utf8'),
).version

const NOTE = '01ARZ3NDEKTSV4RRFFQ69G5F01'
const CANVAS = '01ARZ3NDEKTSV4RRFFQ69G5F02'
const FOLDER = '01ARZ3NDEKTSV4RRFFQ69G5F03'
const BODY = '# Weekly review\n\nShip the report on Friday. The draft is not written.\n'
const PASSAGE = 'report on Friday'

const a = new LoroDoc()
a.setPeerId(1n)
for (const [path, documentId, kind] of [
  ['notes/weekly', NOTE, 'markdown'],
  ['boards/plan', CANVAS, 'spatial'],
  ['archive', FOLDER, 'markdown'],
] as const) {
  if (
    createWorkspaceDocumentAtPath(a, {
      path,
      documentId,
      kind,
      createdAt: 1000,
      updatedAt: 1000,
    }) === null
  ) {
    throw new Error(`fixture path collided: ${path}`)
  }
}
writeMarkdownBody(documentContainers(a, NOTE), BODY)
writeSpatialCanvas(documentContainers(a, CANVAS), {
  nodes: [
    textNode({ id: 'n1', x: 0, y: 0, width: 160, height: 80, text: 'Collect numbers' }),
    textNode({ id: 'n2', x: 240, y: 0, width: 160, height: 80, text: 'Write the draft' }),
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
})
a.commit()

// The common ancestor a second peer starts from, and the point the corpus
// checks a historical checkout against.
const midFrontiers = a.frontiers()
const midValue = a.toJSON()

const b = new LoroDoc()
b.setPeerId(2n)
b.import(a.export({ mode: 'snapshot' }))

// Concurrent edits, so the history holds a merge and not a single line.
setWorkspaceDocumentName(a, { documentId: NOTE, name: 'Weekly' })
writeMarkdownBody(documentContainers(a, NOTE), BODY.replace('Friday', 'Friday morning'))
writeCommentThread(documentContainers(b, NOTE), {
  id: 't1',
  anchor: { kind: 'spatial', nodeId: 'n1', x: 10, y: 20 },
  status: 'open',
  messages: [{ id: 'm1', body: 'Which report?' }],
})
const at = BODY.indexOf(PASSAGE)
markThreadPassages(
  b,
  documentContainers(b, NOTE),
  new Map([['t1', { start: at, end: at + PASSAGE.length }]]),
)
b.commit()
if (!moveWorkspaceNodeToPath(b, 'boards/plan', 'archive/plan'))
  throw new Error('fixture move missed')
writeSpatialCanvas(documentContainers(b, CANVAS), {
  nodes: [textNode({ id: 'n1', x: 0, y: 120, width: 160, height: 80, text: 'Collect numbers' })],
  edges: [],
})
b.commit()

a.import(b.export({ mode: 'update', from: a.oplogVersion() }))
b.import(a.export({ mode: 'update', from: b.oplogVersion() }))
if (JSON.stringify(a.toJSON()) !== JSON.stringify(b.toJSON())) {
  throw new Error('fixture peers did not converge')
}

const out = join(here, '..', 'fixtures', 'cross-version', `loro-${loroVersion}`)
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'snapshot.bin'), a.export({ mode: 'snapshot' }))
writeFileSync(join(out, 'updates.bin'), a.export({ mode: 'update' }))
writeFileSync(
  join(out, 'shallow-snapshot.bin'),
  a.export({ mode: 'shallow-snapshot', frontiers: midFrontiers }),
)
writeFileSync(
  join(out, 'expected.json'),
  `${JSON.stringify(
    {
      loroVersion,
      value: a.toJSON(),
      frontiers: a.frontiers(),
      midFrontiers,
      midValue,
      noteBodyDelta: documentContainers(a, NOTE).getText('body').toDelta(),
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote ${out}`)
