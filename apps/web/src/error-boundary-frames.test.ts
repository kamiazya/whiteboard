// @vitest-environment node
/**
 * Every frame that mounts a document page holds an `ErrorBoundary` OUTSIDE
 * each of its `Suspense`s, and the one around a Suspense that switches pages
 * carries a `resetKey`.
 *
 * A rejected lazy chunk propagates through Suspense to the nearest boundary.
 * A frame with none above its Suspense hands the failure to boot's root
 * boundary, which replaces the frame's header and notices with the error
 * screen. So each frame's boundary sits inside the frame, around the page
 * alone — `ShellFrame`'s around its children, `DaemonWorkspacePages`' inside
 * the server-mode and daemon frames — and boot's root boundary stays the
 * floor for a failure in the shell itself; no frame keeps a second boundary
 * outside its chrome.
 *
 * A frame stays mounted while the route changes which page it shows, so a
 * boundary with no `resetKey` holds a failed page's error screen over the
 * next page the person opens. The switch is recognised by a conditional
 * expression inside the Suspense, and the boundary that must reset is the
 * innermost one around it.
 *
 * Every test of a page stays green either way, so the duty is the frame's and
 * is checked here, beside `keeper-notices-frames.test.ts`, which checks the
 * frame's other one.
 *
 * Checked per file, over the JSX text with comments stripped: an opening
 * `<Suspense` must sit inside an open `<ErrorBoundary>`, or inside a component
 * the same file defines whose body renders one (`ShellFrame`).
 *
 * Blind spot: a boundary supplied by ANOTHER module's wrapper component is not
 * seen; the frame would be reported, and the wrapper should then live in the
 * frame's file or the check learn its name.
 */
import { describe, expect, it } from 'vitest'
import { stripComments } from './test-utils/strip-comments.js'

