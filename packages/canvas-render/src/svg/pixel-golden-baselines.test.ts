import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The pixel-golden baseline set is linux-only and complete. CI is linux, so
 * a baseline for any other platform is one nothing checks: it drifts
 * unreviewed, and its presence suggests that platform is covered. A scene
 * with no linux baseline makes Vitest write one from the local render and
 * fail, which on CI reads as a rendering regression.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE_DIR = join(HERE, '__screenshots__', 'pixel-golden.browser.test.ts')
const BASELINE_SUFFIX = '-chromium-linux.png'

function screenshotNames(): string[] {
  const source = readFileSync(join(HERE, 'pixel-golden.browser.test.ts'), 'utf8')
  return [...source.matchAll(/toMatchScreenshot\(\s*'([^']+)'/g)].map((m) => m[1] ?? '')
}

describe('pixel-golden baselines', () => {
  it('reads every screenshot the browser harness takes', () => {
    // A floor, so a changed call shape that the pattern stops matching
    // cannot leave the checks below passing over nothing.
    expect(screenshotNames().length).toBeGreaterThanOrEqual(8)
  })

  it('has a committed linux baseline for every screenshot', () => {
    const files = new Set(readdirSync(BASELINE_DIR))
    const missing = screenshotNames().filter((name) => !files.has(`${name}${BASELINE_SUFFIX}`))
    expect(missing).toEqual([])
  })

  it('holds no baseline for a platform CI does not run', () => {
    const others = readdirSync(BASELINE_DIR).filter((file) => !file.endsWith(BASELINE_SUFFIX))
    expect(others).toEqual([])
  })

  it('holds no baseline for a screenshot the harness no longer takes', () => {
    const names = new Set(screenshotNames())
    const orphans = readdirSync(BASELINE_DIR).filter(
      (file) =>
        file.endsWith(BASELINE_SUFFIX) && !names.has(file.slice(0, -BASELINE_SUFFIX.length)),
    )
    expect(orphans).toEqual([])
  })

  // The browser harness skips off linux. That skip must be impossible where
  // the baselines are actually checked.
  it.runIf(process.env.CI)('runs on linux on CI, where the pixel goldens must not skip', () => {
    expect(
      process.platform,
      'CI is no longer linux, so every pixel golden is being skipped there — find out why before trusting this run',
    ).toBe('linux')
  })
})
