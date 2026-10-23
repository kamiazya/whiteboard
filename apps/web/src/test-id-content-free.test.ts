// @vitest-environment node
/**
 * A `data-testid` never carries document content.
 *
 * The editor's gesture trace records the nearest `data-testid` of every
 * press anywhere on the page (`describeTarget` in gesture-trace.ts), and a
 * trace is something a user is asked to copy into a bug report. A test id
 * spelled from a folder path, a document name or a facet value puts that
 * content into the report without the user seeing it there.
 *
 * So every value a test id is spelled from — a template hole, an operand
 * concatenated onto a literal, a bare value standing as the whole id, or the
 * same inside a precomputed `const testId = …` — is held to a ledger of
 * identities that say nothing about what a document holds: an id, an enum
 * member. A forwarded `testId` prop is the one name read through rather than
 * ledgered, because every `testId={…}` that sets it is scanned here too.
 * Both-sided — an entry with no matching site fails too, so the ledger
 * cannot outlive the code it excuses. `?raw` rather than `node:fs`: apps/web
 * is browser-only.
 *
 * A regex reading, not a parse: it over-reports (a nested ternary's inner
 * condition reads as a value) and the ledger absorbs that, which is the
 * safe direction for a guard.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['./**/*.tsx', '!./**/*.test.tsx'], {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/** `file expression` → why that interpolation carries no content. */
const CONTENT_FREE: Record<string, string> = {
  './components/workspace-files/NewDocumentMenu.tsx kind': 'a document kind, a closed enum',
  './components/ui/InspectorPanel.tsx kind': 'the inspector section kind, an enum',
  './components/settings/LocalCopiesCard.tsx row.workspaceId': 'a generated workspace id',
  './components/settings/ReplicaOfflineControl.tsx target.workspaceId': 'a generated workspace id',
  './components/annotations/message-meta.tsx thread.id': 'a generated thread id',
  './components/annotations/thread-row.tsx message.id': 'a generated message id',
  './components/spatial-editor/CommentThreadCard.tsx message.id': 'a generated message id',
  './components/annotations/thread-row.tsx thread.id': 'a generated thread id',
  './components/spatial-editor/EdgeEndHandles.tsx endpoint': "'from' | 'to'",
  './components/spatial-editor/ToolPalette.tsx id': "the dock zoom pair's shortcut id, 'zoom-in' | 'zoom-out'",
  './components/spatial-editor/BoxTargetOverlay.tsx b.id': 'a node id',
  './components/spatial-editor/TextNodeEditor.tsx testId': 'a test id passed in by the caller',
  './components/spatial-editor/SelectionOverlay.tsx band.kind': 'a resize handle kind, an enum',
  './components/spatial-editor/SelectionOverlay.tsx hit.kind': 'a resize handle kind, an enum',
  './components/spatial-editor/SelectionOverlay.tsx side.kind': 'a box side, an enum',
  './pages/ReplicaReadPage.tsx state': 'the replica page state, an enum',
}

/**
 * The expression inside `data-testid={…}` — or a `testId={…}` prop, which a
 * component forwards to one — by brace depth so a nested `${}` does not end it.
 * A `const testId = …` precomputes one, so its right-hand side, to the end of
 * the line, is read too.
 */
function testIdExpressions(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/(?:data-testid|testId)=\{/g)) {
    const start = match.index + match[0].length
    let depth = 1
    let cursor = start
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1
      else if (source[cursor] === '}') depth -= 1
      cursor += 1
    }
    found.push(source.slice(start, cursor - 1))
  }
  for (const match of source.matchAll(/\b(?:const|let)\s+testId\s*=\s*([^\n]*)/g)) {
    found.push(match[1] ?? '')
  }
  return found
}

