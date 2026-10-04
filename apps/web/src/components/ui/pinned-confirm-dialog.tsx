import type { ComponentProps, ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog.js'
import { Button } from './button.js'

export interface PinnedConfirmDialogProps {
  open: boolean
  /** The confirmed action is in flight: nothing may dismiss the dialog or fire it again. */
  busy: boolean
  title: ReactNode
  description: ReactNode
  /** Why the action failed, shown under the description while the dialog stays open. */
  error?: string | null
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus']
}

/**
 * A destructive confirmation that stays open and inert until the async action
 * settles. Dismissing mid-request would let the person re-open it and fire a
 * second request before the first lands, so Escape, the overlay and both
 * buttons do nothing while `busy`. The caller closes it by clearing `open`.
 */
export function PinnedConfirmDialog({
  open,
  busy,
  title,
  description,
  error,
  confirmLabel,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: Readonly<PinnedConfirmDialogProps>) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description}
            {error && <span className="mt-2 block text-destructive">{error}</span>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/* Not AlertDialogAction: it closes on click, and this dialog must
              stay open until the action settles. */}
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
