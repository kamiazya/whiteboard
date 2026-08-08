/**
 * URL entry surface for link nodes — used both by the palette's "Add link"
 * (create) and the context menu's "Edit URL" (rewrite).
 *
 * Validation delegates to the same rule the canvas-model schema enforces
 * (`z.url()`), so a URL this dialog accepts can never fail schema
 * validation downstream — one authority, no drift.
 *
 * Marked `data-editor-overlay` so the canvas root's gesture handlers ignore
 * presses inside it. Positioning is inline for the same reason as the
 * context menu: it must behave identically where the app stylesheet is
 * absent (browser-mode component tests).
 */
import { useState } from 'react'
import { z } from 'zod'
import { isFollowableUrl } from './followable-url.js'

// z.url() alone accepts any parseable URL — including javascript: — so the
// scheme allowlist is part of validity here, not just of the open sink.
const urlSchema = z.url().refine(isFollowableUrl)

export interface LinkUrlDialogProps {
  readonly title: string
  readonly initialUrl?: string
  readonly onSubmit: (url: string) => void
  readonly onCancel: () => void
}

export function LinkUrlDialog({ title, initialUrl, onSubmit, onCancel }: LinkUrlDialogProps) {
  const [value, setValue] = useState(initialUrl ?? '')
  const isValid = urlSchema.safeParse(value).success

  return (
    <div
      data-editor-overlay
      data-testid="link-url-dialog"
      role="dialog"
      aria-label={title}
      className="rounded-md border bg-background p-3 shadow-lg"
      style={{
        position: 'absolute',
        zIndex: 30,
        left: '50%',
        top: '35%',
        transform: 'translate(-50%, -50%)',
        width: 'max-content',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (isValid) onSubmit(value)
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {title}
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog exists only to take this URL; focusing it is the entire interaction
            autoFocus
            type="url"
            value={value}
            placeholder="https://example.com"
            onChange={(e) => setValue(e.target.value)}
            className="w-72 rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!isValid}
            className="rounded bg-primary px-2 py-1 text-sm text-primary-foreground disabled:opacity-50"
          >
            OK
          </button>
        </div>
      </form>
    </div>
  )
}
