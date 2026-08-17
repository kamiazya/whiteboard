import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Real app styles — the bug is that these tokens never reach the page root.
import '../index.css'
import WorkspaceTopBar from '../components/WorkspaceTopBar'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Lightness thresholds for the 0..1 estimate below: text must read as light
// (near-white) and dark backgrounds as near-black.
const LIGHT = 0.7
const DARK = 0.3

// Normalizes a computed-style color string — Chromium reports `rgb(r, g, b)`
// for sRGB values but `oklch(L C H)` for colors declared in the oklch
// color space (our tokens) — into a 0..1 lightness estimate so tests can
// assert "light" vs "near-black" without depending on an exact color or
// color-space representation.
function lightness(color: string): number {
  const normalized = color.trim().toLowerCase()
  if (normalized === 'transparent') return 0
  if (normalized.startsWith('oklch')) {
    const match = normalized.match(/oklch\(\s*([\d.]+)/)
    if (!match) throw new Error(`unparsable oklch color: ${color}`)
    return Number(match[1])
  }
  const match = normalized.match(/\d+(\.\d+)?/g)
  if (!match) throw new Error(`unparsable color: ${color}`)
  const [r, g, b] = match.map(Number)
  return (r! + g! + b!) / (3 * 255)
}

beforeEach(() => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/names'))
      return Promise.resolve(
        jsonResponse({
          workspace: 'Design review',
          canvases: { 'design/login-flow': 'Login flow' },
          pinned: [],
        }),
      )
    if (url.includes('/branches'))
      return Promise.resolve(
        jsonResponse({
          head: 'main',
          branches: [
            { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
          ],
        }),
      )
    if (url.includes('/versions')) return Promise.resolve(jsonResponse({ versions: [] }))
    return Promise.resolve(jsonResponse({}))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
  document.documentElement.classList.remove('dark')
})

describe('dark-mode chrome (root token application)', () => {
  it('body-inherited text is light on a dark background when .dark is on <html>', () => {
    document.documentElement.classList.add('dark')

    const { container } = render(<div data-testid="chrome-fixture">Canvas title</div>)
    const el = container.querySelector('[data-testid="chrome-fixture"]') as HTMLElement

    const bodyColor = getComputedStyle(document.body).color
    const bodyBackground = getComputedStyle(document.body).backgroundColor
    const elColor = getComputedStyle(el).color

    // Root cause of the bug: without a `body { color: var(--foreground) }`
    // base-layer rule, UA default black wins regardless of the dark tokens.
    expect(lightness(bodyColor)).toBeGreaterThan(LIGHT)
    expect(lightness(bodyBackground)).toBeLessThan(DARK)
    expect(lightness(elColor)).toBeGreaterThan(LIGHT)
  })

  it('body-inherited text stays near-black on a light background in light mode', () => {
    const { container } = render(<div data-testid="chrome-fixture-light">Canvas title</div>)
    const el = container.querySelector('[data-testid="chrome-fixture-light"]') as HTMLElement

    expect(lightness(getComputedStyle(document.body).color)).toBeLessThan(DARK)
    expect(lightness(getComputedStyle(el).color)).toBeLessThan(DARK)
  })

  it('WorkspaceTopBar (daemon-side chrome) inherits light text under .dark without any edit to that component', async () => {
    document.documentElement.classList.add('dark')

    const { findByText } = render(
      <WorkspaceTopBar
        workspaceId="sess_1"
        path="design/login-flow"
        canvases={[{ path: 'design/login-flow', updatedAt: '2026-04-24T11:00:00Z' }]}
        onToggleFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
      />,
    )

    // The subject is COLOUR inheritance, so any chrome text serves. The
    // switcher names the workspace now, which is the top bar's own label.
    const label = await findByText('Design review')
    expect(lightness(getComputedStyle(label).color)).toBeGreaterThan(LIGHT)
  })
})
