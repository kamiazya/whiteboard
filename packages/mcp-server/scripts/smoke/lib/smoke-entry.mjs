import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/**
 * The server entry a smoke drives: `--entry=<path>` relative to the package
 * root, or the source stdio entry. A dist entry is absent on any unbuilt
 * checkout, so that case exits naming the build CI runs instead of letting the
 * child die on a module-resolution trace that names no remedy.
 *
 * @param {string} root the mcp-server package root
 * @param {string[]} argv the smoke's argv
 */
export function resolveSmokeEntry(root, argv) {
  const entryArg = argv.find((arg) => arg.startsWith('--entry='))
  const entry = resolve(
    root,
    entryArg ? entryArg.slice('--entry='.length) : 'src/server/mcp/stdio.ts',
  )
  if (!relative(resolve(root, 'dist'), entry).startsWith('..') && !existsSync(entry)) {
    process.stderr.write(
      `[e2e] FAIL: ${relative(root, entry)} missing.\nRun \`pnpm build\` before this smoke.\n`,
    )
    process.exit(1)
  }
  return entry
}
