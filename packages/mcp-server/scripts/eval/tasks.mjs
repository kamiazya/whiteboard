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
