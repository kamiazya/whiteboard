import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface NewCanvasDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  slug: string
  onSlugChange: (value: string) => void
  error: string | null
  busy: boolean
  onSubmit: () => void
}

// Presentational only. The daemon-mode POST /canvases flow, the busy/error
// state it produces, and the shared mountedRef guard all stay in the
// orchestrator: local mode bypasses this dialog entirely (it calls
// onCreateCanvas directly), and that shared error/mountedRef plumbing is not
// specific to this dialog's markup.
export function NewCanvasDialog({
  open,
  onOpenChange,
  slug,
  onSlugChange,
  error,
  busy,
  onSubmit,
}: NewCanvasDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New canvas</DialogTitle>
          <DialogDescription>
            Slug identifies the canvas on disk. Use `/` to group (e.g. "design/login-flow").
            Allowed: letters, digits, `-`, `/` (no leading/trailing `/`).
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={slug}
          onChange={(e) => onSlugChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit()
            }
          }}
          placeholder="e.g. design/login-flow"
          maxLength={120}
        />
        {error && <div className="text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