const TEMPLATE = /`(?:[^`\\]|\\.)*`/g
const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g
/** An identifier or a member chain: `folder`, `entry.value`, `row.meta.name`. */
const BARE_VALUE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/
/** The forwarded prop: its value is spelled at a `testId={…}` site, read on its own. */
const FORWARDED = 'testId'

/**
 * The values an expression spells its id from outside a template: with every
 * literal blanked, each ternary branch after the condition is either a
 * concatenation, whose non-literal operands are values, or a bare value.
 */
function concatenatedValues(expression: string): string[] {
  const blanked = expression.replace(TEMPLATE, "''").replace(QUOTED, "''")
  const segments = blanked.split(/[?:]/)
  const values: string[] = []
  segments.forEach((segment, index) => {
    if (segment.includes('+')) {
      for (const operand of segment.split('+')) {
        const value = operand.trim()
        if (value !== "''" && value !== '') values.push(value)
      }
      return
    }
    const value = segment.trim()
    const isCondition = index === 0 && segments.length > 1
    if (!isCondition && BARE_VALUE.test(value) && value !== FORWARDED) values.push(value)
  })
  return values
}

/** Every `file expression` a test id is spelled from. */
function interpolations(entries: Record<string, string>): string[] {
  const found = new Set<string>()
  for (const [path, source] of Object.entries(entries)) {
    for (const expression of testIdExpressions(source)) {
      for (const hole of expression.matchAll(/\$\{([^}]*)\}/g)) {
        found.add(`${path} ${(hole[1] ?? '').trim()}`)
      }
      for (const value of concatenatedValues(expression)) found.add(`${path} ${value}`)
    }
  }
  return [...found].sort()
}

describe('a data-testid carries no document content', () => {
  it('scans a real population, so a clean result cannot mean the glob matched nothing', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100)
    expect(interpolations(sources).length).toBeGreaterThan(8)
  })

  it('interpolates only ledgered content-free identities', () => {
    expect(interpolations(sources).filter((site) => !(site in CONTENT_FREE))).toEqual([])
  })

  it('keeps no ledger entry for an interpolation that is gone', () => {
    const live = new Set(interpolations(sources))
    expect(Object.keys(CONTENT_FREE).filter((site) => !live.has(site))).toEqual([])
  })

  it('reads a hole inside a conditional and a call, so clean means clean rather than blind', () => {
    expect(
      interpolations({
        './x.tsx': `<b data-testid={on ? 'a' : \`row-\${label(entry.value)}\`} />`,
      }),
    ).toEqual(['./x.tsx label(entry.value)'])
    expect(interpolations({ './x.tsx': `<Notice testId={\`n-\${row.name}\`} />` })).toEqual([
      './x.tsx row.name',
    ])
    expect(interpolations({ './x.tsx': `<b data-testid="static" />` })).toEqual([])
  })

  it('reads an operand concatenated onto a literal, on either side', () => {
    expect(interpolations({ './x.tsx': `<b data-testid={'legend-' + entry.value} />` })).toEqual([
      './x.tsx entry.value',
    ])
    expect(
      interpolations({ './x.tsx': `<b data-testid={on ? "a" : row.name + '-row'} />` }),
    ).toEqual(['./x.tsx row.name'])
  })

  it('reads a bare value standing as the whole id, but not the forwarded testId prop', () => {
    expect(interpolations({ './x.tsx': `<b data-testid={entry.value} />` })).toEqual([
      './x.tsx entry.value',
    ])
    expect(interpolations({ './x.tsx': `<b data-testid={on ? 'a' : folder} />` })).toEqual([
      './x.tsx folder',
    ])
    expect(interpolations({ './x.tsx': `<b data-testid={testId} />` })).toEqual([])
    expect(
      interpolations({ './x.tsx': `<b data-testid={side.kind === 'e' ? 'a' : 'b'} />` }),
    ).toEqual([])
  })

  it('reads a test id precomputed into a testId variable', () => {
    expect(
      interpolations({
        './x.tsx': `const testId = \`copy-\${target.path}\`\n<b data-testid={testId} />`,
      }),
    ).toEqual(['./x.tsx target.path'])
  })
})
