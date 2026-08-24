import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * ADR-0018's invariant, made mechanical: an ADAPTER may not reach a
 * MECHANIC directly.
 *
 * An adapter is an HTTP route or an MCP tool registration — it translates a
 * transport into an operation and back. A mechanic is how this composition
 * root stores, caches, locks, schedules or sweeps. When an adapter imports
 * one, the operation it is performing has nowhere to live except inside the
 * adapter, and the next surface that needs the same operation has to write
 * it again. Every divergence ADR-0018 records began that way.
 *
 * The composition root's own wiring (`di/`, `app.ts`, `http-server.ts`) is
 * NOT an adapter and is deliberately out of scope: knowing the mechanics is
 * exactly its job.
 */
const ADAPTER_DIRS = ['routes', 'mcp'] as const

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

/**
 * Every `<adapter file> -> <mechanic module>` edge that exists today, as the
 * strings the allowlist is written in.
 *
 * `serverDir` is `packages/mcp-server/src/server`.
 */
export function findAdapterMechanicEdges(
  serverDir: string,
  excludedMechanics: readonly string[],
): string[] {
  const excluded = new Set(excludedMechanics)
  const edges = new Set<string>()
  for (const base of ADAPTER_DIRS) {
    const dir = join(serverDir, base)
    for (const file of walk(dir)) {
      const from = relative(serverDir, file).split('\\').join('/')
      for (const match of readFileSync(file, 'utf8').matchAll(
        /from '[^']*store\/([a-z0-9-]+)\.js'/g,
      )) {
        const mechanic = match[1] as string
        if (excluded.has(mechanic)) continue
        edges.add(`${from} -> ${mechanic}`)
      }
    }
  }
  return [...edges].sort()
}
