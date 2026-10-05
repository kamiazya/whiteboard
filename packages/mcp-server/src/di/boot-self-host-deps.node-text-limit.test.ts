/**
 * The cost of the largest text node the contract accepts, through the real
 * store and the daemon's real text measurer rather than an in-memory one.
 *
 * `NODE_TEXT_MAX_CHARS` is sized from a measurement of LAYOUT: a write lays
 * the text out to size its box, and that cost is linear in the text only
 * because the measurer hands the font bounded segments. A limit raised
 * several-fold, or a measurer that goes back to one whole-paragraph call into
 * the font (quadratic: 16 Ki characters measured 47 CPU-seconds), shows up
 * nowhere but in a timing over the real write. The schema tests check the
 * refusal and pass at any value.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { createCanvasEditTool, wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disposeAutoCompact, uninstallAutoCompact } from '../server/store/auto-compact.js'
import { clearDbCacheForTests, closeDb } from '../server/store/db/index.js'
import { clearDocCacheForTests } from '../server/store/doc-cache.js'
import { _clearWorkspaceDocCacheForTests } from '../server/store/workspace-doc-cache.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { bootSelfHostDeps } from './boot-self-host-deps.js'

/**
 * CPU milliseconds one limit-sized add may spend. Measured
 * (`scripts/measure/text-node-write-cost.mjs`, and this test at load average
 * ~30): ~0.65-1.25 s for prose and ~1.6-1.9 s for one unbroken run of letters
 * at 8 Ki characters, the run being the worst shape (it breaks into a line per
 * box width). The budget is ~3x the worst reading under load. What it catches
 * is a limit raised about 4x (the run read 6.1 s at 32 Ki) or a measurer that
 * hands the font whole paragraphs again (6.8 s); the exact bound on what one
 * font call receives is `measure-text.long-run.test.ts`, which no machine's
 * speed can move.
 *
 * CPU rather than wall time: the work is synchronous, so CPU time is the work
 * and wall time is the work plus whoever else is running.
 */
const ADD_CPU_BUDGET_MS = 6000

const sentence = 'Lorem ipsum dolor sit amet. '
const SHAPES: ReadonlyArray<readonly [string, (length: number) => string]> = [
  [
    'one paragraph of prose',
    (length) => sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length),
  ],
  ['one unbroken run of letters', (length) => 'x'.repeat(length)],
]

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

describe('a text node of exactly the declared limit, over the real store', () => {
  it.each(SHAPES)(
    'as %s is added within the CPU budget',
    async (_shape, textOfLength) => {
      const { serverDeps: deps } = await bootSelfHostDeps(served)
      await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
      const { documentId } = await wbDocumentCreate(deps, {
        workspaceId: 'ws-1',
        path: 'board',
        kind: 'spatial',
      })
      const text = textOfLength(NODE_TEXT_MAX_CHARS)
      expect(text).toHaveLength(NODE_TEXT_MAX_CHARS)

      const before = process.cpuUsage()
      const result = await createCanvasEditTool(deps).execute({
        workspaceId: 'ws-1',
        documentId,
        mode: 'apply',
        ops: [{ op: 'node.add', node: { type: 'text', text, width: 200 } }],
      })
      const spent = process.cpuUsage(before)
      const cpuMs = (spent.user + spent.system) / 1000

      // Sized to fit, which is the layout this budget prices: an add that never
      // measured would pass it for nothing.
      expect(result.applied).toBe(1)
      expect(result.geometry[0]?.height).toBeGreaterThan(1000)
      expect(cpuMs).toBeLessThan(ADD_CPU_BUDGET_MS)
    },
    30_000,
  )
})
