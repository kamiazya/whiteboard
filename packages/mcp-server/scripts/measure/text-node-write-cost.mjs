/**
 * What one `wb_canvas_edit` node.add of a text node costs the daemon, by the
 * length of its text — the whole write, through the real store (libsql, the
 * workspace record, the CRDT merge) and the real export measurer, which is
 * what the node-text limit is sized against.
 *
 * Run:
 *   SHAPE=paragraph|broken|word node --import tsx/esm \
 *     scripts/measure/text-node-write-cost.mjs [lengths...]
 *
 *   paragraph  prose with spaces and no blank line
 *   broken     the same prose with a paragraph break every ~560 characters
 *   word       one unbroken run of a single letter: nothing to wrap at
 *
 * The box is named a width and no height, so the write lays the text out to
 * size it, as an agent's add without a height does. Each length is written
 * to a fresh document, so no row prices the previous one's merge.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasEditTool, wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.ts'
import { setDataDirForTests } from '../../src/shared/data-dir-secure.ts'

const shape = process.env.SHAPE ?? 'paragraph'
const lengths = process.argv.slice(2).map(Number)

const sentence = 'Lorem ipsum dolor sit amet. '
function textOfLength(length) {
  if (shape === 'word') return 'x'.repeat(length)
  if (shape === 'paragraph')
    return sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length)
  let text = ''
  while (text.length < length) text += `${sentence.repeat(20)}\n\n`
  return text.slice(0, length)
}

const served = await mkdtemp(join(tmpdir(), 'wb-served-'))
const ambient = await mkdtemp(join(tmpdir(), 'wb-ambient-'))
setDataDirForTests(ambient)
const { serverDeps: deps } = await bootSelfHostDeps(served)
await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
const edit = createCanvasEditTool(deps)

console.log('shape      chars   cpu ms    wall ms  next cpu ms')
// The first row is warm-up (modules, WASM, font tables) and is not printed.
for (const [index, length] of [
  512,
  ...(lengths.length > 0 ? lengths : [4096, 16384, 65536]),
].entries()) {
  const { documentId } = await wbDocumentCreate(deps, {
    workspaceId: 'ws-1',
    path: `c${index}`,
    kind: 'spatial',
  })
  const before = process.cpuUsage()
  const started = performance.now()
  const result = await edit.execute({
    workspaceId: 'ws-1',
    documentId,
    mode: 'apply',
    ops: [{ op: 'node.add', node: { type: 'text', text: textOfLength(length), width: 200 } }],
  })
  const spent = process.cpuUsage(before)
  // A harness whose writes silently do nothing prints small, plausible numbers.
  if (result.applied !== 1) throw new Error(`length ${length}: the add did not apply`)
  const wallMs = performance.now() - started

  // What the long node costs every LATER edit of the same board: a one-word
  // add beside it, which re-reads and re-renders the board it joins.
  const nextBefore = process.cpuUsage()
  const next = await edit.execute({
    workspaceId: 'ws-1',
    documentId,
    mode: 'apply',
    ops: [{ op: 'node.add', node: { type: 'text', text: 'next' } }],
  })
  const nextSpent = process.cpuUsage(nextBefore)
  if (next.applied !== 1) throw new Error(`length ${length}: the follow-up add did not apply`)
  if (index === 0) continue
  const ms = (usage) => ((usage.user + usage.system) / 1000).toFixed(0)
  console.log(
    `${shape.padEnd(9)} ${String(length).padStart(6)} ${ms(spent).padStart(8)} ${wallMs.toFixed(0).padStart(10)} ${ms(nextSpent).padStart(12)}`,
  )
}
await rm(served, { recursive: true, force: true })
await rm(ambient, { recursive: true, force: true })
process.exit(0)
