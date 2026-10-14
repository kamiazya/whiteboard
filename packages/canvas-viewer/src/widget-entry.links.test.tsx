import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A link drawn in a node is a live `<a>` in the widget's own frame: a bare
// document id resolves against the frame's URL, a scheme URL replaces the
// view outright. Either way the canvas, Refresh and the comment form are gone
// until the chat re-renders the tool result. These cases drive the real
// bootstrap (it runs on import) with the host and the mount faked.

const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FB1'

interface FakeApp {
  ontoolresult?: (result: unknown) => void
  connect: () => Promise<void>
  openLink: (params: { url: string }) => Promise<unknown>
  getHostCapabilities: () => { serverTools?: object; openLinks?: object } | undefined
}

const openLinkMock = vi.fn(async () => ({}))
const apps: FakeApp[] = []
let capabilities: ReturnType<FakeApp['getHostCapabilities']> = { serverTools: {}, openLinks: {} }

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: vi.fn(function FakeApp(this: FakeApp) {
    apps.push(this)
    this.connect = async () => undefined
    this.openLink = openLinkMock
    this.getHostCapabilities = () => capabilities
  }),
}))

vi.mock('./mount.js', () => ({
  mountCanvasViewer: vi.fn(() => ({ dispose: vi.fn() })),
}))

class FakeFontFace {
  constructor(
    public family: string,
    public source: string,
  ) {}
  load(): Promise<FakeFontFace> {
    return Promise.resolve(this)
  }
}

/** Puts a drawn scene with the given links into the widget's container. */
function drawLinks(...hrefs: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 150 }) as DOMRect
  for (const href of hrefs) {
    const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'a')
    anchor.setAttribute('href', href)
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.setAttribute('data-href', href)
    anchor.append(text)
    svg.append(anchor)
  }
  document.getElementById('root')?.append(svg)
  return svg
}

/** Clicks the text inside the link to `href`; answers whether it was cancelled. */
function clickLink(href: string): boolean {
  const text = document.querySelector(`text[data-href="${href}"]`)
  if (text === null) throw new Error(`no link to ${href}`)
  return !text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

async function bootInHost(): Promise<void> {
  Object.defineProperty(window, 'parent', { configurable: true, value: {} })
  vi.resetModules()
  await import('./widget-entry.js')
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="widget-comment"]')).not.toBeNull(),
  )
  apps[0]?.ontoolresult?.({
    structuredContent: {
      workspaceId: 'ws-1',
      documentId: 'ws/path',
      scene: { nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 }] },
    },
  })
}

describe('a link drawn in the canvas_view widget', () => {
  beforeAll(async () => {
    await Promise.all([
      import('@kamiazya/whiteboard-canvas-render'),
      import('./widget/comment-control.js'),
      import('./widget/font-registration.js'),
    ])
  })

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    apps.length = 0
    openLinkMock.mockClear()
    capabilities = { serverTools: {}, openLinks: {} }
    ;(globalThis as { FontFace?: unknown }).FontFace = FakeFontFace
    if (!document.fonts) {
      Object.defineProperty(document, 'fonts', { configurable: true, value: { add() {} } })
    }
  })

  afterEach(() => {
    Object.defineProperty(window, 'parent', { configurable: true, value: window })
  })

  it('a URL with a scheme opens through the host, never in the frame', async () => {
    await bootInHost()
    drawLinks('https://example.com/x')
    expect(clickLink('https://example.com/x')).toBe(true)
    expect(openLinkMock).toHaveBeenCalledExactlyOnceWith({ url: 'https://example.com/x' })
  })

  it('a document link is cancelled and opens nothing', async () => {
    await bootInHost()
    drawLinks(DOC, `#${DOC}`)
    expect(clickLink(DOC)).toBe(true)
    expect(clickLink(`#${DOC}`)).toBe(true)
    expect(openLinkMock).not.toHaveBeenCalled()
  })

  it('a relative link is cancelled and opens nothing', async () => {
    await bootInHost()
    drawLinks('guide.md')
    expect(clickLink('guide.md')).toBe(true)
    expect(openLinkMock).not.toHaveBeenCalled()
  })

  it('a host that does not advertise openLinks is not asked', async () => {
    capabilities = { serverTools: {} }
    await bootInHost()
    drawLinks('https://example.com/x')
    expect(clickLink('https://example.com/x')).toBe(true)
    expect(openLinkMock).not.toHaveBeenCalled()
  })

  it('a link is cancelled with no host at all', async () => {
    vi.resetModules()
    await import('./widget-entry.js')
    drawLinks('https://example.com/x', DOC)
    expect(clickLink('https://example.com/x')).toBe(true)
    expect(clickLink(DOC)).toBe(true)
  })

  it('a click on a link places no comment anchor; a click beside it does', async () => {
    await bootInHost()
    const svg = drawLinks(DOC)
    const anchorLabel = () =>
      document.querySelector('[data-testid="widget-comment-anchor"]')?.textContent ?? ''
    clickLink(DOC)
    expect(anchorLabel()).not.toContain('(')
    svg.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 60, bubbles: true }))
    expect(anchorLabel()).toContain('(100, 60)')
  })
})
