// The errands a model is asked to run against the fixture, and how each is
// graded. See ADR-0030 for what this lane measures and what it cannot.
//
// Grading is by OUTCOME, never by path: a read task is passed by the value
// it answers, a write task by the state it leaves. Which tools it called and
// how many times are recorded beside the verdict as diagnostics, because a
// model that reaches the right answer another way has not failed, and a
// consolidation is judged by whether the calls column moves while the pass
// column does not.
//
// Read tasks follow Anthropic's mcp-builder rules: independent of each other,
// answerable with the tools alone, a single stable value compared as a
// string, and phrased in paraphrase so the question does not carry the words
// the target document does (nor a tool's name). Write tasks are graded
// against the real store after the agent exits, on a data directory of its
// own, so no task can see another's side effects.
import { WORKSPACE_ID } from './fixture.mjs'

/**
 * @typedef {{
 *   name: string,
 *   prompt: string,
 *   answer?: string,
 *   verify?: (wb: { call: (name: string, args: Record<string, unknown>) => Promise<any> }, ids: Record<string, string>) => Promise<{ ok: boolean, detail: string }>,
 *   boards?: readonly string[],
 * }} Task
 */

const snapshot = (wb, ids, path) =>
  wb.call('wb_canvas_snapshot', { workspaceId: WORKSPACE_ID, documentId: ids[path] })

/** A board the AGENT created, found by the path the prompt named. */
const boardAt = async (wb, path) => {
  const listed = await wb.call('wb_document_list', { workspaceId: WORKSPACE_ID })
  const entry = listed.documents.find((d) => d.path === path)
  if (entry === undefined) return undefined
  return wb.call('wb_canvas_snapshot', { workspaceId: WORKSPACE_ID, documentId: entry.documentId })
}

const text = (n) => (n.text ?? '').trim()
const byText = (board, t) => board.nodes.find((n) => text(n).toLowerCase() === t.toLowerCase())
const strictlyInside = (n, g) =>
  n.id !== g.id &&
  n.x >= g.x &&
  n.y >= g.y &&
  n.x + n.width <= g.x + g.width &&
  n.y + n.height <= g.y + g.height
const boxesOverlap = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const firstOverlap = (nodes) => {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (boxesOverlap(nodes[i], nodes[j])) return [nodes[i], nodes[j]]
    }
  }
  return undefined
}
const linked = (board, a, b) =>
  board.edges.some(
    (e) => (e.fromNode === a.id && e.toNode === b.id) || (e.fromNode === b.id && e.toNode === a.id),
  )

