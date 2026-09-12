/**
 * The one kind switch between a document and its editor. Every canvas page
 * (browser, daemon) routes through this component instead of choosing
 * an editor itself, because the pages choosing independently is exactly how
 * a markdown document opened in the spatial editor on one backend after
 * being wired correctly on the other — and drawing on that view corrupts
 * the document.
 *
 * Two guards, one per compile/runtime half:
 *
 * - `markdown` is a REQUIRED prop. A page cannot mount the surface without
 *   deciding what a markdown document looks like on its backend, so "this
 *   page only does spatial" stops being expressible by omission.
 * - The switch below is exhaustive over `DocumentKind` with a `never` default,
 *   so adding a third kind to `documentKindSchema` fails compilation HERE, in
 *   the one place every page shares, rather than silently falling through
 *   to whichever editor a page happened to hardcode.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { ReactNode } from 'react'
import { MarkdownEditor, type MarkdownEditorProps } from '../markdown-editor/MarkdownEditor.js'

/**
 * What a backend must supply to edit a markdown document, independent of
 * how it stores the body (browser: the `body` text container via a
 * CRDT binding; daemon: the `okf-body` node through the sync session's
 * command path). Editor-facing options are picked from the editor's own
 * props so this never becomes a second, drifting copy of that contract.
 */
export interface MarkdownDocumentSession
  extends Pick<
    MarkdownEditorProps,
    | 'sourceExtensions'
    | 'theme'
    | 'meta'
    | 'references'
    | 'linkTargets'
    | 'onOpenDocument'
    | 'autoFocus'
    | 'title'
    | 'threads'
    | 'threadMarks'
    | 'selectedThreadId'
    | 'onSelectThread'
    | 'onComposeThread'
    | 'proposals'
    | 'onDecidePassage'
  > {
  /** Null until the document has hydrated — nothing editable renders before. */
  readonly body: string | null
  readonly setBody: (next: string) => void
}

export interface DocumentEditorSurfaceProps {
  kind: DocumentKind
  /** Keys the editor to the document identity so a switch resets its state. */
  documentKey: string
  /** The spatial editor, fully wired by the page (its prop surface is page-specific). */
  spatial: () => ReactNode
  /** Null only while the page cannot say yet (no document open). */
  markdown: MarkdownDocumentSession | null
}

function noopChange(): void {}

/**
 * A stable tag per binding ARRAY, so the editor's key can change with the
 * binding's identity and not merely with its presence.
 *
 * A CRDT binding names one LoroDoc, and `SourcePane` builds its CodeMirror
 * view once per mount — a binding that arrives on a LATER render, or is
 * rebuilt around a replaced document, reaches the props and never the view,
 * while `onChange` below has already stepped aside for it. Everything typed
 * in that interval is written nowhere. Keying on the binding's identity
 * remounts the view at the moment the binding appears or changes; what was
 * typed before it went through `setBody` and is already in the document, so
 * the new view opens on it.
 *
 * WeakMap, so a discarded binding does not hold its tag alive. Identity, not
 * equality, on purpose: it relies on the page memoising the array on its
 * document — the same thing the binding itself relies on. `the editor
 * survives a re-render that does not change the binding` pins that, so an
 * unstable memo upstream fails a test rather than remounting the editor
 * under whoever is typing.
 */
const bindingTags = new WeakMap<object, number>()
let nextBindingTag = 0
function bindingTag(extensions: object | undefined): string {
  if (extensions === undefined) return 'unbound'
  let tag = bindingTags.get(extensions)
  if (tag === undefined) {
    tag = ++nextBindingTag
    bindingTags.set(extensions, tag)
  }
  return `bound-${tag}`
}

export function DocumentEditorSurface(props: DocumentEditorSurfaceProps): ReactNode {
  switch (props.kind) {
    case 'spatial':
      return <>{props.spatial()}</>
    case 'markdown': {
      const session = props.markdown
      if (session === null || session.body === null) return null
      const { body, setBody, sourceExtensions, ...editorOptions } = session
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <MarkdownEditor
              key={`${props.documentKey}:${bindingTag(sourceExtensions)}`}
              value={body}
              // A CRDT binding owns the write path when present; `value`
              // then flows only outward (preview, word count).
              onChange={sourceExtensions === undefined ? setBody : noopChange}
              sourceExtensions={sourceExtensions}
              className="h-full"
              {...editorOptions}
            />
          </div>
        </div>
      )
    }
    default: {
      const exhaustive: never = props.kind
      return exhaustive
    }
  }
}
