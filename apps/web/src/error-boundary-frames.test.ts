// @vitest-environment node
/**
 * Every frame that mounts a document page holds an `ErrorBoundary` OUTSIDE
 * each of its `Suspense`s.
 *
 * A rejected lazy chunk propagates through Suspense to the nearest boundary.
 * A frame with none above its Suspense hands the failure to the root, which
 * either unmounts to a blank window or — under boot's root boundary — replaces
 * the frame's header and notices with the error screen. Every test of a page
 * stays green either way, so the duty is the frame's and is checked here,
 * beside `keeper-notices-frames.test.ts`, which checks the frame's other one.
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

/** Components this file defines whose own body renders a boundary. */
function boundaryWrappers(code: string): string[] {
  const declarations = [...code.matchAll(FUNCTION_DECLARATION)]
  return declarations
    .filter((m, i) =>
      code.slice(m.index, declarations[i + 1]?.index ?? code.length).includes(`<${BOUNDARY}`),
    )
    .map((m) => m[1] as string)
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

/** Each `<Suspense` opening that no boundary encloses, by line number. */
function unguardedSuspenses(source: string): number[] {
  const code = stripComments(source)
  const guards = [BOUNDARY, ...boundaryWrappers(code)]
  const tag = new RegExp(String.raw`<(/?)(${[...guards, 'Suspense'].join('|')})\b`, 'g')
  let open = 0
  const unguarded: number[] = []
  for (const m of code.matchAll(tag)) {
    const [, closing, name] = m
    if (name === 'Suspense') {
      if (closing === '' && open === 0) unguarded.push(code.slice(0, m.index).split('\n').length)
      continue
    }
    // Clamped: a stray closing tag must not leave a later Suspense counted as enclosed.
    if (closing === '/') open = Math.max(0, open - 1)
    else if (!tagEnd(code, m.index).selfClosing) open++
  }
  return unguarded
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
    // A stray closing tag does not bank an enclosure for what follows.
    expect(unguardedSuspenses('</ErrorBoundary>\n<Suspense><Page /></Suspense>')).toEqual([2])
    // A commented-out boundary is not a boundary.
    expect(unguardedSuspenses('{/* <ErrorBoundary> */}\n<Suspense><Page /></Suspense>')).toEqual([
      2,
    ])
  })

  it('are found, so a broken scan cannot pass over nothing', () => {
    expect(frames.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./app-screens.tsx', './pages/ServerModeWorkspace.tsx']),
    )
  })

  it('each hold an error boundary outside every Suspense', () => {
    const missing = frames
      .map(([path, source]) => [path, unguardedSuspenses(source)] as const)
      .filter(([, lines]) => lines.length > 0)
      .map(([path, lines]) => `${path}:${lines.join(',')}`)
    expect(missing, `a Suspense with no ErrorBoundary above it: ${missing.join('; ')}`).toEqual([])
  })
})
