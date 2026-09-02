// Overlay control for the widget's comment affordance (ADR-0024 decision 6;
// wired by widget-entry.ts). Rendered as a sibling of #root, never inside it
// — see refresh-control.ts's doc comment: `remount` clears #root via
// container.replaceChildren() on every mount, which would delete this
// element if it lived inside the container.
export interface CommentControl {
  readonly element: HTMLFormElement
  show(): void
  setBusy(busy: boolean): void
  clear(): void
  /**
   * The anchor the next submit will pin the comment at, as user-facing text
   * ("(120, 40)", "n2 (120, 40)"), or `undefined` for "no spot picked yet".
   * A comment is ABOUT a spot, and the server refuses an anchorless one —
   * so submit stays disabled until an anchor exists, and the hint says what
   * to do instead of offering a button that can only fail.
   */
  setAnchor(label: string | undefined): void
}

// Stable hooks for tests and the widget smoke script — deliberately not an
// `id` (a host document could already use that name) or a class (styling
// hook, not an identity hook).
const COMMENT_CONTROL_TEST_ID = 'widget-comment'
export const COMMENT_INPUT_TEST_ID = 'widget-comment-input'
export const COMMENT_SUBMIT_TEST_ID = 'widget-comment-submit'
export const COMMENT_ANCHOR_TEST_ID = 'widget-comment-anchor'

const PICK_A_SPOT_HINT = 'Click the canvas to pick a spot'

export function createCommentControl(onSubmit: (text: string) => void): CommentControl {
  const form = document.createElement('form')
  form.setAttribute('data-testid', COMMENT_CONTROL_TEST_ID)
  // Deliberately minimal inline styling: this widget has no CSS build step
  // of its own (single-file bundle) and must stay legible over an arbitrary
  // host-rendered scene. `left` (not just `right`) pins the other edge, and
  // `max-width` bounds the form to whatever room remains between the two —
  // without both, a form with no explicit width shrinks-to-fit its content
  // and, in a narrow inline/mobile MCP App frame, that content can be wider
  // than the space between `right:96px` and the left viewport edge, pushing
  // the form (and its input) off-screen to the left.
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
    'align-items:center',
  ].join(';')

  const anchorHint = document.createElement('span')
  anchorHint.setAttribute('data-testid', COMMENT_ANCHOR_TEST_ID)
  anchorHint.textContent = PICK_A_SPOT_HINT
  anchorHint.style.cssText = [
    'flex:0 0 auto',
    'font:11px system-ui,sans-serif',
    'color:#6b7280',
    'white-space:nowrap',
  ].join(';')

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Comment…'
  input.setAttribute('data-testid', COMMENT_INPUT_TEST_ID)
  input.setAttribute('aria-label', 'Comment text')
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
  submit.textContent = 'Comment'
  submit.setAttribute('data-testid', COMMENT_SUBMIT_TEST_ID)
  submit.setAttribute('aria-label', 'Comment on the canvas')
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

  // The two independent reasons submit may be unavailable, tracked apart so
  // clearing one never un-disables the other.
  let busy = false
  let hasAnchor = false
  const applyDisabled = (): void => {
    const disabled = busy || !hasAnchor
    input.disabled = busy
    submit.disabled = disabled
    submit.style.opacity = disabled ? '0.5' : ''
    submit.style.cursor = busy ? 'wait' : disabled ? 'default' : 'pointer'
    submit.textContent = busy ? 'Commenting…' : 'Comment'
  }
  applyDisabled()

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (busy || !hasAnchor) return
    const text = input.value.trim()
    if (text.length === 0) return
    onSubmit(text)
  })

  form.appendChild(anchorHint)
  form.appendChild(input)
  form.appendChild(submit)
  document.body.appendChild(form)

  return {
    element: form,
    show(): void {
      form.style.display = 'flex'
    },
    setBusy(next: boolean): void {
      busy = next
      applyDisabled()
    },
    clear(): void {
      input.value = ''
    },
    setAnchor(label: string | undefined): void {
      hasAnchor = label !== undefined
      anchorHint.textContent = label ?? PICK_A_SPOT_HINT
      applyDisabled()
    },
  }
}
