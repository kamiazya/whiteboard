import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * pnpm's own subcommands and the dependency bins it runs by name (`lefthook`),
 * which read exactly like a script name after `pnpm` and resolve without one. An allowlist of what the repo's docs actually reach
 * for: a built-in that arrives later surfaces as a dangling name and is added
 * deliberately, the safer direction — the opposite mistake is a guard that
 * quietly stops checking.
 */
const PNPM_BUILTINS: ReadonlySet<string> = new Set([
  'add',
  'audit',
  'deploy',
  'dlx',
  'exec',
  'install',
  'lefthook',
  'pack',
  'remove',
  'run',
  'update',
])

/**
 * Every `pnpm <name>` in `text`, with the 1-based line it sits on.
 *
 * Only the bare form: `pnpm --filter <pkg> <name>` and `pnpm -C <dir> <name>`
 * start with a flag, so they never match, and they are exactly the forms that
 * name a script outside the root.
 */
export function bareScriptReferences(text: string): Array<{ name: string; line: number }> {
  return text.split('\n').flatMap((lineText, index) =>
    [...lineText.matchAll(/\bpnpm\s+([a-z][\w:-]*)/g)]
      .map((m) => m[1] ?? '')
      .filter((name) => !PNPM_BUILTINS.has(name))
      .map((name) => ({ name, line: index + 1 })),
  )
}

export function scriptsOf(root: string, manifestDir = ''): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(root, manifestDir, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  return manifest.scripts ?? {}
}
