import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from './scan-roots.js'

/**
 * The command that runs a root dev tool's own bin entry under this Node, as
 * `[executable, ...args]`.
 *
 * Not `pnpm exec <tool>`: pnpm verifies the installed tree before an exec and
 * by default answers a stale one by installing into it, printing progress on
 * stdout ahead of the tool's own output (`no-pnpm-spawn.test.ts` has the
 * measured failure). Resolved from the root manifest, which is where both
 * tools are declared, and through the package's `bin` field rather than a
 * hard-coded file name.
 */
export function toolCommand(pkg: '@biomejs/biome' | 'vitest', bin: string): string[] {
  const manifestPath = createRequire(join(REPO_ROOT, 'package.json')).resolve(`${pkg}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin]
  if (entry === undefined) throw new Error(`${pkg} declares no \`${bin}\` bin`)
  return [process.execPath, join(dirname(manifestPath), entry)]
}
