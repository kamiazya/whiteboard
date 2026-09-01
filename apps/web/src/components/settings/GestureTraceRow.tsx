import { useState } from 'react'
import { gestureTrace } from '@/components/spatial-editor/gesture-trace'

const BUTTON_CLASS =
  'shrink-0 rounded-md border border-primary px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/5'

/**
 * The retrieval half of the gesture flight recorder (see
 * `spatial-editor/gesture-trace.ts`). Recording is always on precisely
 * because the failure it exists for is noticed only after it happens; this
 * row is how a phone, with no devtools within reach, hands the last ~200
 * pointer decisions to whoever is investigating. The trace holds event
 * kinds, coordinates, element test-ids and mode names — no document
 * content — and leaves the device only when this button is pressed.
 */
export function GestureTraceRow() {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(gestureTrace.serialize())
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          Gesture diagnostics
          <span className="font-mono text-[11px] font-normal text-muted-foreground">
            {copied === 'copied'
              ? 'copied'
              : copied === 'failed'
                ? 'copy failed'
                : `${gestureTrace.entries().length} events recorded`}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The last pointer events and what the canvas decided — coordinates and control names, never
          document content. Copy it when a touch or drag misbehaved.
        </p>
      </div>
      <button type="button" className={BUTTON_CLASS} onClick={() => void copy()}>
        Copy trace
      </button>
    </div>
  )
}
