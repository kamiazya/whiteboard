/** The two pieces a touch sheet adds around a menu's rows. */

/**
 * Dims what the sheet covers and gives dismissal a target: the menu's
 * window-level outside-press listener closes on a press here.
 */
export function SheetScrim() {
  return (
    <div
      aria-hidden="true"
      data-editor-overlay
      data-testid="context-menu-scrim"
      className="bg-black/30"
      style={{ position: 'absolute', zIndex: 19, inset: 0 }}
    />
  )
}

/** The drag handle and, when the menu has a subject, its name; stays put while rows scroll. */
export function SheetHeader({ title }: { readonly title: string | undefined }) {
  return (
    <div role="presentation" className="sticky top-0 z-10 bg-background px-4 pt-2 pb-1">
      <div
        data-sheet-handle
        aria-hidden="true"
        className="mx-auto mb-1.5 h-1 w-10 rounded-full bg-muted-foreground/40"
      />
      {title !== undefined && (
        <div className="truncate text-sm font-medium text-muted-foreground">{title}</div>
      )}
    </div>
  )
}
