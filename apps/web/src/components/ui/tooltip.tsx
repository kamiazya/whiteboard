import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as React from 'react'

import { cn } from '../../lib/utils.js'

// A tooltip here is a label, never a surface to move into, so it closes the
// moment the pointer leaves its trigger. Radix's default keeps it open until
// the next pointer move leaves a "grace area" toward the content — which a
// pointer that stops, or a touch that lifts, never supplies.
function TooltipProvider({
  delayDuration = 0,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

const TriggerNodeContext = React.createContext<React.MutableRefObject<HTMLElement | null> | null>(
  null,
)

// Radix closes a tooltip on blur, but a trigger that is REPLACED or removed
// while its tooltip is showing (a toggle that swaps its button, a route that
// unmounts it) fires no blur at all, and the tooltip would stay on screen
// anchored to nothing. While open, a trigger found detached closes it.
function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [innerOpen, setInnerOpen] = React.useState(defaultOpen)
  const open = openProp ?? innerOpen
  const triggerNode = React.useRef<HTMLElement | null>(null)
  const change = React.useCallback(
    (next: boolean) => {
      setInnerOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )
  React.useEffect(() => {
    if (!open) return
    // The node that raised the tooltip, not whatever the ref holds later: a
    // replacement trigger registers itself before the observer runs.
    const raised = triggerNode.current
    const observer = new MutationObserver(() => {
      if (raised !== null && !raised.isConnected) change(false)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [open, change])
  return (
    <TooltipProvider>
      <TriggerNodeContext.Provider value={triggerNode}>
        <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={change} {...props} />
      </TriggerNodeContext.Provider>
    </TooltipProvider>
  )
}

function TooltipTrigger({ ref, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const triggerNode = React.useContext(TriggerNodeContext)
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      ref={(node) => {
        if (triggerNode !== null && node !== null) triggerNode.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-primary fill-primary z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
