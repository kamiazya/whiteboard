/**
 * The ONE tag control ([ADR-0040](../../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 6): a note's header, a box, an edge and the board are all tagged
 * through this, so what a chip looks like, what Enter does, and what a
 * malformed scoped tag is told are decided once.
 *
 * Chips of what is carried, each with its own remove control, and one box
 * that takes `key:value` or a plain tag. The box offers the vocabulary the
 * caller already has as a datalist, PAIRED by key: before a colon the keys
 * (as `key:`, so picking one continues the tag) and the plain tags; after
 * one, the values already used under that key. A `<datalist>` filters by
 * prefix itself, so the pairing is all the control adds.
 *
 * Emits the WHOLE list, never a patch: the caller decides what an empty list
 * means for its object (a removed field, everywhere it is stored).
 */
import { parseScopedTag, tagWriteSchema } from '@kamiazya/whiteboard-model'
import {
  type TagLibrary,
  type TagLibraryObjection,
  tagLibraryObjection,
} from '@kamiazya/whiteboard-plugin-visual'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { isImeComposingKeydown } from '../../lib/ime-keydown.js'

export interface TagChipsEditorProps {
  readonly tags: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  /** Tags already in use somewhere the caller can see — the board, the workspace. */
  readonly suggestions?: readonly string[]
  /** The box's element id, for a visible `<label htmlFor>` the caller draws. */
  readonly inputId?: string
  /**
   * What the workspace DECLARES (ADR-0040 decision 5): its admitted values
   * are offered under the key being typed, and a tag the library forbids —
   * a value a key does not admit, a second value under an exclusive key —
   * is refused with the rule, the way the MCP write path refuses it.
   */
  readonly library?: TagLibrary
}

/** Every `key:value` a library declares, so the datalist offers them beside what is in use. */
export function declaredTags(library: TagLibrary): string[] {
  return Object.entries(library).flatMap(([key, declared]) =>
    Object.keys(declared.values ?? {}).map((value) => `${key}:${value}`),
  )
}

/** The sentence the row shows for what the library holds against the tag set. */
function objectionSentence(objection: TagLibraryObjection): string {
  return objection.kind === 'undeclared'
    ? `${objection.key} admits ${objection.admitted.join(', ')} — "${objection.tag}" is not one of them`
    : `${objection.key} is one value at a time; this would carry ${objection.carried.join(' and ')}`
}

/** What the datalist offers for the draft as typed. */
export function tagCompletions(draft: string, suggestions: readonly string[]): string[] {
  const colon = draft.indexOf(':')
  const offered = new Set<string>()
  if (colon === -1) {
    for (const tag of suggestions) {
      const scoped = parseScopedTag(tag)
      offered.add(scoped === undefined ? tag : `${scoped.key}:`)
    }
  } else {
    const key = draft.slice(0, colon)
    for (const tag of suggestions) {
      if (parseScopedTag(tag)?.key === key) offered.add(tag)
    }
  }
  return [...offered].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function TagChipsEditor({
  tags,
  onChange,
  suggestions = [],
  inputId,
  library,
}: TagChipsEditorProps) {
  const listId = useId()
  const offered = library === undefined ? suggestions : [...suggestions, ...declaredTags(library)]
  const [draft, setDraft] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)

  const commitDraft = () => {
    const tag = draft.trim()
    // Blank and duplicate both mean "nothing to add" — emitting anyway would
    // write an identical list and, for a duplicate, a misleading one.
    if (tag === '' || tags.includes(tag)) return
    // The grammar is checked where a tag is WRITTEN (decision 1): a
    // colon-bearing tag that is not key:value is refused with the rule and
    // the draft stays, so the person can fix it rather than retype it.
    const checked = tagWriteSchema.safeParse(tag)
    if (!checked.success) {
      setRefusal(checked.error.issues[0]?.message ?? 'not a valid tag')
      return
    }
    // The library's rule, judged on the set the thing would END UP carrying
    // — the same judgement `wb_facet_set` refuses with — so a row and a
    // tool cannot disagree about what the workspace admits.
    const objection =
      library === undefined ? undefined : tagLibraryObjection(library, [...tags, tag])
    if (objection !== undefined) {
      setRefusal(objectionSentence(objection))
      return
    }
    onChange([...tags, tag])
    setDraft('')
    setRefusal(null)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(tags.filter((entry) => entry !== tag))}
              className="hover:text-foreground"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          list={listId}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setRefusal(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ',') return
            // The Enter that confirms an IME conversion is "accept this
            // word", not "finish this tag" — let it pass untouched.
            if (isImeComposingKeydown(event.nativeEvent)) return
            // Enter would submit an enclosing form and `,` would land in
            // the box; both mean "finish this tag" here.
            event.preventDefault()
            commitDraft()
          }}
          onBlur={commitDraft}
          placeholder="Add tag"
          aria-label="Add tag"
          aria-invalid={refusal !== null}
          className="text-foreground placeholder:text-muted-foreground min-w-24 flex-1 bg-transparent text-xs outline-none"
        />
        <datalist id={listId}>
          {tagCompletions(draft, offered).map((completion) => (
            <option key={completion} value={completion} />
          ))}
        </datalist>
      </div>
      {refusal !== null && (
        <p role="alert" className="text-destructive text-xs">
          {refusal}
        </p>
      )}
    </div>
  )
}
