/**
 * What a whole promote costs the daemon: a browser record of N markdown
 * documents merged into a fresh daemon workspace through the real store, with
 * its explicit checkpoint per document. Median of CALLS (9 by default) calls, wall milliseconds
 * (the work is synchronous apart from the store's own I/O).
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/promote-cost.mjs [documents]
 *
 * Interleave two checkouts by running this in each, alternately: a single run
 * is one process's allocation history.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { promoteWorkspace } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.ts'
import { resetDataDirForTests, setDataDirForTests } from '../../src/shared/data-dir-secure.ts'

const COUNT = Number(process.argv[2] ?? 90)
const CALLS = Number(process.env.CALLS ?? 9)
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const idOf = (prefix, i) => `${prefix}${ALPHABET[Math.floor(i / 32) % 32]}${ALPHABET[i % 32]}`
const body = (i) => `# Note ${i}\n\n${'A sentence of ordinary prose. '.repeat(60)}`

const doc = new LoroDoc()
doc.setPeerId(2n)
for (let i = 0; i < COUNT; i++) {
  const documentId = idOf('01BRWDDD0000000000000000', i)
  createWorkspaceDocumentAtPath(doc, { path: `notes/n${i}`, documentId, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, documentId), body(i))
}
doc.commit()
const snapshot = new Uint8Array(doc.export({ mode: 'snapshot' }))

const served = await mkdtemp(join(tmpdir(), 'wb-promote-cost-'))
setDataDirForTests(await mkdtemp(join(tmpdir(), 'wb-promote-cost-ambient-')))
try {
  const { serverDeps } = await bootSelfHostDeps(served)
  const times = []
  for (let call = 0; call < CALLS + 1; call++) {
    const workspaceId = idOf('01ARZ3NDEKTSV4RRFFQ69G5F', call)
    await serverDeps.documentIndex.createWorkspace({ workspaceId })
    const start = performance.now()
    const result = await promoteWorkspace(serverDeps, {
      workspaceId,
      snapshot,
      operator: { kind: 'human', displayName: 'measure' },
    })
    const took = performance.now() - start
    if (result.kind !== 'promoted') throw new Error(`not promoted: ${result.kind}`)
    // The first call pays module and engine start-up, which a daemon has paid already.
    if (call > 0) times.push(took)
  }
  times.sort((a, b) => a - b)
  console.log(`documents ${COUNT}: median ${times[Math.floor(times.length / 2)].toFixed(1)} ms`)
} finally {
  resetDataDirForTests()
}
// The store's handles keep the process alive; only a run that got here succeeded.
process.exit(0)
