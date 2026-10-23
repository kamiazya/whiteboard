/**
 * The keyboard shortcut sheet — a read-only view of the catalog
 * (`shortcuts.ts`), grouped by each row's section. It holds no list of its
 * own: a row added to the catalog appears here with its platform's key
 * labels, and nowhere else needs an edit.
 */
import { useRef } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.js'
import { shortcutLabel } from './shortcut-labels.js'
import { EDITOR_SHORTCUTS, SHORTCUT_SECTIONS } from './shortcuts.js'

interface ShortcutHelpSheetProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function ShortcutHelpSheet({ open, onOpenChange }: ShortcutHelpSheetProps) {
  // The sheet has no trigger element of its own (it opens from a button OR a
  // key), so the dialog's default hand-back of focus has nowhere to go and
  // focus would fall to <body>. Remember whatever held focus at open instead.
  const openerRef = useRef<Element | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="shortcut-help-sheet"
        className="max-h-[80dvh] overflow-y-auto"
        onOpenAutoFocus={() => {
          openerRef.current = document.activeElement
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          if (openerRef.current instanceof HTMLElement) openerRef.current.focus()
        }}
      >
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>Press these with the canvas focused.</DialogDescription>
        {SHORTCUT_SECTIONS.map((section) => {
          const rows = EDITOR_SHORTCUTS.filter((spec) => spec.section === section)
          if (rows.length === 0) return null
          return (
            <section key={section} aria-labelledby={`shortcut-section-${section}`}>
              <h3 id={`shortcut-section-${section}`} className="mb-1 text-sm font-medium">
                {section}
              </h3>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                {rows.map((spec) => (
                  <div key={spec.id} data-shortcut-id={spec.id} className="contents">
                    <dt className="text-muted-foreground">{spec.description}</dt>
                    <dd>
                      <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {shortcutLabel(spec.display)}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )
        })}
        <p data-testid="shortcut-help-menu-only" className="text-sm text-muted-foreground">
          Align, Distribute, Tidy and Group have no key: right-click the selection or the canvas.
        </p>
      </DialogContent>
    </Dialog>
  )
}
