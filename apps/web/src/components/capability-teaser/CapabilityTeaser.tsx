import { useId } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

interface CapabilityTeaserProps {
  label: string
  enabled: boolean
  onAction?: () => void
}

// Daemon-only feature affordance shown while the capability is unavailable
// (browser mode). Uses aria-disabled + a no-op handler instead of the
// native `disabled` attribute: native disabled removes the control from the
// focus order and suppresses pointer/focus events entirely, which would also
// hide a Radix tooltip attached to it and make the guidance unreachable by
// keyboard. The sr-only description is always rendered (not just while a
// Radix tooltip happens to be open) so assistive tech gets it via
// aria-describedby regardless of hover/focus timing.
export function CapabilityTeaser({ label, enabled, onAction }: CapabilityTeaserProps) {
  const descriptionId = useId()
  // `enabled` alone is not enough to make this control interactive: without a
  // wired onAction it would look clickable but do nothing, which reads as a
  // broken control rather than a genuinely inert affordance.
  const isInteractive = enabled && onAction !== undefined
  const description = enabled
    ? 'This feature is not yet available'
    : `Connect a daemon (MCP) to enable ${label}`

  const button = (
    <button
      type="button"
      aria-disabled={isInteractive ? undefined : true}
      aria-describedby={isInteractive ? undefined : descriptionId}
      tabIndex={0}
      onClick={(event) => {
        if (!isInteractive) {
          // aria-disabled (unlike native `disabled`) still dispatches and bubbles
          // click events, so stop it here to stay truly inert even inside a
          // clickable ancestor.
          event.preventDefault()
          event.stopPropagation()
          return
        }
        onAction()
      }}
      className="rounded-md border px-3 py-1 text-xs font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 hover:aria-disabled:bg-transparent hover:not-aria-disabled:bg-accent"
    >
      {label}
    </button>
  )

  if (isInteractive) {
    return button
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </Tooltip>
  )
}
