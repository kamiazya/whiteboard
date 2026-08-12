import type { JSX, ReactNode } from 'react'
import { Button } from '@/components/ui/button'

// Full-page brand status states (BRAND.md). Each variant speaks the mark's
// own language instead of an abstract symbol:
// - error: the signature scribbled out — the whiteboard gesture for
//   "that's wrong" (one-shot draw via wb-scribble in index.css).
// - not-found: the signature wandered off its board — the thing you asked
//   for is not where it should be.

const MARKS: Record<'error' | 'not-found', JSX.Element> = {
  error: (
    <svg
      data-mark="scribble"
      width="132"
      height="84"
      viewBox="0 0 88 56"
      fill="none"
      aria-hidden="true"
    >
      <path
        className="wb-scribble"
        d="M20 44 C 27 22, 37 22, 44 33 C 48 40, 56 46, 59 36 C 62 26, 46 24, 49 34 C 52 44, 65 44, 63 32 C 61 22, 50 20, 54 30 C 58 40, 70 38, 68 26"
        stroke="#909090"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  'not-found': (
    <svg
      data-mark="not-found"
      width="150"
      height="99"
      viewBox="0 0 100 66"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2"
        y="2"
        width="84"
        height="62"
        rx="10"
        stroke="#9ca3af"
        strokeOpacity="0.5"
        strokeWidth="3"
      />
      <path
        d="M52 44 C 59 22, 69 22, 76 33 S 90 50, 100 25"
        stroke="#909090"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  ),
}

export interface BrandStatusAction {
  label: string
  onClick: () => void
  /** The one emphasized action; the rest render as outline buttons. */
  primary?: boolean
}

export function BrandStatusPage({
  variant,
  title,
  description,
  actions = [],
}: {
  variant: 'error' | 'not-found'
  title: string
  description: string
  actions?: readonly BrandStatusAction[]
}): JSX.Element {
  return (
    <div className="flex h-full min-h-[60dvh] w-full flex-col items-center justify-center gap-5 bg-background px-6 text-center">
      {MARKS[variant]}
      <div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {actions.length > 0 && (
        <div className="flex gap-2">
          {actions.map(({ label, onClick, primary }) => (
            <Button
              key={label}
              type="button"
              size="sm"
              variant={primary ? 'default' : 'outline'}
              onClick={onClick}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

// Referenced by ErrorBoundary's class component, which cannot use hooks —
// exported here so both surfaces share one reload affordance.
export function reloadPage(): void {
  window.location.reload()
}
