// Overlay control for the MCP Apps widget bridge (widget-entry.ts). Rendered
// as a sibling of #root, never inside it: `remount` clears #root via
// container.replaceChildren() on every mount, which would delete this
// element if it lived inside the container.
export interface RefreshControl {
  readonly element: HTMLButtonElement
  show(): void
  setBusy(busy: boolean): void
}

// Stable hook for tests and the widget smoke script — deliberately not an
// `id` (a host document could already use that name) or a class (styling
// hook, not an identity hook).
export const REFRESH_CONTROL_TEST_ID = 'widget-refresh'

export function createRefreshControl(onRefresh: () => void): RefreshControl {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Refresh'
  button.setAttribute('data-testid', REFRESH_CONTROL_TEST_ID)
  button.setAttribute('aria-label', 'Refresh canvas from host')
  // Deliberately minimal inline styling: this widget has no CSS build step
  // of its own (single-file bundle) and must stay legible over an arbitrary
  // host-rendered scene without competing with Excalidraw's own UI chrome.
  button.style.cssText = [
    'position:fixed',
    'top:8px',
    'right:8px',
    'z-index:2147483647',
    'padding:4px 10px',
    'font:12px system-ui,sans-serif',
    'border-radius:6px',
    'border:1px solid rgba(0,0,0,0.2)',
    'background:rgba(255,255,255,0.9)',
    'color:#1e1e1e',
    'cursor:pointer',
    'display:none',
  ].join(';')
  button.addEventListener('click', () => {
    onRefresh()
  })
  document.body.appendChild(button)

  return {
    element: button,
    show(): void {
      button.style.display = 'block'
    },
    setBusy(busy: boolean): void {
      button.disabled = busy
    },
  }
}
