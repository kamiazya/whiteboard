/**
 * Both document pages hand SpatialEditorPane the SAME wiring, minus a small
 * declared per-page set. The shared props are locals produced by seven
 * different hooks/memos, so a bundling helper would be a fifteen-field
 * pass-through that removes no duplication at the source — what actually
 * bites is DRIFT: a capability wired into one page's pane and silently
 * absent from the other (the class the unify work kept finding). A source
 * scan pins the prop SETS equal instead; each page's own tests keep judging
 * the values.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('./{BrowserDocumentPage,DaemonDocumentPage}.tsx', {
  query: '?raw',
  import: 'default',
})

async function paneProps(page: string): Promise<readonly string[]> {
  const loader = sources[page]
  expect(loader, `no source loader for ${page}`).toBeDefined()
  const source = (await loader?.()) as string
  const open = source.indexOf('<SpatialEditorPane')
  expect(open, `${page} renders no SpatialEditorPane`).toBeGreaterThan(-1)
  // The opening tag ends at the first '>' whose brace depth is zero —
  // props hold arrow functions and objects, so a plain indexOf('>') lands
  // inside `() =>` or a generic. Track {} and () depth instead.
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{' || ch === '(') depth++
    else if (ch === '}' || ch === ')') depth--
    else if (ch === '>' && depth === 0 && source[i - 1] !== '=') {
      end = i
      break
    }
  }
  expect(end, `${page}: SpatialEditorPane opening tag never closes`).toBeGreaterThan(open)
  const tag = source.slice(open, end)
  return [...tag.matchAll(/^\s+([A-Za-z][\w]*)=/gm)].map((m) => m[1] as string)
}

// Wired on the daemon page only, each for a reason its page carries:
// editorRef + agentTouchedNodeIds serve the agent-presence surface, which
// has no browser-kept counterpart yet.
const DAEMON_ONLY = ['editorRef', 'agentTouchedNodeIds']

describe('SpatialEditorPane wiring conformance', () => {
  it('the two pages pass the same props, minus the declared daemon-only set', async () => {
    const browser = await paneProps('./BrowserDocumentPage.tsx')
    const daemon = await paneProps('./DaemonDocumentPage.tsx')
    // Guard the allowlist from both sides: an entry must exist in daemon and
    // stay absent from browser, or it is stale.
    for (const name of DAEMON_ONLY) {
      expect(daemon, `${name} is allowlisted daemon-only but daemon does not pass it`).toContain(
        name,
      )
      expect(
        browser,
        `${name} is allowlisted daemon-only but the browser page passes it too — retire the entry`,
      ).not.toContain(name)
    }
    const shared = (props: readonly string[]) =>
      props.filter((name) => !DAEMON_ONLY.includes(name)).sort()
    // Not vacuous: a broken tag parser would answer two identical EMPTY
    // lists. These four are load-bearing wiring that must be present at all.
    for (const name of ['onChange', 'threads', 'fileRefOptions', 'nodeInEditor']) {
      expect(shared(browser), `parser lost ${name} — scan broken?`).toContain(name)
    }
    expect(shared(browser)).toEqual(shared(daemon))
  })
})
