import { useId } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

interface CapabilityTeaserProps {
  label: string
  enabled: boolean
}

// Daemon-only feature affordance shown while the capability is unavailable
// (browser-local mode). Uses aria-disabled + a no-op handler instead of the
// native `disabled` attribute: native disabled removes the control from the
// focus order and suppresses pointer/focus events entirely, which would also
// hide a Radix tooltip attached to it and make the guidance unreachable by
// keyboard. The sr-only description is always rendered (not just while a
// Radix tooltip happens to be open) so assistive tech gets it via
// aria-describedby regardless of hover/focus timing.
export function CapabilityTeaser({ label, enabled }: CapabilityTeaserProps) {
  const descriptionId = useId()
  const description = `Connect a local daemon (MCP) to enable ${label}`

  const button = (
    <button
      type="button"
      aria-disabled={enabled ? undefined : true}
      aria-describedby={enabled ? undefined : descriptionId}
      tabIndex={0}
      onClick={(event) => {
        if (!enabled) {
          // aria-disabled (unlike native `disabled`) still dispatches and bubbles
          // click events, so stop it here to stay truly inert even inside a
          // clickable ancestor.
          event.preventDefault()
          event.stopPropagation()
          return
        }
        // Daemon-mode wiring for this feature ships in a later slice; treat
        // as a no-op affordance until then rather than a broken control.
      }}
      className="rounded-md border px-3 py-1 text-xs font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 hover:aria-disabled:bg-transparent hover:not-aria-disabled:bg-accent"
    >
      {label}
    </button>
  )

  if (enabled) {
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
