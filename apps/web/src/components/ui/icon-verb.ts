/**
 * The object-verb target DESIGN.md's "Object-action surfaces are icon-first"
 * specifies: 44px, no drawn label, the name carried by `aria-label` and a
 * `title` for the desktop hover.
 *
 * The size half is load-bearing — dropping the labels while keeping the old
 * padding would take the width the label was giving the target and give
 * nothing back — which is exactly why it is ONE constant rather than a
 * number each surface picks. Two surfaces already draw these verbs (the
 * comments rail and the proposal card), and a rule about a tap target that
 * every surface restates is one a surface gets wrong quietly.
 */
export const ICON_VERB_CLASS =
  'grid size-11 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground'
