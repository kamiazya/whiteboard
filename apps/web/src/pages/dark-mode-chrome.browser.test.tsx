import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Real app styles — the bug is that these tokens never reach the page root.
import '../index.css'
import WorkspaceTopBar from '../components/WorkspaceTopBar'

function mkNamesResponse(): Response {
  return new Response(
    JSON.stringify({
      workspace: 'Design review',
      canvases: { 'design/login-flow': 'Login flow' },
      pinned: [],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function mkBranchesResponse(): Response {
  return new Response(
    JSON.stringify({
      head: 'main',
      branches: [
        { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-04-23T00:00:00Z' },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// Normalizes a computed-style color string — Chromium reports `rgb(r, g, b)`
// for sRGB values but `oklch(L C H)` for colors declared in the oklch
// color space (our tokens) — into a 0..1 lightness estimate so tests can
// assert "light" vs "near-black" without depending on an exact color or
// color-space representation.
function lightness(color: string): number {
  if (color.startsWith('oklch')) {
    const match = color.match(/oklch\(\s*([\d.]+)/)
    if (!match) throw new Error(`unparsable oklch color: ${color}`)
    return Number(match[1])
  }
  const match = color.match(/\d+(\.\d+)?/g)
  if (!match) throw new Error(`unparsable color: ${color}`)
  const [r, g, b] = match.map(Number)
  return (r! + g! + b!) / (3 * 255)
}

beforeEach(() => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/names')) return Promise.resolve(mkNamesResponse())
    if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
    if (url.includes('/versions'))
      return Promise.resolve(new Response(JSON.stringify({ versions: [] }), { status: 200 }))
    return Promise.resolve(new Response('{}', { status: 200 }))
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
    expect(lightness(bodyColor)).toBeGreaterThan(0.7)
    expect(lightness(bodyBackground)).toBeLessThan(0.3)
    expect(lightness(elColor)).toBeGreaterThan(0.7)
  })

  it('body-inherited text stays near-black on a light background in light mode', () => {
    const { container } = render(<div data-testid="chrome-fixture-light">Canvas title</div>)
    const el = container.querySelector('[data-testid="chrome-fixture-light"]') as HTMLElement

    expect(lightness(getComputedStyle(document.body).color)).toBeLessThan(0.3)
    expect(lightness(getComputedStyle(el).color)).toBeLessThan(0.3)
  })

  it('WorkspaceTopBar (daemon-side chrome) inherits light text under .dark without any edit to that component', () => {
    document.documentElement.classList.add('dark')

    const { getByText } = render(
      <WorkspaceTopBar
        workspaceId="sess_1"
        slug="design/login-flow"
        canvases={[{ slug: 'design/login-flow', updatedAt: '2026-04-24T11:00:00Z' }]}
        onEnterFullscreen={() => {}}
        onNavigateBack={() => {}}
        onNavigateToCanvas={() => {}}
      />,
    )

    const leaf = getByText('login-flow')
    expect(lightness(getComputedStyle(leaf).color)).toBeGreaterThan(0.7)
  })
})
