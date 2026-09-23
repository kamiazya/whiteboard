import { MessageSquare } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { cn } from '../../lib/utils.js'
import { DocumentHeader, type DocumentHeaderProps } from './DocumentHeader.js'
import type { MarkdownViewMode } from './EditorToolbar.js'
import { PreviewPane } from './PreviewPane.js'
import { previewColumnMaxWidth } from './preview-width.js'
import { SourcePane, type SourcePaneApi } from './SourcePane.js'

/**
 * The two COLUMNS the editor lays side by side, and the marker that sits in
 * the preview's gutter.
 *
 * They are components rather than three slices of one return for the reason
 * the editor's own JSX gave: everything a column decides — which mode hides
 * it, how wide it is, whether it has anything to draw — was decided inside
 * the editor's markup, where it read as the editor's own branching.
 */

/** What the preview's gutter draws one conversation from. */
export interface PreviewColumnMarker {
  readonly threadId: string
  readonly status: string
  readonly messages: number
  readonly selected: boolean
  readonly top: number
}

/** One conversation, in the preview column's left padding. */
export function PreviewCommentMarker({
  marker,
  onSelect,
}: {
  marker: PreviewColumnMarker
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid="comment-preview-marker"
      data-thread-id={marker.threadId}
      data-status={marker.status}
      aria-label={
        marker.messages > 1 ? `Open comment, ${marker.messages} messages` : 'Open comment'
      }
      onClick={onSelect}
      // In the column's own left padding, on the block's top edge.
      style={{ top: marker.top }}
      className={cn(
        'comment-preview-marker absolute left-0 flex size-6 items-center justify-center rounded text-(--annotation) hover:bg-accent',
        marker.selected && 'bg-accent',
      )}
    >
      <MessageSquare
        aria-hidden="true"
        className="size-3.5"
        fill={marker.selected ? 'currentColor' : 'none'}
        fillOpacity={0.35}
      />
      {/* Only past one. Read mode never shows the source, so this
        marker is all a reader has to judge a conversation by —
        but a digit beside every lone remark is noise, and the
        badge only says something once there is more than one.
        Corner-set rather than beside the icon: the column's
        left padding is exactly this button's width, so growing
        it sideways would run under the prose. */}
      {marker.messages > 1 ? (
        <span className="pointer-events-none absolute -top-0.5 -right-0.5 rounded-full bg-(--annotation) px-1 text-[9px] leading-[12px] text-background">
          {marker.messages}
        </span>
      ) : null}
    </button>
  )
}

/**
 * The SOURCE column. Hidden rather than unmounted in read mode: the view
 * holds the CodeMirror state, and unmounting it would drop the selection and
 * the undo history every time a reader glanced at the preview.
 */
export function SourceColumn({
  value,
  onChange,
  autoFocus,
  mode,
  splitRatio,
  linkTargets,
  apiRef,
  wrapRef,
  extensions,
  reconcileExternalValue,
  onRequestLinkPicker,
}: {
  value: string
  onChange: (next: string) => void
  autoFocus: boolean
  mode: MarkdownViewMode
  splitRatio: number
  linkTargets: readonly unknown[] | undefined
  apiRef: RefObject<SourcePaneApi | null>
  wrapRef: RefObject<HTMLDivElement | null>
  extensions: Parameters<typeof SourcePane>[0]['extensions']
  reconcileExternalValue: boolean
  onRequestLinkPicker: () => boolean
}) {
  return (
    <div
      ref={wrapRef}
      data-testid="markdown-source-wrap"
      style={{
        display: mode === 'read' ? 'none' : 'flex',
        flexBasis: mode === 'split' ? `${splitRatio * 100}%` : '100%',
        minWidth: 0,
      }}
    >
      <SourcePane
        value={value}
        onChange={onChange}
        autoFocus={autoFocus}
        // Offered only where there is something to link TO: with no targets
        // the shortcut would open a picker with nothing in it.
        {...(linkTargets !== undefined && linkTargets.length > 0 ? { onRequestLinkPicker } : {})}
        apiRef={apiRef}
        placeholderText="Write in Markdown…"
        className="markdown-editor-source"
        extensions={extensions}
        // A CRDT binding owns editor<->document sync; the controlled
        // reconcile path would race it (see SourcePane).
        reconcileExternalValue={reconcileExternalValue}
      />
    </div>
  )
}

/**
 * The PREVIEW column: the rendered document, its conversation markers, and
 * the header a reader sees in place of the source's title row.
 */
export function PreviewColumn({
  value,
  mode,
  meta,
  title,
  previewEmpty,
  previewWidth,
  previewMarkers,
  onSelectThread,
  onPreviewClick,
  scrollRef,
  innerRef,
  anchorsRef,
  blocksRef,
  measure,
  theme,
  references,
  renderMath,
  renderDiagram,
}: {
  value: string
  mode: MarkdownViewMode
  meta: DocumentHeaderProps['meta'] | undefined
  title: string | undefined
  previewEmpty: boolean
  previewWidth: number
  previewMarkers: readonly PreviewColumnMarker[]
  onSelectThread: ((threadId: string) => void) | undefined
  onPreviewClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  scrollRef: RefObject<HTMLDivElement | null>
  innerRef: RefObject<HTMLDivElement | null>
  anchorsRef: Parameters<typeof PreviewPane>[0]['anchorsRef']
  blocksRef: Parameters<typeof PreviewPane>[0]['blocksRef']
  measure: Parameters<typeof PreviewPane>[0]['measure']
  theme: Parameters<typeof PreviewPane>[0]['theme']
  references: Parameters<typeof PreviewPane>[0]['references']
  renderMath: Parameters<typeof PreviewPane>[0]['renderMath']
  renderDiagram: Parameters<typeof PreviewPane>[0]['renderDiagram']
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegation for the SVG's native <a> elements — a focused anchor's Enter already dispatches the click this handler receives, so the keyboard path lives on the anchor, not this container
    // biome-ignore lint/a11y/useKeyWithClickEvents: same rationale — the interactive element is the anchor inside, which is natively keyboard-activatable
    <div
      ref={scrollRef}
      data-testid="markdown-preview-scroll"
      className="min-w-0 flex-1 overflow-auto"
      onClick={onPreviewClick}
    >
      <div
        ref={innerRef}
        className="relative mx-auto px-6 py-8"
        style={{ maxWidth: previewColumnMaxWidth(previewWidth) }}
      >
        {previewMarkers.map((marker) => (
          <PreviewCommentMarker
            key={marker.threadId}
            marker={marker}
            onSelect={() => onSelectThread?.(marker.threadId)}
          />
        ))}
        {mode === 'read' && meta !== undefined && <DocumentHeader title={title} meta={meta} />}
        {previewEmpty ? (
          <p className="text-muted-foreground text-sm">Nothing to preview yet.</p>
        ) : (
          <PreviewPane
            value={value}
            maxWidth={previewWidth}
            measure={measure}
            theme={theme}
            references={references}
            renderMath={renderMath}
            renderDiagram={renderDiagram}
            anchorsRef={anchorsRef}
            blocksRef={blocksRef}
          />
        )}
      </div>
    </div>
  )
}
