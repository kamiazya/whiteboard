// Overlay control for the append-only sticky-note affordance (widget-entry.ts).
// Rendered as a sibling of #root, never inside it — see refresh-control.ts's
// doc comment: `remount` clears #root via container.replaceChildren() on
// every mount, which would delete this element if it lived inside the
// container.
export interface StickyNoteControl {
  readonly element: HTMLFormElement
  show(): void
  setBusy(busy: boolean): void
}

// Stable hooks for tests and the widget smoke script — deliberately not an
// `id` (a host document could already use that name) or a class (styling
// hook, not an identity hook).
export const STICKY_NOTE_CONTROL_TEST_ID = 'widget-sticky-note'
export const STICKY_NOTE_INPUT_TEST_ID = 'widget-sticky-note-input'
export const STICKY_NOTE_SUBMIT_TEST_ID = 'widget-sticky-note-submit'

export function createStickyNoteControl(onSubmit: (text: string) => void): StickyNoteControl {
  const form = document.createElement('form')
  form.setAttribute('data-testid', STICKY_NOTE_CONTROL_TEST_ID)
  // Deliberately minimal inline styling: this widget has no CSS build step
  // of its own (single-file bundle) and must stay legible over an arbitrary
  // host-rendered scene without competing with Excalidraw's own UI chrome.
  // `left` (not just `right`) pins the other edge, and `max-width` bounds the
  // form to whatever room remains between the two — without both, a form
  // with no explicit width shrinks-to-fit its content and, in a narrow
  // inline/mobile MCP App frame, that content can be wider than the space
  // between `right:96px` and the left viewport edge, pushing the form (and
  // its input) off-screen to the left.
  form.style.cssText = [
    'position:fixed',
    'top:8px',
    'left:8px',
    'right:96px',
    'max-width:calc(100% - 104px)',
    'box-sizing:border-box',
    'z-index:2147483647',
    'display:none',
    'gap:4px',
    'padding:4px',
    'border-radius:6px',
    'border:1px solid rgba(0,0,0,0.2)',
    'background:rgba(255,255,255,0.9)',
  ].join(';')

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Add sticky note…'
  input.setAttribute('data-testid', STICKY_NOTE_INPUT_TEST_ID)
  input.setAttribute('aria-label', 'Sticky note text')
  // `flex:1 1 auto` plus `min-width:0` (the flexbox default is `min-width:auto`,
  // which floors the input at its intrinsic content width and defeats
  // shrinking) lets the input shrink to whatever room the form's `max-width`
  // above leaves, instead of forcing the form wider than that bound.
  input.style.cssText = [
    'flex:1 1 auto',
    'min-width:0',
    'font:12px system-ui,sans-serif',
    'padding:4px 6px',
    'border-radius:4px',
    'border:1px solid rgba(0,0,0,0.2)',
  ].join(';')

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = 'Add'
  submit.setAttribute('data-testid', STICKY_NOTE_SUBMIT_TEST_ID)
  submit.setAttribute('aria-label', 'Add sticky note to canvas')
  submit.style.cssText = [
    'flex:0 0 auto',
    'padding:4px 10px',
    'font:12px system-ui,sans-serif',
    'border-radius:6px',
    'border:1px solid rgba(0,0,0,0.2)',
    'background:rgba(255,255,255,0.9)',
    'color:#1e1e1e',
    'cursor:pointer',
  ].join(';')

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (text.length === 0) return
    onSubmit(text)
  })

  form.appendChild(input)
  form.appendChild(submit)
  document.body.appendChild(form)

  return {
    element: form,
    show(): void {
      form.style.display = 'flex'
    },
    setBusy(busy: boolean): void {
      input.disabled = busy
      submit.disabled = busy
      submit.style.opacity = busy ? '0.5' : ''
      submit.style.cursor = busy ? 'wait' : 'pointer'
      submit.textContent = busy ? 'Adding…' : 'Add'
    },
  }
}
