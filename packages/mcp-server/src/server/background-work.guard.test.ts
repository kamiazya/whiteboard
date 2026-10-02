import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOOP_COSTS } from './background-work-costs.js'

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
// The shared set (`shared-background-work.ts`) is scanned too. It holds no
// registry call, so a direct `.start()` there is a bypass — it builds and
// declares the workers, and the roots arm them. What it may hold is a worker
// WRAPPED as `start: () => x.start()`, which arms nothing until the registry
// calls it.
const COMPOSITION_ROOTS = [
  'http-server.ts',
  'server-mode-http.ts',
  'shared-background-work.ts',
  'stdio-root.ts',
] as const

/**
 * Every `.start()` in `source` that is NOT inside the registry call.
 *
 * Arming through `startBackgroundWork` is the point, so its own argument —
 * where a worker is wrapped as `start: () => sweeper.start()` — is excluded
 * by span rather than by name. The same wrapper built ELSEWHERE (the shared
 * set hands one to each root) is excluded by its shape: an arrow stored as
 * `start` runs only when something calls it, and the only caller is the
 * registry.
 */
function bypassedStartCalls(source: string): string[] {
  // Comments first: the composition roots discuss `.start()` in prose, and so
  // does this file.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const registry = registrySpan(code)
  return [...code.matchAll(/(\w[\w.?]*)\.start\(\)/g)]
    .filter((match) => {
      const at = match.index ?? 0
      if (/\bstart:\s*\(\)\s*=>\s*$/.test(code.slice(0, at))) return false
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

  it('does not report a worker wrapped for a registry that arms it elsewhere', () => {
    expect(bypassedStartCalls('const w = { start: () => sweeper.start(), stop })')).toEqual([])
  })

  it('still reports a call that merely sits beside a wrapper', () => {
    expect(
      bypassedStartCalls(
        'const w = { start: () => a.start(), stop }\nb.start()\nconst start = c.start()',
      ),
    ).toEqual(['b.start()', 'c.start()'])
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

const SERVER_SRC = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_SRC = fileURLToPath(new URL('../', import.meta.url))

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * The other bypass, and the one `.start()` cannot see: a module that owns a
 * timer arms itself the moment something calls into it, so it is a background
 * worker whether or not a composition root ever starts it. `auto-compact`
 * was exactly that — a per-workspace debounce running a whole-record export
 * under the in-process lock — and declared nothing, because nothing about its
 * arming looked like a worker's.
 *
 * Every module under `store/` that owns a timer is therefore classified here:
 * either it IS a declared worker, named by its `LOOP_COSTS` key, or it runs
 * inside one and says which. A new timer-owning module fails until someone
 * answers which.
 */
const TIMER_OWNERS: Record<string, { worker: keyof typeof LOOP_COSTS } | { within: string }> = {
  'auto-compact.ts': { worker: 'auto-compact' },
  'backup-scheduler.ts': { worker: 'backup-scheduler' },
  'file-gc-sweeper.ts': { worker: 'file-gc-sweeper' },
  'workspace-tail.ts': { worker: 'workspace-tail' },
  // Keeps a marker file warm for exactly as long as a backup pass runs.
  'backup-in-progress.ts': { within: 'backup-scheduler' },
  // Renews a lease for exactly as long as the leased work (the backup pass) runs.
  'lease.ts': { within: 'backup-scheduler' },
}

describe('a timer-owning store module is a declared worker', () => {
  async function timerOwners(): Promise<string[]> {
    const storeDir = join(SERVER_SRC, 'store')
    const owners: string[] = []
    for (const file of await sourceFiles(storeDir)) {
      const code = withoutComments(await readFile(file, 'utf8'))
      if (/\b(setTimeout|setInterval)\(/.test(code)) owners.push(relative(storeDir, file))
    }
    return owners.sort()
  }

  it('classifies every module under store/ that owns a timer, and none that does not', async () => {
    const owners = await timerOwners()
    // The scan reached something: a pattern that stopped matching would
    // otherwise report an empty store as correctly classified.
    expect(owners.length).toBeGreaterThan(3)
    expect(owners).toEqual(Object.keys(TIMER_OWNERS).sort())
  })

  it('names, for each, a worker that is declared with its cost', () => {
    for (const [file, owner] of Object.entries(TIMER_OWNERS)) {
      const worker = 'worker' in owner ? owner.worker : owner.within
      expect(Object.keys(LOOP_COSTS), `${file} names ${worker}, which declares no cost`).toContain(
        worker,
      )
    }
  })
})

/**
 * Who may reach the auto-compact scheduler. Subscribing to saves is the
 * shared set's (`shared-background-work.ts`, which declares it); scheduling a
 * fold for an agent write is the `documentWritten` seam's, which has no
 * registry call in its chain and works under stdio. Anywhere else —
 * a router constructor was the old one — arms a debounce no declaration
 * answers for.
 */
const AUTO_COMPACT_IMPORTERS = [
  'server/shared-background-work.ts',
  'server/store/document-written.ts',
]

describe('the auto-compact scheduler is reached only where it is declared', () => {
  it('has exactly the importers it declares', async () => {
    const importers: string[] = []
    for (const file of await sourceFiles(PACKAGE_SRC)) {
      const code = withoutComments(await readFile(file, 'utf8'))
      if (/\/auto-compact(\.js)?['"]/.test(code) && !file.endsWith('store/auto-compact.ts')) {
        importers.push(relative(PACKAGE_SRC, file))
      }
    }
    expect(importers.sort()).toEqual([...AUTO_COMPACT_IMPORTERS].sort())
  })
})
