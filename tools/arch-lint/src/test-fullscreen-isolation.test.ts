/**
 * A browser test that really enters fullscreen lives in the isolated
 * `web-browser-window-state` project, and a file in that project really does.
 *
 * The first half is the rule `apps/web/vitest.browser-window-state.config.ts`
 * measures: after real fullscreen, Chromium refuses `page.viewport` for the
 * next file in the same browser instance, vitest never delivers the
 * rejection, and the victim — which rotates, and passes alone — burns its
 * whole timeout and names itself. Restoring the window inside the offending
 * file does not help, so the only fix is a browser instance of its own, and
 * what routes a file there is its NAME (`*.window-state.browser.test.*`),
 * which `vitest-projects.test.ts` pins. Nothing pinned that a file which
 * NEEDS the name has it: a real-fullscreen file sat in the shared project
 * with every guard green.
 *
 * The second half keeps the suffix honest. A file that carries it without
 * touching fullscreen pays for a separate browser instance (startup and no
 * parallelism with its neighbours) for nothing, and a file that stops using
 * fullscreen should lose the name rather than keep it by inertia.
 *
 * Detection is textual, so it names what a REAL fullscreen needs, by every
 * spelling the file can enter or observe it in: the API call; any click whose
 * target is named for fullscreen (a string, a regex, a role query, a variable
 * the control was bound to first); the F11 key; and the real state or its
 * event, which a test reads whatever way it got there (`expect`, `vi.waitFor`,
 * `expect.poll`, a `fullscreenchange` listener behind a keyboard shortcut).
 * The state and the event count only in a file that does not STUB the flag —
 * a file that stubs `fullscreenElement` with `Object.defineProperty` or
 * `vi.spyOn` and dispatches `fullscreenchange` itself never enters, and a mere
 * `queryByRole('button', { name: 'Fullscreen' })` is not a click.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { listTestFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

const ALWAYS_REAL_FULLSCREEN = [
  /\brequestFullscreen\b/,
  /expect\([^)]*\bfullscreenElement\b/,
  // A click aimed at the control, on one line or wrapped onto the next.
  /\.click\(\s*(?:\n\s*)?[^\n]{0,160}\bfullscreen\b/i,
  // A locator chain: `getByRole('button', { name: /fullscreen/i }).click()`.
  /(?:getBy|findBy|locator)\w*\([^\n]{0,120}\bfullscreen\b[^\n]{0,80}\.click\(/i,
  /['"{]F11\b/,
]

// What a test reads of the real thing, or waits on. Real only when the file
// does not stub the flag itself (STUBBED_FLAG).
const REAL_FLAG_OR_EVENT =
  /\b(?:webkit)?[fF]ullscreenElement\b|\bfullscreenchange\b|\bexitFullscreen\b/
const STUBBED_FLAG =
  /(?:defineProperty|spyOn)\(\s*[^,\n]+,\s*['"](?:webkit)?[fF]ullscreenElement['"]/

// `const button = screen.getByRole('button', { name: 'Fullscreen' })` and
// then `click(button)` / `button.click()`: the click names no fullscreen.
const BOUND_FULLSCREEN_QUERY =
  /(?:const|let)\s+(\w+)\s*=\s*[^\n]*(?:(?:get|find|query)(?:All)?By\w*|locator)\([\s\S]{0,120}?\bfullscreen\b/gi

const ISOLATED_NAME = /\.window-state\.browser\.test\.tsx?$/
const BROWSER_NAME = /\.browser\.test\.tsx?$/

function clicksBoundFullscreenControl(source: string): boolean {
  return [...source.matchAll(BOUND_FULLSCREEN_QUERY)].some(([, name]) =>
    new RegExp(`\\bclick\\(\\s*${name}\\b|\\b${name}\\.click\\(`).test(source),
  )
}

function entersRealFullscreen(source: string): boolean {
  return (
    ALWAYS_REAL_FULLSCREEN.some((pattern) => pattern.test(source)) ||
    clicksBoundFullscreenControl(source) ||
    (REAL_FLAG_OR_EVENT.test(source) && !STUBBED_FLAG.test(source))
  )
}

// Each is a way a file really enters or observes fullscreen, and was missed
// by the first three-shape version of this scan.
const REAL_SHAPES: Readonly<Record<string, string>> = {
  'the API call': 'await document.documentElement.requestFullscreen()',
  'expect on the flag': 'expect(document.fullscreenElement).not.toBeNull()',
  'a click on a quoted name':
    "await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))",
  'a click on a regex name':
    "await userEvent.click(screen.getByRole('button', { name: /fullscreen/i }))",
  'a click on a wrapped query':
    "await userEvent.click(\n    within(bar).getByRole('button', { name: 'Fullscreen' }),\n  )",
  'a locator chain': "await page.getByRole('button', { name: /fullscreen/i }).click()",
  'a click on a variable bound first':
    "const button = await screen.findByRole('button', { name: 'Fullscreen' })\nawait userEvent.click(button)",
  'a method click on a variable bound first':
    'const toggle = screen.getByLabelText(/fullscreen/i)\nawait toggle.click()',
  'expect.poll on the flag': 'await expect.poll(() => document.fullscreenElement).toBeTruthy()',
  'vi.waitFor on the flag': 'await vi.waitFor(() => document.fullscreenElement !== null)',
  'an exitFullscreen call': 'await document.exitFullscreen()',
  'the F11 key': "await userEvent.keyboard('{F11}')",
  'a shortcut then a fullscreenchange listener':
    "await userEvent.keyboard('{Control>}{Shift>}f{/Shift}{/Control}')\nawait new Promise((done) => document.addEventListener('fullscreenchange', done, { once: true }))",
}

const LOOK_ALIKES: Readonly<Record<string, string>> = {
  'a query asserted absent':
    "expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()",
  'a stub through defineProperty': "Object.defineProperty(document, 'fullscreenElement', { get })",
  'a stub through defineProperty with its own event':
    "Object.defineProperty(document, 'fullscreenElement', { get: () => el })\ndocument.dispatchEvent(new Event('fullscreenchange'))",
  'a stub through spyOn': "vi.spyOn(document, 'fullscreenElement', 'get').mockReturnValue(el)",
  'a variable bound and never clicked':
    "const button = screen.getByRole('button', { name: 'Fullscreen' })\nexpect(button).toBeTruthy()",
  'a click unrelated to fullscreen on a neighbouring line':
    "await userEvent.click(save)\nexpect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()",
}

function browserFiles(): string[] {
  return TEST_SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir))).filter((file) =>
    BROWSER_NAME.test(file),
  )
}

const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join('/')

describe('real fullscreen is isolated in its own browser project', () => {
  it.each(Object.entries(REAL_SHAPES))('recognises %s (self-test)', (_shape, source) => {
    expect(entersRealFullscreen(source)).toBe(true)
  })

  it.each(
    Object.entries(LOOK_ALIKES),
  )('does not mistake %s for real fullscreen (self-test)', (_shape, source) => {
    expect(entersRealFullscreen(source)).toBe(false)
  })

  it('has no real-fullscreen browser test outside the window-state project', () => {
    const offenders = browserFiles()
      .filter((file) => !ISOLATED_NAME.test(file))
      .filter((file) => entersRealFullscreen(readFileSync(file, 'utf-8')))
      .map(
        (file) =>
          `${rel(file)}: enters real fullscreen — name it *.window-state.browser.test.tsx so it runs in web-browser-window-state, or the next file that resizes the window hangs`,
      )
    expect(offenders).toEqual([])
  })

  it('has no window-state file that never enters fullscreen', () => {
    const unearned = browserFiles()
      .filter((file) => ISOLATED_NAME.test(file))
      .filter((file) => !entersRealFullscreen(readFileSync(file, 'utf-8')))
      .map(
        (file) =>
          `${rel(file)}: carries the window-state suffix but never enters real fullscreen — drop the suffix so it shares the web-browser project`,
      )
    expect(unearned).toEqual([])
  })

  it('reaches the population it governs', () => {
    // A scan that matched nothing reads as a clean tree.
    const files = browserFiles()
    expect(files.length).toBeGreaterThan(100)
    const isolated = files.filter((file) => ISOLATED_NAME.test(file))
    expect(isolated.length).toBeGreaterThanOrEqual(3)
  })
})