const sourceModules = import.meta.glob('./**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const PAGE = '(?:Daemon|Browser)DocumentPage'
const IMPORT_ALIAS = new RegExp(String.raw`\b${PAGE}\s+as\s+(\w+)`, 'g')
const LAZY_BINDING = new RegExp(
  String.raw`\b(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\([^)]*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\(\{\s*default:\s*\2\.${PAGE}\b`,
  'g',
)
const BOUNDARY = 'ErrorBoundary'
const FUNCTION_DECLARATION = /\bfunction\s+([A-Z]\w*)\s*\(/g

function holdsPage(code: string): boolean {
  const names = [
    PAGE,
    ...[...code.matchAll(IMPORT_ALIAS)].map((m) => m[1]),
    ...[...code.matchAll(LAZY_BINDING)].map((m) => m[1]),
  ]
  return new RegExp(String.raw`<(?:${names.join('|')})[\s/>]`).test(code)
}

/** Where the JSX tag opened at `start` ends, skipping `>` inside `{…}` attributes. */
function tagEnd(code: string, start: number): { end: number; selfClosing: boolean } {
  let depth = 0
  for (let i = start; i < code.length; i++) {
    const ch = code[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return { end: i, selfClosing: code[i - 1] === '/' }
  }
  return { end: code.length, selfClosing: true }
}

const RESET_KEY = /\bresetKey\s*=/

/**
 * Whether `body` renders `{children}` between a boundary's opening and
 * closing tags — and if so, whether that boundary resets.
 */
function boundaryAroundChildren(body: string): { resets: boolean } | null {
  const open = body.indexOf(`<${BOUNDARY}`)
  if (open < 0) return null
  const close = body.indexOf(`</${BOUNDARY}>`, open)
  if (close < 0 || !/\{\s*(?:props\.)?children\s*\}/.test(body.slice(open, close))) return null
  return { resets: RESET_KEY.test(body.slice(open, tagEnd(body, open).end)) }
}

/** Components this file defines whose own body wraps its children in a boundary. */
function boundaryWrappers(code: string): Map<string, { resets: boolean }> {
  const declarations = [...code.matchAll(FUNCTION_DECLARATION)]
  const wrappers = new Map<string, { resets: boolean }>()
  declarations.forEach((m, i) => {
    const wrapper = boundaryAroundChildren(
      code.slice(m.index, declarations[i + 1]?.index ?? code.length),
    )
    if (wrapper !== null) wrappers.set(m[1] as string, wrapper)
  })
  return wrappers
}

interface SuspenseSite {
  readonly line: number
  /** Whether a boundary encloses it, and whether the innermost one resets. */
  readonly guard: 'none' | 'resets' | 'holds'
  /** Whether its children choose between pages, so the route changes what it shows. */
  readonly switches: boolean
}

/** Every `<Suspense` opening, with the boundary that encloses it. */
function suspenseSites(source: string): SuspenseSite[] {
  const code = stripComments(source)
  const wrappers = boundaryWrappers(code)
  const guards = [BOUNDARY, ...wrappers.keys()]
  const tag = new RegExp(String.raw`<(/?)(${[...guards, 'Suspense'].join('|')})\b`, 'g')
  // Innermost last: whether each open boundary carries a resetKey.
  const open: boolean[] = []
  const sites: SuspenseSite[] = []
  for (const m of code.matchAll(tag)) {
    const [, closing, name] = m
    const end = tagEnd(code, m.index)
    if (name === 'Suspense') {
      if (closing === '/') continue
      const close = code.indexOf('</Suspense>', end.end)
      const innermost = open.at(-1)
      sites.push({
        line: code.slice(0, m.index).split('\n').length,
        guard: innermost === undefined ? 'none' : innermost ? 'resets' : 'holds',
        switches: /\s\?\s/.test(code.slice(end.end, close < 0 ? code.length : close)),
      })
      continue
    }
    // A stray closing tag pops nothing, so it cannot bank an enclosure for what follows.
    if (closing === '/') open.pop()
    else if (!end.selfClosing) {
      open.push(
        name === BOUNDARY
          ? RESET_KEY.test(code.slice(m.index, end.end))
          : (wrappers.get(name as string)?.resets ?? false),
      )
    }
  }
  return sites
}

/** Each `<Suspense` opening that no boundary encloses, by line number. */
function unguardedSuspenses(source: string): number[] {
  return suspenseSites(source)
    .filter((site) => site.guard === 'none')
    .map((site) => site.line)
}

/** Each page-switching `<Suspense` whose enclosing boundary never resets, by line number. */
function unresetSwitches(source: string): number[] {
  return suspenseSites(source)
    .filter((site) => site.switches && site.guard === 'holds')
    .map((site) => site.line)
}

const frames = Object.entries(sourceModules)
  .filter(
    ([path]) =>
      !path.includes('.test.') &&
      !path.includes('/test-utils/') &&
      !path.includes('/docs-snapshots/'),
  )
  .filter(([, source]) => holdsPage(stripComments(source)))

describe('frames that hold a document page', () => {
  it('see a Suspense with no boundary above it, and a boundary however it is supplied (self-test)', () => {
    expect(unguardedSuspenses('<main><Suspense><DaemonDocumentPage /></Suspense></main>')).toEqual([
      1,
    ])
    expect(
      unguardedSuspenses(
        '<ErrorBoundary>\n<Suspense><DaemonDocumentPage /></Suspense>\n</ErrorBoundary>',
      ),
    ).toEqual([])
    // Closed before the Suspense opens: a sibling, not an ancestor.
    expect(
      unguardedSuspenses('<ErrorBoundary>x</ErrorBoundary>\n<Suspense><Page /></Suspense>'),
    ).toEqual([2])
    // Self-closing boundary encloses nothing, even with `>` in an attribute.
    expect(
      unguardedSuspenses(
        '<ErrorBoundary fallback={() => <p>x</p>} />\n<Suspense><Page /></Suspense>',
      ),
    ).toEqual([2])
    expect(
      unguardedSuspenses(
        'function Frame({ children }) { return <ErrorBoundary>{children}</ErrorBoundary> }\n' +
          'function Screen() { return <Frame><Suspense><Page /></Suspense></Frame> }',
      ),
    ).toEqual([])
    // A wrapper whose boundary guards only a sibling of its children guards nothing.
    expect(
      unguardedSuspenses(
        'function Frame({ children }) { return <><ErrorBoundary><Header /></ErrorBoundary>{children}</> }\n' +
          'function Screen() { return <Frame><Suspense><Page /></Suspense></Frame> }',
      ),
    ).toEqual([2])
    // A stray closing tag does not bank an enclosure for what follows.
    expect(unguardedSuspenses('</ErrorBoundary>\n<Suspense><Page /></Suspense>')).toEqual([2])
    // A commented-out boundary is not a boundary.
    expect(unguardedSuspenses('{/* <ErrorBoundary> */}\n<Suspense><Page /></Suspense>')).toEqual([
      2,
    ])
  })

  it('are found, so a broken scan cannot pass over nothing', () => {
    expect(frames.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./app-screens.tsx', './pages/DaemonWorkspacePages.tsx']),
    )
  })

  it('each hold an error boundary outside every Suspense', () => {
    const missing = frames
      .map(([path, source]) => [path, unguardedSuspenses(source)] as const)
      .filter(([, lines]) => lines.length > 0)
      .map(([path, lines]) => `${path}:${lines.join(',')}`)
    expect(missing, `a Suspense with no ErrorBoundary above it: ${missing.join('; ')}`).toEqual([])
  })

  it('see a page switch whose boundary never resets, through a wrapper too (self-test)', () => {
    const page = '<Suspense>{a ? <Index /> : <Doc />}</Suspense>'
    expect(unresetSwitches(`<ErrorBoundary>\n${page}\n</ErrorBoundary>`)).toEqual([2])
    expect(unresetSwitches(`<ErrorBoundary resetKey={path}>\n${page}\n</ErrorBoundary>`)).toEqual(
      [],
    )
    // The innermost boundary is the one that catches, so it is the one that must reset.
    expect(
      unresetSwitches(
        `<ErrorBoundary resetKey={path}><ErrorBoundary>\n${page}\n</ErrorBoundary></ErrorBoundary>`,
      ),
    ).toEqual([2])
    // A Suspense over one page switches nothing.
    expect(
      unresetSwitches('<ErrorBoundary>\n<Suspense><Page /></Suspense>\n</ErrorBoundary>'),
    ).toEqual([])
    const frame = (attrs: string) =>
      `function Frame({ children }) { return <ErrorBoundary${attrs}>{children}</ErrorBoundary> }\n` +
      `function Screen() { return <Frame>${page}</Frame> }`
    expect(unresetSwitches(frame(''))).toEqual([2])
    expect(unresetSwitches(frame(' resetKey={pathname}'))).toEqual([])
  })

  it('reset the boundary around every Suspense that switches pages', () => {
    const switches = frames.flatMap(([, source]) =>
      suspenseSites(source).filter((site) => site.switches),
    )
    // A switch detector that matched nothing would make the check below vacuous.
    expect(switches.length).toBeGreaterThanOrEqual(2)
    const held = frames
      .map(([path, source]) => [path, unresetSwitches(source)] as const)
      .filter(([, lines]) => lines.length > 0)
      .map(([path, lines]) => `${path}:${lines.join(',')}`)
    expect(held, `a page switch whose boundary has no resetKey: ${held.join('; ')}`).toEqual([])
  })
})
