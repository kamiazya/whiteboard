import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Identifies the code that produced a rendered picture, for the render
 * cache's key (ADR-0027 decision 2).
 *
 * Derived from the build rather than typed by hand: a version someone has to
 * remember to bump is a guard that looks like a guard. It must also come from
 * the ARTIFACT and never from the service worker's update state — under
 * `registerType: 'prompt'` a new worker installs while the page keeps running
 * the old bundle, so a key taken from the worker would claim the new identity
 * while the old code writes the bytes. A compile-time constant travels with
 * the code that produced them and cannot drift from it.
 *
 * Every build gets a fresh id even when the renderer did not change. That
 * over-invalidates, which costs a lazy refill on the first visit after a
 * deploy; the alternative is hashing the render chunk, which is fragile for
 * what it buys.
 */
function rendererBuildId(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // A tarball or a checkout with no git available: the timestamp still
    // changes per build, which is the only property the key needs.
    return `t${Date.now().toString(36)}`
  }
}

/**
 * Spread into every vite/vitest config's `define`. Shared rather than
 * repeated because there are four of them, and `render-key.ts` reads the
 * global with no fallback — a config that forgets this throws on the first
 * key it builds instead of quietly keying every deploy the same.
 */
export const rendererBuildDefine = {
  __RENDERER_BUILD_ID__: JSON.stringify(rendererBuildId()),
}
