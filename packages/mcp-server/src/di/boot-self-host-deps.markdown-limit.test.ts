/**
 * The cost of the largest markdown write the contract accepts, through the real
 * store (libsql, the workspace record, the CRDT merge) rather than an
 * in-memory one.
 *
 * `MARKDOWN_MAX_CHARS` is sized from a measurement, and the cost behind it is
 * QUADRATIC in the text (a text insert imported into a non-empty Loro document),
 * so a limit raised "a little" quadruples the time one write blocks the daemon.
 * Nothing but a timing over the real merge can see that: the schema test
 * checks the refusal and passes at any value.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disposeAutoCompact, uninstallAutoCompact } from '../server/store/auto-compact.js'
import { clearDbCacheForTests, closeDb } from '../server/store/db/index.js'
import { clearDocCacheForTests } from '../server/store/doc-cache.js'
import { _clearWorkspaceDocCacheForTests } from '../server/store/workspace-doc-cache.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { bootSelfHostDeps } from './boot-self-host-deps.js'

/**
 * CPU milliseconds one limit-sized create may spend. Measured on a 4-core
 * machine at load average ~14: 0.86-0.94 s for the create at 256 Ki
 * characters in paragraphs and in one line, 1.36 s for the first create in a
 * process (module and WASM warm-up). The budget is ~6x the steady reading, so
 * a runner several times slower still passes, while a limit raised 4x costs
 * ~16x as much and 8x ~64x (a 2 MiB paragraph body measured 97 CPU-seconds).
 *
 * CPU rather than wall time: the work is one synchronous WASM call, so CPU
 * time is the work and wall time is the work plus whoever else is running.
 */
const CREATE_CPU_BUDGET_MS = 6000

/** Prose-shaped, since that is what a limit-sized document would really hold. */
function proseOfLength(length: number): string {
  const paragraph = `${'The quick brown fox jumps over the lazy dog. '.repeat(20)}\n\n`
  return paragraph.repeat(Math.ceil(length / paragraph.length)).slice(0, length)
}

let served: string
let ambient: string

beforeEach(async () => {
  served = await mkdtemp(join(tmpdir(), 'wb-served-'))
  ambient = await mkdtemp(join(tmpdir(), 'wb-ambient-'))
  setDataDirForTests(ambient)
})

afterEach(async () => {
  uninstallAutoCompact()
  await disposeAutoCompact()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await closeDb(served)
  clearDbCacheForTests()
  resetDataDirForTests()
  vi.useRealTimers()
  await rm(served, { recursive: true, force: true })
  await rm(ambient, { recursive: true, force: true })
})

describe('a markdown document of exactly the declared limit, over the real store', () => {
  it('is created within the CPU budget', async () => {
    const { serverDeps: deps } = await bootSelfHostDeps(served)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const markdown = proseOfLength(MARKDOWN_MAX_CHARS)
    expect(markdown).toHaveLength(MARKDOWN_MAX_CHARS)

    const before = process.cpuUsage()
    const created = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: 'big',
      kind: 'markdown',
      markdown,
    })
    const spent = process.cpuUsage(before)
    const cpuMs = (spent.user + spent.system) / 1000

    expect(created.documentId).toBeTruthy()
    expect((await deps.liveDocuments.list('ws-1')).map((entry) => entry.path)).toEqual(['big'])
    expect(cpuMs).toBeLessThan(CREATE_CPU_BUDGET_MS)
  }, 30_000)
})
