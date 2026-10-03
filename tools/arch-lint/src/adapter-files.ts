import { join } from 'node:path'
import { walk } from './scan-roots.js'
import { isTestPath } from './source-scan.js'

/**
 * Which files are ADR-0018's adapters, answered once.
 *
 * Four scans each carried their own copy of this population (the mechanic
 * check, the process-global check, the route-portability ledger and the di
 * check), and the copies had already diverged: one skipped only
 * `_test-helpers.ts` where the rest skipped every `_test-*` file. A scan that
 * disagrees with its siblings about what an adapter IS reports a population the
 * others do not see, and a new directory added to one is a blind spot in three.
 *
 * `server/routes/**` are the HTTP routes and `server/mcp/**` the MCP tool
 * registrations. A test, or a `_test-*` scaffold a test builds an app from, is
 * not something a request reaches, so what it imports says nothing about an
 * adapter.
 */
const ADAPTER_DIRS = ['routes', 'mcp'] as const

export function isAdapterSource(file: string): boolean {
  return file.endsWith('.ts') && !isTestPath(file)
}

/**
 * Every adapter source file under `serverDir` (`packages/mcp-server/src/server`),
 * absolute, in directory order.
 */
export function adapterFiles(serverDir: string): string[] {
  return ADAPTER_DIRS.flatMap((base) => walk(join(serverDir, base), { include: isAdapterSource }))
}
