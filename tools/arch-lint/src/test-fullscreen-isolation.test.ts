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
 * Detection is textual, so it names what a REAL fullscreen needs: the API
 * call, an assertion on the real flag, or a click on the control that makes
 * the request. A file that only stubs `fullscreenElement` with
 * `Object.defineProperty` matches none of them, and a mere
 * `queryByRole('button', { name: 'Fullscreen' })` is not a click.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { listTestFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

const REAL_FULLSCREEN = [
  /\brequestFullscreen\b/,
  /expect\([^)]*\bfullscreenElement\b/,
  /\.click\([^)]*['"]Fullscreen['"]/,
]

const ISOLATED_NAME = /\.window-state\.browser\.test\.tsx?$/
const BROWSER_NAME = /\.browser\.test\.tsx?$/

function entersRealFullscreen(source: string): boolean {
  return REAL_FULLSCREEN.some((pattern) => pattern.test(source))
}

function browserFiles(): string[] {
  return TEST_SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir))).filter((file) =>
    BROWSER_NAME.test(file),
  )
}

const rel = (file: string) => relative(REPO_ROOT, file).split(sep).join('/')

describe('real fullscreen is isolated in its own browser project', () => {
  it('recognises each real shape and none of the look-alikes (self-test)', () => {
    expect(entersRealFullscreen('await document.documentElement.requestFullscreen()')).toBe(true)
    expect(entersRealFullscreen('expect(document.fullscreenElement).not.toBeNull()')).toBe(true)
    expect(
      entersRealFullscreen(
        "await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))",
      ),
    ).toBe(true)
    expect(
      entersRealFullscreen(
        "expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()",
      ),
    ).toBe(false)
    expect(
      entersRealFullscreen("Object.defineProperty(document, 'fullscreenElement', { get })"),
    ).toBe(false)
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
