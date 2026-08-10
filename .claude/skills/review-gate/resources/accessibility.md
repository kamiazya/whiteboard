# Accessibility

Adapted from ui-skills' `fixing-accessibility` (MIT, https://www.ui-skills.com/),
narrowed to what actually bites in this repo. `AccessLint` is the always-on
post-push net; this dimension is the same question asked before the push, and
is opt-in per run rather than in the default set.

Prefer native semantics before ARIA, and prefer a minimal targeted fix over
refactoring the surrounding UI.

## Criteria

### 1. Accessible names on every interactive control

Check:
- Does every new button/link/input/select in the diff have an accessible
  name — visible text, `aria-label`, or `aria-labelledby`?
- Icon-only controls (the spatial editor's toolbar, `UpdateToast`'s dismiss)
  are the recurring case: is the icon `aria-hidden` with the name on the
  control itself?
- Do links say what they do, rather than "click here"?

### 2. Icon first, but never icon alone

A new feature should not arrive as another word on screen. Prefer an icon
where a conventional glyph exists — but only because the name is carried
elsewhere, never because it was dropped. `ToolPalette.tsx` is the reference
implementation: icon-only in the dock, icon **and** label in the `+` menu,
"a menu is a reading surface, not a memorized strip."

Check:
- Does a new control in a dense, frequently-used strip (toolbar, dock,
  overlay) use an icon rather than a text label?
- Does every such icon-only control carry `aria-label` **and** a tooltip on
  hover and focus? Without both, this rule degrades into criterion 1's
  failure — the icon is faster for the author and slower for everyone else.
- Is the icon a conventional glyph for the action, or invented? An invented
  glyph is a text label that nobody can read; use a label instead.
- Does a menu, dialog, or settings surface — where the user is reading, not
  reaching — show icon **and** text?
- Is a destructive or rare action icon-only? Those keep their words.

### 3. Keyboard reachability

Check:
- Is anything clickable that is not a `button`/`a`/`input`? A `div` with
  `onClick` needs a role, `tabIndex`, and a key handler — or should just be
  a native element.
- Is focus visible? An outline removed without a visible replacement is a
  finding.
- Does `Escape` close what the diff opens (dialog, overlay, menu)?
- Any `tabIndex` greater than 0 is a finding.

### 4. Focus management around dialogs and overlays

Check:
- Does a new modal/overlay trap focus while open, set an initial focus
  inside itself, and restore focus to its trigger on close?

### 5. State and error announcement

Check:
- Are expandable controls marked with `aria-expanded` (+ `aria-controls`)?
- Are loading states conveyed by more than a spinner — `aria-busy` or
  status text?
- Are form errors linked to their field via `aria-describedby` with
  `aria-invalid` set, rather than sitting in an unassociated sibling?
- Is a toast the ONLY way a critical message is conveyed? `UpdateToast` is
  the live example to compare against.

### 6. Canvas and SVG surfaces

This repo's main output is generated SVG, and `canvas-render` deliberately
ships **no** DOM/a11y projection (see package-canvas-render.md) — layout
retains semantic provenance for a future a11y layer rather than emitting one.
So the bar here is about the surrounding DOM, not the drawing:

Check:
- Does the container of an injected SVG (`CanvasViewer`'s
  `dangerouslySetInnerHTML`) carry a name/role, or is it an unlabeled blob to
  a screen reader?
- Does an `ImageSceneNode` carry `alt` (rendered as `<title>`), or is its
  absence a deliberate presentational choice?
- Is any canvas-only interaction reachable another way — a menu item, a
  command, a keyboard shortcut? A pointer-only affordance on a drawing
  surface is a real exclusion, not a nit.

### 7. Motion and contrast

Check:
- Is non-essential motion gated on `prefers-reduced-motion`?
- Do disabled/selected states rely on color alone?
