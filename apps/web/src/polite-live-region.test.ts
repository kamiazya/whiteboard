/**
 * A polite live region must be in the DOM BEFORE the text it announces.
 *
 * A `role="status"` element inserted already carrying its message is
 * announced inconsistently — Safari with VoiceOver and several NVDA setups
 * miss it — while one that is already mounted when its text changes is
 * announced reliably. Rendering it as `{busy && <span role="status">…}` is
 * therefore a silent accessibility bug: it looks correct, tests green, and
 * the message simply never reaches the person who needed it most.
 *
 * `role="alert"` is deliberately NOT covered. Injecting an alert with its
 * content is the widely-supported pattern for form errors, and sweeping the
 * repo's fifteen of them into always-mounted containers would be churn
 * without a defect behind it.
 *
 * Sources come from Vite's build-time `import.meta.glob` (raw text), the
 * same shape as daemon-auth-seam.test.ts, so this needs no `node:fs` —
 * apps/web is browser-only (see web-app-boundary.test.ts).
 */
import { describe, expect, it } from 'vitest'

const sourceModules = import.meta.glob('./**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/**
 * A live region whose CONTENT is a layout placeholder rather than a
 * sentence. Mounting an empty skeleton grid permanently would put an
 * invisible four-cell scaffold in every list page to announce nothing; the
 * arrival of the real content is what these tell someone about, and that is
 * a DOM replacement they perceive either way.
 */
const SKELETON_EXCEPTIONS = ['./pages/BrowserLocalIndexPage.tsx', './pages/DaemonIndexPage.tsx']

/**
 * `{cond && <el ... role="status"`, across the line breaks a formatter puts
 * between the opening brace and the role. Deliberately loose about what sits
 * between: any conditional that gates a status element is the bug, whatever
 * the guard expression looks like.
 */
const CONDITIONAL_STATUS = /(?:&&|\?)\s*\(?\s*<[a-zA-Z][^>]{0,400}?role="status"/gs

function offendingLines(source: string): number[] {
  return [...source.matchAll(CONDITIONAL_STATUS)].map(
    (m) => source.slice(0, m.index).split('\n').length,
  )
}

describe('polite live regions are mounted before they speak', () => {
  it('scans a plausible number of sources, so a broken glob cannot pass vacuously', () => {
    expect(Object.keys(sourceModules).length).toBeGreaterThan(30)
    expect(Object.values(sourceModules).join('')).toContain('role="status"')
  })

  it('has no role="status" element behind a conditional render', () => {
    const offenders = Object.entries(sourceModules)
      .filter(([path]) => !path.includes('.test.') && !SKELETON_EXCEPTIONS.includes(path))
      .flatMap(([path, source]) => offendingLines(source).map((line) => `${path}:${line}`))

    expect(
      offenders,
      `Mount the region and change its text instead — a role="status" that arrives WITH its message is announced inconsistently: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
