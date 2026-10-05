// Overlay control for the widget's comment affordance (ADR-0024 decision 6;
// wired by widget-entry.ts). Rendered as a sibling of #root, never inside it
// — see refresh-control.ts's doc comment: `remount` clears #root via
// container.replaceChildren() on every mount, which would delete this
// element if it lived inside the container.
import { COMMENT_MESSAGE_MAX_CHARS } from '@kamiazya/whiteboard-model'

export interface CommentControl {
  readonly element: HTMLFormElement
  show(): void
  /** Busy also drops any reason shown: a new attempt answers for itself. */
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
  /**
   * Why the last write (or refresh) did not land, as one alert line under
   * the field, or `undefined` to clear it. The next keystroke clears it too:
   * once the person is editing, the reason describes text that is gone.
   */
  setError(message: string | undefined): void
}

// Stable hooks for tests and the widget smoke script — deliberately not an
// `id` (a host document could already use that name) or a class (styling
// hook, not an identity hook).
const COMMENT_CONTROL_TEST_ID = 'widget-comment'
export const COMMENT_INPUT_TEST_ID = 'widget-comment-input'
export const COMMENT_SUBMIT_TEST_ID = 'widget-comment-submit'
export const COMMENT_ANCHOR_TEST_ID = 'widget-comment-anchor'

const PICK_A_SPOT_HINT = 'Click the canvas to pick a spot'

// Deliberately minimal inline styling: this widget has no CSS build step of
// its own (single-file bundle) and must stay legible over an arbitrary
// host-rendered scene. `left` (not just `right`) pins the other edge, and
// `max-width` bounds the form to whatever room remains between the two —
// without both, a form with no explicit width shrinks-to-fit its content
// and, in a narrow inline/mobile MCP App frame, that content can be wider
// than the space between `right:96px` and the left viewport edge, pushing
// the form (and its input) off-screen to the left. `flex-wrap` gives the
// alert line a row of its own below the field.
const FORM_STYLE = [
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
  'flex-wrap:wrap',
].join(';')

const ANCHOR_HINT_STYLE = [
  'flex:0 0 auto',
  'font:11px system-ui,sans-serif',
  'color:#6b7280',
  'white-space:nowrap',
].join(';')

// `flex:1 1 auto` plus `min-width:0` (the flexbox default is `min-width:auto`,
// which floors the input at its intrinsic content width and defeats
// shrinking) lets the input shrink to whatever room the form's `max-width`
// above leaves, instead of forcing the form wider than that bound.
const INPUT_STYLE = [
  'flex:1 1 auto',
  'min-width:0',
  'font:12px system-ui,sans-serif',
  'padding:4px 6px',
  'border-radius:4px',
  'border:1px solid rgba(0,0,0,0.2)',
].join(';')

const SUBMIT_STYLE = [
  'flex:0 0 auto',
  'padding:4px 10px',
  'font:12px system-ui,sans-serif',
  'border-radius:6px',
  'border:1px solid rgba(0,0,0,0.2)',
  'background:rgba(255,255,255,0.9)',
  'color:#1e1e1e',
  'cursor:pointer',
].join(';')

const ERROR_LINE_STYLE = [
  'flex:1 0 100%',
  'margin:0',
  'font:11px system-ui,sans-serif',
  'color:#b91c1c',
  'max-height:4.5em',
  'overflow:auto',
  'overflow-wrap:anywhere',
].join(';')

/**
 * The alert line under the field. In the DOM from the start and filled in
 * place: a live region inserted together with its text is not reliably
 * announced.
 */
function createErrorLine(): { element: HTMLElement; set(message: string | undefined): void } {
  const line = document.createElement('p')
  line.setAttribute('role', 'alert')
  line.hidden = true
  line.style.cssText = ERROR_LINE_STYLE
  return {
    element: line,
    set(message: string | undefined): void {
      line.textContent = message ?? ''
      line.hidden = message === undefined
    },
  }
}

export function createCommentControl(onSubmit: (text: string) => void): CommentControl {
  const form = document.createElement('form')
  form.setAttribute('data-testid', COMMENT_CONTROL_TEST_ID)
  form.style.cssText = FORM_STYLE

  const anchorHint = document.createElement('span')
  anchorHint.setAttribute('data-testid', COMMENT_ANCHOR_TEST_ID)
  anchorHint.textContent = PICK_A_SPOT_HINT
  anchorHint.style.cssText = ANCHOR_HINT_STYLE

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Comment…'
  input.setAttribute('data-testid', COMMENT_INPUT_TEST_ID)
  input.setAttribute('aria-label', 'Comment text')
  // The bound the server writes a message under: past it every retry is
  // refused, so the field stops accepting characters there instead.
  input.maxLength = COMMENT_MESSAGE_MAX_CHARS
  input.style.cssText = INPUT_STYLE

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = 'Comment'
  submit.setAttribute('data-testid', COMMENT_SUBMIT_TEST_ID)
  submit.setAttribute('aria-label', 'Comment on the canvas')
  submit.style.cssText = SUBMIT_STYLE

  const errorLine = createErrorLine()
  input.addEventListener('input', () => errorLine.set(undefined))

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

  form.append(anchorHint, input, submit, errorLine.element)
  document.body.appendChild(form)

  return {
    element: form,
    show(): void {
      form.style.display = 'flex'
    },
    setBusy(next: boolean): void {
      busy = next
      if (busy) errorLine.set(undefined)
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
    setError: errorLine.set,
  }
}
