# ADR-0006: Object-oriented UI — create from the palette, act from the object

**Status:** Accepted

## Context

This product is a canvas: nouns (canvases, notes, links, groups, images) that
a user points at and manipulates. That makes it a natural fit for an
object-oriented UI (OOUI) — the user selects an object, then chooses what to
do with it — rather than a task-oriented one, where the user first picks a
command and the interface then asks which object to apply it to.

The distinction is not cosmetic. A task-oriented interface has to name every
verb it supports, so each new capability arrives as another labeled command
in a list that only grows. An object-oriented one lets the object's own
context carry the verbs, so new capabilities attach to something the user has
already selected instead of competing for room in a global menu.

`ToolPalette.tsx` has carried this decision in a header comment since it was
written, citing an "ooui-palette-vs-object-actions decision" that exists
nowhere in the repository. That comment is the only place the rule is
written down, so surfaces built elsewhere have not consistently followed it.
This ADR is that missing document.

## Decision

**What does not exist yet comes from the palette. What already exists is
acted on from the object itself.**

Concretely:

1. **Creation is a palette action.** The `+` palette is the creation surface.
   It must never grow per-object actions.
2. **Per-object actions live on the object** — its selection overlay, its
   context menu, its inline handles — not in a global command list.
3. **Naming follows creation; it does not gate it.** An object is generated
   first and named in place afterwards. Requiring a name *before* the object
   exists is the task-oriented shape: it makes the user serve the form rather
   than the form serve the object.
4. **Label rules follow the surface, not the action.** A dense, frequently
   used strip (palette, dock, toolbar) uses icon-only controls carrying
   `aria-label` plus a tooltip. A menu, dialog, or settings pane is a reading
   surface, not a memorized strip, and shows icon **and** text. This is
   restated as criterion 2 of
   `.claude/skills/review-gate/resources/accessibility.md`, which the design
   phases and the `accessibility` review dimension load. `CanvasDropdown.tsx`
   shows the conforming shape: a `New canvas…` entry with an icon **and** a
   label.

## Amendment (2026-08-18): vessels, and what a doorway is

Two things were decided in code after this ADR and are recorded here because
the ADR as written says otherwise, and a decision that lives only in an
implementation comment is one the next surface will contradict.

**The ⋯ catalog's `grid` and `sheet` vessels are icon-only.** Point 4 above
says a menu shows icon and text; these two vessels do not, and that stays.
They are one catalog rendered three ways — `list` (the right-click reading
surface) keeps icon and text, while `grid` and `sheet` are compact
object-action strips whose entries carry `aria-label` plus a tooltip. The
cost is real and named: a tooltip needs hover, so on touch the `sheet`'s
names are reachable only to a screen reader. What makes that acceptable is
that the sheet is never the ONLY path to a verb — the same catalog is
available as `list` wherever a pointer exists, and the keyboard has its own
bindings.

**A navigation is not an object verb, and does not belong in the catalog.**
Every entry in the catalog changes the object and leaves you where you are.
"Open in editor" changes nothing and moves you to another surface. Mixing the
categories produced the failure this amendment was written for: two
near-identical pencil icons side by side in an icon-only vessel, with no way
to tell "edit this text here" from "take me somewhere else to edit it".

So navigation lives on the OBJECT, beside the ⋯ doorway rather than inside
it, and carries the arrow-leaving-a-frame glyph that means "this takes you
elsewhere" everywhere else on the web. Two doorways, two categories, one
look each — which is what point 4 was protecting in the first place.

## Consequences

Easier:

- New capabilities have an obvious home — the object they act on — instead of
  accreting as labeled buttons in a shared toolbar.
- The interface stops growing linearly with the feature count, which is the
  concrete complaint that prompted this ADR.
- Review has something to check against: point 4 is already executable as
  review criteria, and points 1–3 are stated plainly enough to judge a diff.

Harder:

- Discoverability now rests on selection affordances and tooltips rather than
  on always-visible words. That is a real cost, and it is why point 4 requires
  a tooltip and an accessible name on every icon-only control rather than
  treating icons as free.
- Some capabilities genuinely have no object to hang from (import, workspace
  settings). Those belong in the palette or a settings surface, and this ADR
  does not pretend otherwise.

## Alternatives considered

**Task-oriented toolbar.** Every capability gets a labeled button. Discoverable
without hover, and no glyph literacy required — but it grows without bound,
and it is the state this ADR exists to move away from.

**Icons everywhere, including menus.** Maximally compact. Rejected: an
unlabeled glyph in a menu is a text label nobody can read, and it fails the
accessible-name criterion. The surface, not the icon, decides.

**Leave the rule in the ToolPalette comment.** Zero effort, and it is what the
repo did until now. Rejected because a rule reachable only by opening one
component is not a rule the next surface will consistently follow.
