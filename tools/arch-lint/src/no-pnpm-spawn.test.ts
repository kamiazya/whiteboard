/**
 * No file in this package starts `pnpm` as a child process.
 *
 * pnpm checks the installed tree against the lockfile before every `run` and
 * `exec`, and by default answers a stale tree by running `pnpm install` into
 * it, synchronously and unlocked, with its progress lines on STDOUT. A test
 * that spawned `pnpm exec biome … --reporter=json` and parsed stdout therefore
 * failed once after a lockfile-changing merge (`Unexpected token 'S', "Scope:
 * all"…`) and passed on the retry, because the failing run had installed — the
 * exact signature of a flake, with nothing in the message naming the cause. In
 * a checkout whose node_modules links to another tree, the same check installs
 * into THAT tree. A test reaches a tool through its own entry instead
 * (`tool-bin.ts`), which pnpm has no part in.
 *
 * A source scan, so a `pnpm` string handed to a spawn through a variable is
 * not seen; the literal first argument is the shape every instance had.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = import.meta.dirname

const SPAWNS_PNPM =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa)\(\s*['"`]pnpm(?:\.cmd)?(?=['"`\s])/

/** The call sites in `text` that start pnpm, by line. */
export function pnpmSpawns(text: string): number[] {
  const found: number[] = []
  const pattern = new RegExp(SPAWNS_PNPM.source, 'g')
  for (const match of text.matchAll(pattern)) {
    found.push(text.slice(0, match.index).split('\n').length)
  }
  return found
}

const sources = readdirSync(SRC).filter((name) => name.endsWith('.ts'))

describe('arch-lint starts no pnpm process', () => {
  it('reads this package at all', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('recognises the shapes a pnpm spawn is written in', () => {
    expect(pnpmSpawns(`execFileSync(\n  'pnpm',\n  ['exec', 'biome'],\n)`)).toEqual([1])
    expect(pnpmSpawns(`spawnSync('pnpm', ['exec', 'vitest'])`)).toEqual([1])
    expect(pnpmSpawns('x\nexecSync(`pnpm exec biome lint`)')).toEqual([2])
    expect(pnpmSpawns(`spawn("pnpm.cmd", [])`)).toEqual([1])
    // Documentation of a command, and a binary merely named like it, are not spawns.
    expect(pnpmSpawns(`expect(doc).toContain('pnpm exec vitest list')`)).toEqual([])
    expect(pnpmSpawns(`spawnSync('pnpmish', [])`)).toEqual([])
  })

  it('has no file that spawns pnpm', () => {
    const offenders = sources
      .filter((name) => name !== 'no-pnpm-spawn.test.ts')
      .flatMap((name) =>
        pnpmSpawns(readFileSync(join(SRC, name), 'utf8')).map((line) => `${name}:${line}`),
      )
    expect(offenders, 'reach the tool through tool-bin.ts, not `pnpm exec`').toEqual([])
  })
})
