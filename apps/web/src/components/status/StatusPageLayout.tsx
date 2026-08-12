import type { JSX, ReactNode } from 'react'

/**
 * Presentation-only frame for full-page status states (error, not-found):
 * a centered mark above title, description, and the caller's actions. It
 * owns layout and nothing else — each status page owns its own mark asset,
 * copy, and actions.
 */
export function StatusPageLayout({
  mark,
  title,
  description,
  actions,
}: {
  mark: ReactNode
  title: string
  description: string
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="flex h-full min-h-[60dvh] w-full flex-col items-center justify-center gap-5 bg-background px-6 text-center">
      {mark}
      <div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {actions !== undefined && <div className="flex gap-2">{actions}</div>}
    </div>
  )
}

/**
 * Shared action-button styling for status pages, matching the app's quiet
 * chrome without pulling component libraries onto the entry chunk (the
 * error fallback ships in the critical path).
 */
export function StatusPageButton({
  label,
  onClick,
  primary = false,
}: {
  label: string
  onClick: () => void
  primary?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? 'rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
          : 'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent'
      }
    >
      {label}
    </button>
  )
}
