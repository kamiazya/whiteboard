// @vitest-environment node
/**
 * Every place the shell is rendered hands it a workspace source.
 *
 * The mark IS the switcher, and the shell states the invariant in its own
 * words: it "opens on every page — the workspace is a fact everywhere, so
 * there is always something for the popover to say". /settings broke that by
 * omission. Every child of that popover is conditional, and on that one route
 * all of them were false at once — no `workspaces` prop, and no shell status
 * either, since only DOCUMENT pages publish it. Measured in a real browser:
 * the trigger was there, the popover opened, `innerHTML.length` was 0. A
 * control that opens onto nothing, with no error anywhere.
 *
 * So this reads the ROUTE-RENDERING SOURCE rather than a list of routes.
 * A behavioural test can only cover the routes someone remembered to add to
 * it, which is the same forgetting that caused the defect; a new render site
 * shows up here whether or not anyone thought of this file.
 *
 * The subject moved one level when App's render tail became a screen per
 * mode: `<AppShellLazy>` is rendered in exactly ONE place now — `ShellFrame`,
 * the frame every full-window screen shares — and what a screen can forget is
 * the `workspaces` it hands THAT. Both halves are pinned, because the
 * one-place claim is what makes reading `<ShellFrame>` sites sufficient:
 * a screen that rendered the shell directly would be invisible to the second
 * scan while the first one goes red.
 *
 * What it pins: exactly one `<AppShellLazy>` site, and a `workspaces` source
 * at every `<ShellFrame>`. What it does NOT pin: that the source resolves to
 * anything, or that the popover is non-empty at runtime — App.test.tsx's own
 * /settings case covers the rendered outcome for that route.
 *
 * There is deliberately no exemption list. Every site can supply one today,
 * so a mechanism for skipping would be machinery for a case that does not
 * exist — and a future site that genuinely cannot should fail here and be
 * argued about, not waved through.
 */
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob(['./App.tsx', './app-screens.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * Each `<Tag …>` opening element in `source`, as its text.
 *
 * Brace depth rather than a first `>`: an attribute value is an expression,
 * and one holding a comparison would otherwise cut the element in half and
 * hide whatever came after it.
 */
function openingElements(source: string, tag: string): string[] {
  const sites: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf(`<${tag}`, from)
    if (start === -1) break
    let depth = 0
    let end = -1
    for (let i = start; i < source.length; i += 1) {
      const char = source[i]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) {
        end = i
        break
      }
    }
    // An unterminated element means the matcher is wrong, not that the file
    // is — say so rather than silently taking the rest of the file.
    expect(end, `unterminated <${tag} at index ${start}`).toBeGreaterThan(start)
    sites.push(source.slice(start, end + 1))
    from = end + 1
  }
  return sites
}

const APP = SOURCES['./App.tsx'] ?? ''
const SCREENS = SOURCES['./app-screens.tsx'] ?? ''
const SHELL_SITES = [
  ...openingElements(APP, 'AppShellLazy'),
  ...openingElements(SCREENS, 'AppShellLazy'),
]
const FRAME_SITES = [
  ...openingElements(APP, 'ShellFrame'),
  ...openingElements(SCREENS, 'ShellFrame'),
]

describe('every shell render site supplies a workspace source', () => {
  it('found both sources and a plausible number of render sites', () => {
    // Every half, because a matcher that stops matching would otherwise
    // report itself as "every site is fine" — the failure mode this whole
    // file exists to refuse, one level up.
    expect(APP.length).toBeGreaterThan(1000)
    expect(SCREENS.length).toBeGreaterThan(1000)
    expect(FRAME_SITES.length).toBeGreaterThanOrEqual(3)
  })

  it('renders the shell in exactly one place, so the frame below is the whole surface', () => {
    expect(
      SHELL_SITES.length,
      'a second AppShellLazy site is a screen that bypasses ShellFrame — and the ' +
        'workspaces check below cannot see it',
    ).toBe(1)
  })

  it('passes `workspaces` at every frame', () => {
    const missing = FRAME_SITES.filter((site) => !/\bworkspaces=\{/.test(site))
    expect(
      missing,
      'a shell rendered without a workspace source opens a popover onto nothing — ' +
        'pass browserWorkspaces or daemonWorkspaces, keyed off the same value as `daemon`',
    ).toEqual([])
  })

  it('never passes a literal undefined, which would satisfy the check and not the reader', () => {
    const hollow = FRAME_SITES.filter((site) => /\bworkspaces=\{\s*undefined\s*\}/.test(site))
    expect(hollow).toEqual([])
  })
})
