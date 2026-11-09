import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOLERATED_TESTS } from '../test-utils/okf-wasm/tolerated.js'

/**
 * The other side of layer 1's list of tests it does not run: each is still
 * in its file, and still reads a refusal's message, so it is still about the
 * tolerated difference and nothing else.
 */
describe('the OKF tests layer 1 leaves to the TypeScript', () => {
  it.each(TOLERATED_TESTS)('$source is still in $file and still reads a message', (entry) => {
    const text = readFileSync(new URL(`./${entry.file}`, import.meta.url), 'utf8')
    const at = text.indexOf(`'${entry.source}'`)
    expect(at, `${entry.file} has no test titled ${entry.source}`).toBeGreaterThanOrEqual(0)
    const next = text.indexOf('\n  it', at + 1)
    expect(text.slice(at, next === -1 ? undefined : next)).toMatch(/message/)
  })
})
