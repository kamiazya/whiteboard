/**
 * What the canvas root treats as an OVERLAY rather than canvas surface.
 *
 * Two of the root's guards ask this question and used to answer it
 * separately, each with the same attribute lookup: the React pointer guard
 * (a press an overlay took must not start a gesture — capturing the pointer
 * would retarget the control's own `click` to the root) and the native
 * `touchstart` refuser (a cancelled touchstart is what stops the platform
 * claiming a pan as a scroll, and it also suppresses the click and focus a
 * tap would produce). A control that opted in for one and not the other
 * worked under a mouse and was dead to a finger.
 *
 * `data-editor-overlay` is still the opt-in for a container that is chrome
 * without being a control (the minimap, a text editor's frame). What this
 * adds is the controls themselves: a native button, field, link or dialog
 * inside the root is chrome by definition, and recognising it here is what
 * makes the attribute a courtesy rather than a thing someone forgets — the
 * comment card forgot it, and its Close was unreachable on every phone.
 *
 * SVG hit shapes carrying `role="button"` are deliberately NOT matched:
 * resize and connect handles are canvas gestures that own their pointer
 * from the press, and native touch semantics on them would hand a resize
 * to the page scroller.
 */
const OVERLAY_SELECTOR = [
  '[data-editor-overlay]',
  'button',
  'input',
  'textarea',
  'select',
  'a[href]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="dialog"]',
  '[role="menu"]',
].join(', ')

export function isEditorOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY_SELECTOR) !== null
}
