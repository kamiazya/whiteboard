/**
 * URL entry surface for link nodes — used both by the palette's Link entry
 * (create) and the context menu's "Edit URL" (rewrite).
 *
 * Validation delegates to the same rule the model schema enforces
 * (`z.url()`), so a URL this dialog accepts can never fail schema
 * validation downstream — one authority, no drift.
 *
 * Marked `data-editor-overlay` so the canvas root's gesture handlers ignore
 * presses inside it. Positioning is inline for the same reason as the
 * context menu: it must behave identically where the app stylesheet is
 * absent (browser-mode component tests).
 */
import { useId, useState } from 'react'
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

/**
 * Why this text cannot be used, in the words that tell someone what to do
 * next — or null when there is nothing to say. An empty field is not a
 * mistake, and the two failures need different advice: a typo wants the
 * missing scheme, a `javascript:` URL wants to know we will not open it at
 * all, and telling THAT person to "add https://" would be wrong.
 */
function refusalFor(value: string): string | null {
  if (value.trim() === '') return null
  if (urlSchema.safeParse(value).success) return null
  return isParseableUrl(value)
    ? 'Only http:// and https:// links can be opened.'
    : 'Enter a full address, starting with https://'
}

function isParseableUrl(value: string): boolean {
  return z.url().safeParse(value).success
}

export function LinkUrlDialog({ title, initialUrl, onSubmit, onCancel }: LinkUrlDialogProps) {
  const [value, setValue] = useState(initialUrl ?? '')
  const isValid = urlSchema.safeParse(value).success
  const refusal = refusalFor(value)
  const errorId = useId()

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
            aria-invalid={refusal !== null}
            aria-describedby={refusal === null ? undefined : errorId}
            onChange={(e) => setValue(e.target.value)}
            className="w-72 rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
        {/* Always mounted, even while empty. A live region that arrives in
            the DOM already carrying its message is announced inconsistently
            (Safari+VoiceOver, some NVDA setups); one that is already there
            when its text changes is not. Polite rather than assertive
            because this updates on every keystroke, and an alert on each one
            would talk over the typing it is describing. */}
        <p
          id={errorId}
          data-testid="link-url-error"
          role="status"
          className={refusal === null ? 'sr-only' : 'max-w-72 text-destructive text-xs'}
        >
          {refusal ?? ''}
        </p>
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
