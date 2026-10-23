import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { type LinkTarget, linkMarkupFor, rankLinkTargets } from '../../lib/link-target.js'
import { type LinkTargetPlan, planLinkTarget } from '../../lib/link-target-plan.js'

/**
 * `[[` completion for document references. Accepting a candidate writes the
 * same markup the Link picker would (`linkMarkupFor`) — the bare
 * `[[path]]`, labeled with the target's display name at render time — so
 * the two entry points cannot teach different link spellings.
 *
 * `from` points AFTER the `[[`, at the query, and each option's `apply` is a
 * function that replaces the brackets too. That split is load-bearing, twice
 * over: the plugin's default filter matches labels against the text from
 * `from` (a `from` at the brackets scored every option zero and silently
 * discarded the result), and `validFor` keeps ONE result alive while the
 * query grows. The earlier shape — `filter: false`, no `validFor` — re-ran
 * the source on every keystroke, and each re-query re-stamped the open
 * result, so acceptCompletion's interactionDelay guard (Enter within 75ms
 * of the result opening is treated as an accident and falls through to a
 * newline) could reject a fast Enter indefinitely. With validFor the stamp
 * is set once when `[[` opens the list and fast typing cannot push it
 * forward.
 *
 * Targets arrive through a getter rather than being captured: the document
 * list refreshes while the editor lives, and a completion source is built
 * once at view creation.
 */
export function wikiLinkCompletionSource(
  getTargets: () => readonly LinkTarget[],
  getCreate: () => LinkTargetCreator | undefined = () => undefined,
  getOwnPath: () => string | undefined = () => undefined,
) {
  return (context: CompletionContext): CompletionResult | null => {
    // The open [[ with whatever partial query follows it. `matchBefore` only
    // looks at the current line, so a reference cannot span a line break —
    // the same rule the codec scanner enforces on read. A `#` ends the
    // document half of the address: what follows names a heading or a group
    // inside it, which this list does not know, and a popup that stayed open
    // would swallow the Enter meant to finish the line.
    const match = context.matchBefore(/\[\[[^\][|#]*$/)
    if (match === null) return null
    const targets = getTargets()
    const create = getCreate()
    const query = match.text.slice(2)
    const wanted = createRowPlan(query, targets, getOwnPath())
    if (targets.length === 0 && (create === undefined || wanted === null)) return null
    const ranked = rankLinkTargets(targets, query)
    // Only when nothing matches: a Create row beside real matches reads as
    // "this note does not exist" while it does.
    const createOption =
      create !== undefined && wanted !== null && ranked.length === 0
        ? [createLinkOption(wanted.text, wanted.plan, create)]
        : []
    if (ranked.length === 0 && createOption.length === 0) return null
    return {
      from: match.from + 2,
      options: [...ranked.map(targetOption), ...createOption],
      // A growing plain query keeps this result (the plugin narrows it);
      // a ] or | changes the grammar and re-asks the source. With a Create
      // row the row NAMES the typed text, so any growth must re-ask instead.
      validFor: create === undefined ? /^[^\][|]*$/ : (text: string) => text === query,
    }
  }
}

function targetOption(target: LinkTarget): Completion {
  return {
    label: target.name,
    // Names are not unique, paths are: the secondary text is what tells two
    // same-named documents apart. It is display only, so the filter still
    // matches the name and the insert is unchanged.
    detail: target.path,
    type: 'text',
    // Resolution is by path, so the alias only changes how the source
    // READS: a note that said `[[untitled]]` for a document the popup
    // showed as "Weekly sync" taught nobody what it linked.
    apply: writeReference(linkMarkupFor(target, target.name)),
  }
}

/**
 * Creates a markdown note at `path` called `name`; the host owns where and how.
 * The name is the workspace's display name for the document, so a note made
 * from `[[Rollback]]` opens titled "Rollback" rather than "Untitled".
 */
export type LinkTargetCreator = (path: string, name: string) => void | Promise<void>

/**
 * What a Create row would make for `query`, or null when none should be
 * offered: nothing typed, or the text already IS a target's path (a row
 * making a duplicate would only fail). The open document is not among the
 * targets, so its own path is asked for separately: a self-link is a link,
 * not a document to make.
 */
function createRowPlan(
  query: string,
  targets: readonly LinkTarget[],
  ownPath: string | undefined,
): { readonly text: string; readonly plan: LinkTargetPlan } | null {
  const text = query.trim()
  if (text === '' || text === ownPath || targets.some((target) => target.path === text)) {
    return null
  }
  const plan = planLinkTarget(
    text,
    ownPath,
    targets.map((target) => target.path),
  )
  return plan === null ? null : { text, plan }
}

/**
 * Replaces the typed `[[query` with `insert`.
 *
 * The brackets sit two characters before the QUERY start — and it must be the
 * `from` the plugin passes, never a position captured when the source ran: the
 * document may have changed in between (mobile autocorrect elsewhere, a CRDT
 * remote echo, another tab), and the plugin maps from/to through those changes
 * while a captured offset stays behind and writes the markup mid-word,
 * corrupting the body.
 */
function writeReference(insert: string): Completion['apply'] {
  return (view: EditorView, _completion, from, to) => {
    const bracketsFrom = from - 2
    if (view.state.sliceDoc(bracketsFrom, from) !== '[[') return
    view.dispatch({
      changes: { from: bracketsFrom, to, insert },
      selection: { anchor: bracketsFrom + insert.length },
      userEvent: 'input.complete',
    })
  }
}

function createLinkOption(
  text: string,
  plan: LinkTargetPlan,
  create: LinkTargetCreator,
): Completion {
  const write = writeReference(plan.markup)
  return {
    label: `Create '${text}'`,
    type: 'text',
    // Under every real match: it is the fallback for text that names nothing.
    boost: -99,
    apply: (view, completion, from, to) => {
      // The match grammar already excludes every character the markup forbids.
      if (typeof write === 'function') write(view, completion, from, to)
      void Promise.resolve(create(plan.path, plan.name)).catch(() => {})
    },
  }
}
