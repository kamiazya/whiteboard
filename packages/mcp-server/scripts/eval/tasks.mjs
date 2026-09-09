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
 * }} Task
 */

const snapshot = (wb, ids, path) =>
  wb.call('wb_canvas_snapshot', { workspaceId: WORKSPACE_ID, documentId: ids[path] })

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