/** @type {readonly Task[]} */
export const TASKS = [
  {
    name: 'who grants repository access',
    prompt:
      'Somewhere in the workspace a note for new team members says who to ask for repository access. Answer with that person’s first name only.',
    answer: 'Mika',
  },
  {
    name: 'count of process-tagged documents',
    prompt:
      'How many documents in the workspace carry the tag "process"? Answer with the number only.',
    answer: '2',
  },
  {
    name: 'label on the browser-daemon connection',
    prompt:
      'On the architecture board, what is written on the link between the browser and the daemon? Answer with that text only.',
    answer: 'WebSocket',
  },
  {
    name: 'button colour in the style guide',
    prompt:
      'What colour does the style guide say buttons must be? Answer with the colour word only.',
    answer: 'teal',
  },
  {
    name: 'box count on the roadmap',
    prompt: 'How many boxes are on the roadmap board? Answer with the number only.',
    answer: '3',
  },
  {
    name: 'owner of the backup action item',
    prompt:
      'In the August 2026 retrospective, who owns the action item about the nightly backup? Answer with the first name only.',
    answer: 'Ren',
  },
  {
    name: 'latest version label of the meeting note',
    prompt:
      'What is the label of the most recently saved version of the note from the 1 September 2026 meeting? Answer with the label only.',
    answer: 'after the meeting',
  },
  {
    name: 'roadmap item with an open comment',
    prompt:
      'One item on the roadmap board has a comment thread attached to it. Answer with that item’s text only.',
    answer: 'Q4: search v2',
  },
  {
    name: 'what the onboarding note links to',
    prompt:
      'The note for new team members links to one other document. Answer with that document’s path in the workspace only.',
    answer: 'notes/style-guide',
  },
  {
    name: 'add a box and connect it',
    boards: ['boards/architecture'],
    prompt:
      'I am looking at the architecture board right now. Add a box that says "Observability" and connect the daemon to it.',
    verify: async (wb, ids) => {
      const board = await snapshot(wb, ids, 'boards/architecture')
      const node = board.nodes.find((n) => (n.text ?? '').trim() === 'Observability')
      if (node === undefined) {
        // ADR-0029: an unasked-for proposal is the default. The state read
        // here is the document, so a proposal-only outcome fails the task
        // as asked and is named so a reader can tell it from a no-op.
        const proposals = await wb.call('wb_document_get', {
          workspaceId: WORKSPACE_ID,
          documentIds: [ids['boards/architecture']],
        })
        const content = JSON.stringify(proposals)
        return {
          ok: false,
          detail: content.includes('Observability') ? 'proposed, not applied' : 'no such box',
        }
      }
      const daemon = board.nodes.find((n) => n.text === 'Daemon')
      const linked = board.edges.some(
        (e) =>
          (e.fromNode === daemon?.id && e.toNode === node.id) ||
          (e.fromNode === node.id && e.toNode === daemon?.id),
      )
      return { ok: linked, detail: linked ? 'box added and linked' : 'box added, not linked' }
    },
  },
  {
    name: 'add a tag without losing the others',
    prompt:
      'Tag the August 2026 retrospective note as "archived". Keep whatever tags it already has.',
    verify: async (wb, ids) => {
      const read = await wb.call('wb_document_get', {
        workspaceId: WORKSPACE_ID,
        documentIds: [ids['notes/retro-2026-08']],
      })
      const content = String(read.documents[0]?.content ?? '')
      const frontmatter = content.split('---')[1] ?? ''
      const has = (tag) => new RegExp(`(^|[\\s\\[,-])${tag}([\\s\\],]|$)`, 'm').test(frontmatter)
      const ok = has('archived') && has('retro')
      return { ok, detail: ok ? 'both tags present' : `frontmatter: ${frontmatter.trim()}` }
    },
  },
  {
    // wb_body_edit had no task, and the lane's refusal texts showed models
    // reaching for it with the wrong anchor shape; a passage edit is the
    // errand it exists for.
    name: 'change one sentence of a note',
    prompt:
      'In the style guide, buttons are described as one colour. Change that sentence so buttons are green instead, without touching anything else in the note. Apply it directly; I am looking at the note.',
    verify: async (wb, ids) => {
      const read = await wb.call('wb_document_get', {
        workspaceId: WORKSPACE_ID,
        documentIds: [ids['notes/style-guide']],
      })
      const content = String(read.documents[0]?.content ?? '')
      const green = /buttons are always green/i.test(content)
      const teal = /teal/i.test(content)
      const amberKept = /amber/i.test(content)
      const ok = green && !teal && amberKept
      return {
        ok,
        detail: ok
          ? 'sentence changed, rest kept'
          : `green=${green} teal-gone=${!teal} amber-kept=${amberKept}`,
      }
    },
  },
  {
    // wb_thread_edit's write half: replying to a thread a person opened.
    name: 'reply to the open comment',
    prompt:
      "Someone left a comment on one of the roadmap board's items asking about a download. Reply to that comment, on the same thread, saying the download is fine.",
    verify: async (wb, ids) => {
      const view = await wb.call('canvas_view', {
        workspaceId: WORKSPACE_ID,
        documentId: ids['boards/roadmap'],
      })
      const threads = view.threads ?? []
      const anchored = threads.find((t) => t.anchor?.nodeId === 'q4')
      if (anchored === undefined) return { ok: false, detail: 'the seeded thread is gone' }
      // canvas_view carries each thread's messages; wb_thread_edit's own
      // reply carries a count. Read whichever this answer has.
      const messages = anchored.messages?.length ?? anchored.messageCount ?? 0
      const replied = messages >= 2
      const extra = threads.length > 1
      return {
        ok: replied && !extra,
        detail: replied
          ? extra
            ? 'replied, but also opened a new thread'
            : 'replied on the same thread'
          : `no reply (messages ${messages}, threads ${threads.length})`,
      }
    },
  },
  {
    // The one declarative op, `region.set`: does a model reach for it when
    // the errand is "this group should contain exactly these", and what
    // does it cost? Graded on what the group encloses afterwards, however
    // the model got there.
    name: 'make a group contain exactly these',
    boards: ['boards/architecture'],
    prompt:
      'On the architecture board there is a group called Clients. Make it contain exactly three boxes — CLI, Web app, and Mobile app — and nothing else. Leave the rest of the board as it is. Apply it directly; I am looking at the board.',
    verify: async (wb, ids) => {
      const board = await snapshot(wb, ids, 'boards/architecture')
      const group = board.nodes.find((n) => n.type === 'group' && n.label === 'Clients')
      if (group === undefined) return { ok: false, detail: 'the Clients group is gone' }
      const inside = board.nodes.filter(
        (n) =>
          n.id !== group.id &&
          n.x >= group.x &&
          n.y >= group.y &&
          n.x + n.width <= group.x + group.width &&
          n.y + n.height <= group.y + group.height,
      )
      const texts = inside.map((n) => (n.text ?? '').trim()).sort()
      const wanted = ['CLI', 'Mobile app', 'Web app']
      const exact = JSON.stringify(texts) === JSON.stringify(wanted)
      const restKept = ['Browser', 'Daemon', 'SQLite', 'Layout worker'].every((t) =>
        board.nodes.some((n) => n.text === t),
      )
      return {
        ok: exact && restKept,
        detail: exact
          ? restKept
            ? 'group holds exactly the three'
            : 'group right, but the rest of the board changed'
          : `group holds [${texts.join(', ')}]`,
      }
    },
  },
  {
    // Server-decided geometry that a LATER op needs: the group's box depends
    // on where the three nodes landed. Nothing in the surface lets an op
    // name that, so what a model does instead — hand-written coordinates,
    // or a second call after reading the result — is the measurement.
    // Graded on the structure: three boxes, chained in order, strictly
    // inside a group with that label, none overlapping, and the rest of the
    // roadmap untouched.
    name: 'wrap a new chain in a group',
    boards: ['boards/roadmap'],
    prompt:
      'On the roadmap board, add three boxes in a row — Ingest, Transform, Publish — connected in that order with arrows, and put the three of them inside a group labelled Pipeline. Leave the existing items where they are. Apply it directly; I am looking at the board.',
    verify: async (wb, ids) => {
      const board = await snapshot(wb, ids, 'boards/roadmap')
      const group = board.nodes.find((n) => n.type === 'group' && n.label === 'Pipeline')
      if (group === undefined) return { ok: false, detail: 'no Pipeline group' }
      const inside = (n) =>
        n.id !== group.id &&
        n.x >= group.x &&
        n.y >= group.y &&
        n.x + n.width <= group.x + group.width &&
        n.y + n.height <= group.y + group.height
      const byText = (t) => board.nodes.find((n) => (n.text ?? '').trim() === t)
      const chain = ['Ingest', 'Transform', 'Publish'].map(byText)
      if (chain.some((n) => n === undefined)) return { ok: false, detail: 'a box is missing' }
      const outside = chain.filter((n) => !inside(n)).map((n) => n.text)
      if (outside.length > 0)
        return { ok: false, detail: `outside the group: ${outside.join(', ')}` }
      const linked = (a, b) => board.edges.some((e) => e.fromNode === a.id && e.toNode === b.id)
      if (!linked(chain[0], chain[1]) || !linked(chain[1], chain[2])) {
        return { ok: false, detail: 'chain not connected in order' }
      }
      const overlaps = (a, b) =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      for (let i = 0; i < chain.length; i++) {
        for (let j = i + 1; j < chain.length; j++) {
          if (overlaps(chain[i], chain[j])) {
            return { ok: false, detail: `${chain[i].text} overlaps ${chain[j].text}` }
          }
        }
      }
      const enclosedOthers = board.nodes.filter(
        (n) => inside(n) && !chain.some((c) => c.id === n.id),
      )
      if (enclosedOthers.length > 0) {
        return {
          ok: false,
          detail: `group also holds ${enclosedOthers.map((n) => n.id).join(', ')}`,
        }
      }
      for (const id of ['q3', 'q4', 'q1']) {
        const item = board.nodes.find((n) => n.id === id)
        if (item === undefined) return { ok: false, detail: `roadmap item ${id} is gone` }
      }
      return { ok: true, detail: 'chain wrapped' }
    },
  },
  {
    // Set-shaped errands: the same change to EVERY node that satisfies a
    // condition. Today each node is one op and its id has to be known, so
    // the measurement is whether a model pays a read to learn the ids
    // before it can act — a selector or a batch-scoped set would let the
    // edit name the condition instead.
    name: 'colour every box inside a group',
    boards: ['boards/architecture'],
    prompt:
      'On the architecture board, give every box inside the Clients group colour 5. Change nothing else on the board. Apply it directly; I am looking at the board.',
    verify: async (wb, ids) => {
      const board = await snapshot(wb, ids, 'boards/architecture')
      const group = board.nodes.find((n) => n.type === 'group' && n.label === 'Clients')
      if (group === undefined) return { ok: false, detail: 'the Clients group is gone' }
      const inside = (n) =>
        n.id !== group.id &&
        n.x >= group.x &&
        n.y >= group.y &&
        n.x + n.width <= group.x + group.width &&
        n.y + n.height <= group.y + group.height
      const members = board.nodes.filter(inside)
      const uncoloured = members.filter((n) => n.color !== '5').map((n) => n.id)
      if (members.length < 2) return { ok: false, detail: `group holds ${members.length}` }
      if (uncoloured.length > 0)
        return { ok: false, detail: `not colour 5: ${uncoloured.join(', ')}` }
      const bled = board.nodes.filter((n) => !inside(n) && n.color === '5').map((n) => n.id)
      if (bled.length > 0)
        return { ok: false, detail: `coloured outside the group: ${bled.join(', ')}` }
      return { ok: true, detail: `${members.length} members coloured, nothing else` }
    },
  },
  {
    name: 'lock every item on a board',
    prompt:
      'Lock every item on the roadmap board so nobody can move any of them. Apply it directly.',
    verify: async (wb, ids) => {
      const board = await snapshot(wb, ids, 'boards/roadmap')
      const loose = board.nodes.filter((n) => n.locked !== true).map((n) => n.id)
      if (board.nodes.length < 3) return { ok: false, detail: `only ${board.nodes.length} nodes` }
      return {
        ok: loose.length === 0,
        detail:
          loose.length === 0 ? `${board.nodes.length} locked` : `unlocked: ${loose.join(', ')}`,
      }
    },
  },
  {
    // The use-case axis (C5): a layout a person would actually ask for.
    // Not one op or one call — a layered architecture diagram, graded on
    // the layout properties a reader needs: every box inside its layer,
    // layers stacked in order and apart, boxes in a layer lined up, nothing
    // overlapping, and the connections drawn. What the model does to get
    // there — coordinates by hand, placement, tidy — is the diagnostic.
    name: 'draw a layered architecture diagram',
    boards: ['boards/system'],
    prompt:
      'Create a board at boards/system and draw the system architecture on it as three layers from top to bottom: a group labelled "Clients" holding boxes CLI, Web app and Mobile app; a group labelled "Services" holding API gateway, Auth and Search; a group labelled "Storage" holding SQLite and Blob store. Every box sits inside its layer, boxes in a layer are lined up side by side, and layers do not overlap. Connect CLI, Web app and Mobile app to API gateway; API gateway to Auth and to Search; Auth and Search to SQLite; Search to Blob store. Apply it directly; I am looking at the board.',
    verify: async (wb) => {
      const board = await boardAt(wb, 'boards/system')
      if (board === undefined) return { ok: false, detail: 'no board at boards/system' }
      const layers = [
        ['Clients', ['CLI', 'Web app', 'Mobile app']],
        ['Services', ['API gateway', 'Auth', 'Search']],
        ['Storage', ['SQLite', 'Blob store']],
      ]
      const groups = []
      for (const [label, members] of layers) {
        const group = board.nodes.find(
          (n) => n.type === 'group' && (n.label ?? '').trim() === label,
        )
        if (group === undefined) return { ok: false, detail: `no group ${label}` }
        const boxes = members.map((m) => byText(board, m))
        const missing = members.filter((_, i) => boxes[i] === undefined)
        if (missing.length > 0) return { ok: false, detail: `missing: ${missing.join(', ')}` }
        const outside = boxes.filter((b) => !strictlyInside(b, group)).map(text)
        if (outside.length > 0)
          return { ok: false, detail: `outside ${label}: ${outside.join(', ')}` }
        const ys = boxes.map((b) => b.y)
        if (Math.max(...ys) - Math.min(...ys) > 2) {
          return { ok: false, detail: `${label} boxes not lined up (y ${ys.join(', ')})` }
        }
        groups.push(group)
      }
      for (let i = 1; i < groups.length; i++) {
        if (groups[i - 1].y + groups[i - 1].height > groups[i].y) {
          return { ok: false, detail: `${layers[i - 1][0]} is not above ${layers[i][0]}` }
        }
      }
      const collision = firstOverlap(board.nodes.filter((n) => n.type !== 'group'))
      if (collision !== undefined) {
        return { ok: false, detail: `${text(collision[0])} overlaps ${text(collision[1])}` }
      }
      const wanted = [
        ['CLI', 'API gateway'],
        ['Web app', 'API gateway'],
        ['Mobile app', 'API gateway'],
        ['API gateway', 'Auth'],
        ['API gateway', 'Search'],
        ['Auth', 'SQLite'],
        ['Search', 'SQLite'],
        ['Search', 'Blob store'],
      ]
      const unlinked = wanted.filter(([a, b]) => !linked(board, byText(board, a), byText(board, b)))
      if (unlinked.length > 0) {
        return {
          ok: false,
          detail: `not connected: ${unlinked.map((p) => p.join('-')).join(', ')}`,
        }
      }
      return { ok: true, detail: 'three layers, lined up, connected' }
    },
  },
  {
    // A sequence diagram on a spatial canvas: participants as columns,
    // messages as boxes between their two participants, each lower than
    // the one before. Graded on those three orderings and on nothing
    // overlapping.
    name: 'draw a sequence diagram',
    boards: ['boards/open-flow'],
    prompt:
      'Create a board at boards/open-flow and draw a sequence diagram of opening a document. Participants Browser, Daemon and SQLite are columns from left to right, headed by a box each. The messages, in order from top to bottom, are: "open document" from Browser to Daemon; "load snapshot" from Daemon to SQLite; "rows" from SQLite to Daemon; "render" from Daemon to Browser. Draw each message as a box placed horizontally between its two participants and lower on the board than the message before it, connected to the participant it goes to. Apply it directly; I am looking at the board.',
    verify: async (wb) => {
      const board = await boardAt(wb, 'boards/open-flow')
      if (board === undefined) return { ok: false, detail: 'no board at boards/open-flow' }
      const participants = ['Browser', 'Daemon', 'SQLite'].map((p) => byText(board, p))
      if (participants.some((p) => p === undefined)) {
        return { ok: false, detail: 'a participant is missing' }
      }
      const centre = (n) => n.x + n.width / 2
      for (let i = 1; i < participants.length; i++) {
        if (centre(participants[i - 1]) >= centre(participants[i])) {
          return { ok: false, detail: 'participants are not left to right' }
        }
      }
      const headY = participants.map((p) => p.y)
      if (Math.max(...headY) - Math.min(...headY) > 2) {
        return { ok: false, detail: `participant heads not lined up (y ${headY.join(', ')})` }
      }
      const steps = [
        ['open document', 'Browser', 'Daemon'],
        ['load snapshot', 'Daemon', 'SQLite'],
        ['rows', 'SQLite', 'Daemon'],
        ['render', 'Daemon', 'Browser'],
      ]
      const messages = steps.map(([label]) =>
        board.nodes.find(
          (n) =>
            n.type !== 'group' &&
            text(n).toLowerCase().includes(label) &&
            !['Browser', 'Daemon', 'SQLite'].includes(text(n)),
        ),
      )
      const missing = steps.filter((_, i) => messages[i] === undefined).map((s) => s[0])
      if (missing.length > 0)
        return { ok: false, detail: `missing messages: ${missing.join(', ')}` }
      for (let i = 0; i < steps.length; i++) {
        const [label, from, to] = steps[i]
        const a = centre(byText(board, from))
        const b = centre(byText(board, to))
        const m = centre(messages[i])
        if (m < Math.min(a, b) || m > Math.max(a, b)) {
          return { ok: false, detail: `"${label}" is not between ${from} and ${to}` }
        }
        if (i > 0 && messages[i].y <= messages[i - 1].y) {
          return { ok: false, detail: `"${label}" is not below "${steps[i - 1][0]}"` }
        }
        if (messages[0].y <= Math.max(...headY)) {
          return { ok: false, detail: 'first message is not below the participant heads' }
        }
      }
      const collision = firstOverlap(board.nodes.filter((n) => n.type !== 'group'))
      if (collision !== undefined) {
        return { ok: false, detail: `${text(collision[0])} overlaps ${text(collision[1])}` }
      }
      return { ok: true, detail: 'columns, messages in order and between their participants' }
    },
  },
  {
    name: 'checkpoint every board',
    prompt:
      'Save a version of every board (spatial document) in the workspace, labelled "pre-review".',
    verify: async (wb, ids) => {
      const missing = []
      for (const path of ['boards/architecture', 'boards/roadmap']) {
        const listed = await wb.call('wb_version_list', {
          workspaceId: WORKSPACE_ID,
          documentId: ids[path],
        })
        if (!listed.versions.some((v) => v.label === 'pre-review')) missing.push(path)
      }
      return {
        ok: missing.length === 0,
        detail:
          missing.length === 0 ? 'both boards checkpointed' : `missing: ${missing.join(', ')}`,
      }
    },
  },
]
