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
 * What it pins: every `<AppShellLazy>` site passes a `workspaces` source.
 * What it does NOT pin: that the source resolves to anything, or that the
 * popover is non-empty at runtime — App.test.tsx's own /settings case covers
 * the rendered outcome for that route.
 *
 * There is deliberately no exemption list. Every site can supply one today,
 * so a mechanism for skipping would be machinery for a case that does not
 * exist — and a future site that genuinely cannot should fail here and be
 * argued about, not waved through.
 */
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob('./App.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Each `<AppShellLazy … />` element, as the text between the tag and its close. */
function shellRenderSites(source: string): string[] {
  const sites: string[] = []
  const TAG = '<AppShellLazy'
  let from = 0
  for (;;) {
    const start = source.indexOf(TAG, from)
    if (start === -1) break
    const end = source.indexOf('/>', start)
    // An unterminated element means the matcher is wrong, not that the file
    // is — say so rather than silently taking the rest of the file.
    expect(end, `unterminated ${TAG} at index ${start}`).toBeGreaterThan(start)
    sites.push(source.slice(start, end + 2))
    from = end + 2
  }
  return sites
}

const APP = SOURCES['./App.tsx'] ?? ''
const SITES = shellRenderSites(APP)

describe('every shell render site supplies a workspace source', () => {
  it('found App.tsx and a plausible number of render sites', () => {
    // Both halves, because a regex that stops matching would otherwise report
    // itself as "every site is fine" — the failure mode this whole file
    // exists to refuse, one level up.
    expect(APP.length).toBeGreaterThan(1000)
    expect(SITES.length).toBeGreaterThanOrEqual(4)
  })

  it('passes `workspaces` at every one of them', () => {
    const missing = SITES.filter((site) => !/\bworkspaces=\{/.test(site))
    expect(
      missing,
      'a shell rendered without a workspace source opens a popover onto nothing — ' +
        'pass browserWorkspaces or daemonWorkspaces, keyed off the same value as `daemon`',
    ).toEqual([])
  })

  it('never passes a literal undefined, which would satisfy the check and not the reader', () => {
    const hollow = SITES.filter((site) => /\bworkspaces=\{\s*undefined\s*\}/.test(site))
    expect(hollow).toEqual([])
  })
})
