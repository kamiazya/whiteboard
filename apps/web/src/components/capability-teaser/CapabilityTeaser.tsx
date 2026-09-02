import { useId } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

interface CapabilityTeaserProps {
  label: string
}

// Daemon-only feature affordance shown while the capability is unavailable
// (browser mode) — every render site gates on the capability being absent,
// so the control is inert by definition. Uses aria-disabled + a no-op
// handler instead of the native `disabled` attribute: native disabled
// removes the control from the focus order and suppresses pointer/focus
// events entirely, which would also hide a Radix tooltip attached to it and
// make the guidance unreachable by keyboard. The sr-only description is
// always rendered (not just while a Radix tooltip happens to be open) so
// assistive tech gets it via aria-describedby regardless of hover/focus
// timing.
export function CapabilityTeaser({ label }: CapabilityTeaserProps) {
  const descriptionId = useId()
  const description = `Connect a daemon (MCP) to enable ${label}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled={true}
          aria-describedby={descriptionId}
          tabIndex={0}
          onClick={(event) => {
            // aria-disabled (unlike native `disabled`) still dispatches and
            // bubbles click events, so stop it here to stay truly inert even
            // inside a clickable ancestor.
            event.preventDefault()
            event.stopPropagation()
          }}
          className="rounded-md border px-3 py-1 text-xs font-medium transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 hover:aria-disabled:bg-transparent"
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </Tooltip>
  )
}
