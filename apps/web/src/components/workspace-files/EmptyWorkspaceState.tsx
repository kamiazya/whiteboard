import type { DocumentKind } from '@kamiazya/whiteboard-model'
import WelcomeMark from '../../brand/welcome-mark.svg?react'

/**
 * The onboarding chooser both index pages show before a workspace has any
 * documents. It renders INSTEAD of the panel: a three-pane browser of
 * nothing teaches less than one question and two objects to pick from.
 *
 * Object first, not verb first: the user is shown WHAT the two kinds are —
 * a picture and one line each — and picking one creates it and opens it
 * (ADR-0006: no naming step gates creation; naming happens in the opened
 * document). This is the one moment a user cannot reach the panel's own
 * create buttons, so both kinds must be reachable here.
 */
// Read once per render: the preference changing mid-visit is rare enough
// that live subscription would be machinery without a user.
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function EmptyWorkspaceState({
  onCreate,
  disabled,
  subtitle,
}: {
  onCreate: (kind: DocumentKind) => void
  disabled?: boolean
  /**
   * The one-line promise under the question. Passed by the page because it
   * is mode-dependent: "everything stays in this browser" is only true in
   * local mode, and an onboarding line that lies is worse than none.
   */
  subtitle?: string
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      {/* The brand STORY greets arrivals: the boot splash's self-contained
          SVG plays its whole arc here — the signature draws itself, a cursor
          sketches nodes and edges, the spark (the AI's hand) tidies them,
          and the signature returns to breathe. An <img> so the asset stays
          the single source of that story; its internal reduced-motion rule
          collapses it to the static drawn logo. The wordmark names the
          product — the one surface where the name is not already in the
          surrounding chrome (BRAND.md). */}
      {prefersReducedMotion() ? (
        // BRAND.md: reduced motion collapses every brand animation to the
        // static drawn logo. Decided HERE, not only inside the SVG — the
        // image's own @media fallback still stands, but an <img> document
        // does not see emulated media, and skipping the story entirely is
        // the calmer answer anyway.
        <WelcomeMark className="text-muted-foreground" />
      ) : (
        <img
          data-mark="welcome"
          src="/boot-splash.svg"
          alt=""
          aria-hidden="true"
          className="h-auto w-60"
        />
      )}
      <p className="text-lg font-semibold tracking-tight">Whiteboard</p>
      <p className="text-base font-semibold">What will you make first?</p>
      {subtitle !== undefined && (
        <p data-testid="empty-state-subtitle" className="text-muted-foreground -mt-2 text-sm">
          {subtitle}
        </p>
      )}
      {/* One row at every width: a fixed card width wrapped to a COLUMN on
          phones, and seeing both objects in one glance is the chooser's
          whole point. The grid splits whatever width the page gives. */}
      <div className="mt-2 grid w-full max-w-lg grid-cols-2 gap-3 px-4 sm:gap-4">
        <button
          type="button"
          aria-label="Create a canvas"
          disabled={disabled}
          onClick={() => onCreate('spatial')}
          className="hover:border-primary w-full rounded-lg border text-left transition-colors disabled:opacity-50"
        >
          <span
            aria-hidden="true"
            className="bg-muted/40 block aspect-[224/96] w-full overflow-hidden rounded-t-lg"
          >
            {/* Two notes and the connection between them — the canvas in
                one picture. */}
            <svg aria-hidden="true" viewBox="0 0 224 96" className="size-full">
              <rect
                x="34"
                y="20"
                width="58"
                height="26"
                rx="4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-primary/70"
              />
              <rect
                x="132"
                y="52"
                width="54"
                height="24"
                rx="4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-primary/70"
              />
              <path
                d="M92 40 C 112 46, 118 52, 132 58"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-primary/40"
              />
            </svg>
          </span>
          <span className="block px-4 py-3">
            <span className="block text-sm font-semibold">Canvas</span>
            <span className="text-muted-foreground block text-xs leading-relaxed">
              Place notes and connect them in space.
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Create a markdown note"
          disabled={disabled}
          onClick={() => onCreate('markdown')}
          className="hover:border-primary w-full rounded-lg border text-left transition-colors disabled:opacity-50"
        >
          <span
            aria-hidden="true"
            className="bg-muted/40 block aspect-[224/96] w-full overflow-hidden rounded-t-lg"
          >
            {/* Lines of prose — the note in one picture. */}
            <svg aria-hidden="true" viewBox="0 0 224 96" className="size-full">
              {[
                { y: 24, w: 96 },
                { y: 40, w: 150 },
                { y: 56, w: 132 },
                { y: 72, w: 78 },
              ].map(({ y, w }) => (
                <rect
                  key={y}
                  x="36"
                  y={y}
                  width={w}
                  height="5"
                  rx="2.5"
                  fill="currentColor"
                  className="text-primary/50"
                />
              ))}
            </svg>
          </span>
          <span className="block px-4 py-3">
            <span className="block text-sm font-semibold">Markdown note</span>
            <span className="text-muted-foreground block text-xs leading-relaxed">
              Start writing. Put it on a canvas later.
            </span>
          </span>
        </button>
      </div>
    </div>
  )
}
