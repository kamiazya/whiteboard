import type { ReactNode } from 'react'

/** The surface every toast's action button sits in, sized up for a finger. */
export const TOAST_ACTION_CLASS =
  'hover:bg-accent rounded-md border px-2 py-0.5 font-medium transition-colors pointer-coarse:min-h-11 pointer-coarse:px-3'

const MESSAGE_CLASS = 'min-w-0 truncate'

/**
 * Fixed + z-index rather than document flow: the app shell fills 100dvh, so
 * a static element appended after it sits below the viewport. The centering
 * translate lives on the outer wrapper and the entrance animation on the
 * inner surface, because tw-animate's enter keyframe owns `transform`.
 */
function ToastFrame({
  children,
  silent = false,
}: {
  readonly children: ReactNode
  readonly silent?: boolean
}) {
  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2"
      aria-hidden={silent ? true : undefined}
    >
      <div className="bg-background animate-in fade-in-0 slide-in-from-bottom-2 flex items-center gap-3 rounded-lg border px-4 py-2 text-sm shadow-lg duration-(--motion-duration-normal) ease-(--motion-ease-out)">
        {children}
      </div>
    </div>
  )
}

/**
 * A one-line notice floating at the bottom of the viewport, with optional
 * actions after it.
 *
 * The live region is the MESSAGE, not the surface: a status region speaks
 * its whole text content, so buttons inside it ran their labels into the
 * sentence ("Duplicated Budget reviewOpen"). The actions stay reachable as
 * ordinary buttons beside it.
 */
export function Toast({
  message,
  actions,
}: {
  readonly message: ReactNode
  readonly actions?: ReactNode
}) {
  return (
    <ToastFrame>
      <span role="status" aria-live="polite" className={MESSAGE_CLASS}>
        {message}
      </span>
      {actions}
    </ToastFrame>
  )
}

/**
 * The same toast drawn for the eye alone, for a notice a live region that is
 * already mounted speaks: the same words from two regions are two
 * announcements. It carries no actions, since a hidden button is one a
 * screen reader cannot reach, and its message may wrap to a second line.
 */
export function SilentToast({
  message,
  testId,
}: {
  readonly message: ReactNode
  readonly testId?: string
}) {
  return (
    <ToastFrame silent>
      <span className="min-w-0" data-testid={testId}>
        {message}
      </span>
    </ToastFrame>
  )
}
