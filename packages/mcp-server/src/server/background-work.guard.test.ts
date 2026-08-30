import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A background worker must be declared before it can be armed.
 *
 * The registry (`background-work.ts`) asks three questions a diff otherwise
 * never asks: what triggers this, does every instance run it, and what does
 * it cost the loop that is serving requests. Two of those answers were got
 * wrong on the same worker — the backup pass ran on every instance, and
 * inside the serving process, where its snapshot blocks the event loop for
 * seconds.
 *
 * Types force a declaration for anything passed to `startBackgroundWork`.
 * What types cannot force is someone reaching past it: `myWorker.start()`
 * beside the registry call arms a worker that answered nothing. That is the
 * one bypass, and this closes it.
 *
 * The limit, said plainly: this guards how a long-lived worker is ARMED in a
 * composition root, which is where every one of them is armed today. A worker
 * that arms itself at module load, or from somewhere else entirely, is caught
 * by nothing here — `.claude/rules/architecture-map.md` covers that, and
 * prose is the weaker rung on purpose.
 */
const COMPOSITION_ROOTS = ['http-server.ts', 'server-mode-http.ts'] as const

/**
 * Every `.start()` in `source` that is NOT inside the registry call.
 *
 * Arming through `startBackgroundWork` is the point, so its own argument —
 * where a worker is wrapped as `start: () => sweeper.start()` — is excluded
 * by span rather than by name.
 */
function bypassedStartCalls(source: string): string[] {
  // Comments first: the composition roots discuss `.start()` in prose, and so
  // does this file.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const registry = registrySpan(code)
  return [...code.matchAll(/(\w[\w.?]*)\.start\(\)/g)]
    .filter((match) => {
      const at = match.index ?? 0
      return registry === null || at < registry.from || at > registry.to
    })
    .map((match) => match[0])
}

function registrySpan(code: string): { from: number; to: number } | null {
  const marker = 'startBackgroundWork('
  const from = code.indexOf(marker)
  if (from === -1) return null
  let depth = 0
  for (let i = from + marker.length - 1; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') {
      depth--
      if (depth === 0) return { from, to: i }
    }
  }
  return { from, to: code.length }
}

describe('background work is declared before it is armed', () => {
  /**
   * The positive control. Without it this is an assertion that passes because
   * the checker finds nothing anywhere — the shape this repository has been
   * bitten by more than once, where a guard reads as coverage and reaches its
   * subject in no case at all.
   */
  it('reports a worker armed outside the registry', () => {
    const bypassed = bypassedStartCalls(
      [
        'const handle = startBackgroundWork([',
        '  { name: "a", worker: { start: () => declared.start(), stop: async () => {} } },',
        '])',
        'undeclared.start()',
      ].join('\n'),
    )
    expect(bypassed).toEqual(['undeclared.start()'])
  })

  it('does not report a worker armed through the registry', () => {
    const bypassed = bypassedStartCalls(
      ['startBackgroundWork([', '  { worker: { start: () => sweeper.start() } },', '])'].join('\n'),
    )
    expect(bypassed).toEqual([])
  })

  /** Prose about `.start()` is not code, and must not read as a bypass. */
  it('ignores a mention in a comment', () => {
    expect(bypassedStartCalls('// call thing.start() here\n')).toEqual([])
  })

  it.each(COMPOSITION_ROOTS)('%s arms nothing outside the registry', async (file) => {
    const source = await readFile(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')
    expect(bypassedStartCalls(source)).toEqual([])
  })

  /**
   * And the composition roots really do arm workers, so the empty result
   * above is the checker looking and finding nothing rather than the checker
   * looking at a file with nothing in it.
   */
  it('is reading files that actually arm workers', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./http-server.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toMatch(/startBackgroundWork\(\[/)
    expect([...source.matchAll(/\.start\(\)/g)].length).toBeGreaterThan(0)
  })
})
