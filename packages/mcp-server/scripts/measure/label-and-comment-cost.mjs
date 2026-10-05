/**
 * What a comment message, an edge, line or group label, and a link's URL or a
 * file's path cost the daemon, by their length — the write, and then every
 * `wb_scene_render` of the board, through the real store and the export
 * measurer. What the comment, label and node-location limits beside
 * `NODE_TEXT_MAX_CHARS` are sized against; a length past its limit is
 * refused at the write, so the rows above a limit need it lifted first.
 *
 * Run:
 *   SHAPE=paragraph|word [KINDS=comment,edge,line,group,link,file] \
 *     node --import tsx/esm scripts/measure/label-and-comment-cost.mjs [lengths...]
 *
 *   paragraph  prose with spaces and no blank line
 *   word       one unbroken run of a single letter: nothing to wrap at
 *
 * A comment is written through `comment.add`, which opens a thread whose
 * opening message is the one a board draws. Each row is a fresh document of
 * two text boxes, so no row prices the previous one's text.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCanvasEditTool,
  createCanvasRenderSvgTool,
  wbDocumentCreate,
} from '@kamiazya/whiteboard-server-core'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.ts'
import { setDataDirForTests } from '../../src/shared/data-dir-secure.ts'

const shape = process.env.SHAPE ?? 'paragraph'
const lengths = process.argv.slice(2).map(Number)

const sentence = 'Lorem ipsum dolor sit amet. '
function textOfLength(length) {
  if (shape === 'word') return 'x'.repeat(length)
  return sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length)
}

const KINDS = {
  comment: (text, [a]) => ({ op: 'comment.add', comment: { text, targetNodeId: a } }),
  edge: (text, [a, b]) => ({
    op: 'edge.add',
    edge: { from: { node: a }, to: { node: b }, label: text },
  }),
  line: (text) => ({
    op: 'line.add',
    line: {
      from: { kind: 'point', point: { x: 0, y: 400 } },
      to: { kind: 'point', point: { x: 600, y: 400 } },
      label: text,
    },
  }),
  group: (text) => ({
    op: 'node.add',
    node: { type: 'group', label: text, x: 0, y: 600, width: 400, height: 300 },
  }),
  // A link's URL and a file's path are drawn as the node's label.
  link: (text) => ({
    op: 'node.add',
    node: {
      type: 'link',
      url: `https://example.com/${text}`,
      x: 0,
      y: 600,
      width: 400,
      height: 100,
    },
  }),
  file: (text) => ({
    op: 'node.add',
    node: { type: 'file', file: `assets/${text}`, x: 0, y: 600, width: 400, height: 100 },
  }),
}

const served = await mkdtemp(join(tmpdir(), 'wb-served-'))
const ambient = await mkdtemp(join(tmpdir(), 'wb-ambient-'))
setDataDirForTests(ambient)
const { serverDeps: deps } = await bootSelfHostDeps(served)
await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
const edit = createCanvasEditTool(deps)
const render = createCanvasRenderSvgTool(deps)
const ms = (usage) => (usage.user + usage.system) / 1000

console.log('kind     shape      chars  write cpu ms  render cpu ms  render ms/Ki')
let row = 0
for (const kind of (process.env.KINDS ?? Object.keys(KINDS).join(',')).split(',')) {
  // The first length of each kind is warm-up (modules, WASM, font tables)
  // and is not printed.
  for (const [index, length] of [
    256,
    ...(lengths.length > 0 ? lengths : [256, 1024, 4096, 16384]),
  ].entries()) {
    const { documentId } = await wbDocumentCreate(deps, {
      workspaceId: 'ws-1',
      path: `d${row++}`,
      kind: 'spatial',
    })
    const base = await edit.execute({
      workspaceId: 'ws-1',
      documentId,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { type: 'text', text: 'a', x: 0, y: 0, width: 200, height: 80 } },
        { op: 'node.add', node: { type: 'text', text: 'b', x: 600, y: 0, width: 200, height: 80 } },
      ],
    })
    const text = textOfLength(length)
    const writeBefore = process.cpuUsage()
    const written = await edit.execute({
      workspaceId: 'ws-1',
      documentId,
      mode: 'apply',
      ops: [KINDS[kind](text, base.touched.nodes)],
    })
    const writeCpu = ms(process.cpuUsage(writeBefore))
    // A harness whose writes silently do nothing prints small, plausible numbers.
    if (written.applied !== 1) throw new Error(`${kind} ${length}: the write did not apply`)

    const renderBefore = process.cpuUsage()
    const { svg } = await render.execute({ workspaceId: 'ws-1', documentId })
    const renderCpu = ms(process.cpuUsage(renderBefore))
    // A group's label is cut to its box, so the drawn head is what is checked.
    if (!svg.includes(text.slice(0, 5)))
      throw new Error(`${kind} ${length}: the render drew no text`)
    if (index === 0) continue
    console.log(
      `${kind.padEnd(8)} ${shape.padEnd(9)} ${String(length).padStart(6)} ${writeCpu.toFixed(0).padStart(13)} ${renderCpu.toFixed(0).padStart(14)} ${((renderCpu / length) * 1024).toFixed(0).padStart(13)}`,
    )
  }
}
await rm(served, { recursive: true, force: true })
await rm(ambient, { recursive: true, force: true })
process.exit(0)
