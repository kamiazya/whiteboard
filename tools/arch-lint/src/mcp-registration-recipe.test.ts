import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// `claude mcp add --scope local` keys its entry by the project the CLI
// resolves, and every linked worktree resolves to the MAIN checkout. A recipe
// that derives the proxy path from `--show-toplevel` therefore writes a
// worktree's script into the main checkout's one slot when it is run from a
// worktree — and that slot dangles, for every session in the repository, once
// the worktree is removed. `--git-common-dir` names the main checkout from
// anywhere, so it is the only anchor a copied recipe can use safely.

/** A recipe's whole command, with shell line continuations joined. */
function commandsIn(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => line.includes('claude mcp add') && line.includes('mcp-http-stdio-proxy.mjs'))
}

/**
 * Whether a recipe builds the proxy path from the shell — a command
 * substitution, a backtick `git rev-parse`, `$PWD` or `pwd` — and so names
 * whatever checkout it is run from. A recipe naming the path through a
 * `<placeholder>` is prose the reader fills in, not a copy-paste anchor.
 */
function derivesPathFromShell(command: string): boolean {
  return /\$|git rev-parse|\bpwd\b/.test(command)
}

/** A shell-derived recipe that is not anchored on the main checkout. */
function misanchored(command: string): boolean {
  return (
    derivesPathFromShell(command) &&
    (command.includes('--show-toplevel') || !command.includes('--git-common-dir'))
  )
}

const recipes = trackedFiles(REPO_ROOT, '*.md')
  .filter((path) => !path.startsWith('docs/contributing/adr/'))
  .flatMap((path) =>
    commandsIn(readFileSync(join(REPO_ROOT, path), 'utf8')).map((command) => ({ path, command })),
  )
const derived = recipes.filter(({ command }) => derivesPathFromShell(command))

const PROXY = 'packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs'
const ADD = 'claude mcp add --scope local --transport stdio whiteboard -- node'

describe('the whiteboard stdio-proxy registration recipe', () => {
  it('finds the recipes it holds, so an empty scan cannot pass', () => {
    const files = new Set(derived.map(({ path }) => path))
    expect(files).toContain('CONTRIBUTING.md')
    expect(files).toContain('docs/contributing/development.md')
  })

  it('anchors every shell-derived proxy path on the main checkout, never this checkout', () => {
    const offenders = derived.filter(({ command }) => misanchored(command))
    expect(
      offenders,
      'derive the proxy path with `$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")`',
    ).toEqual([])
  })

  it.each([
    ['a command-substituted pwd', `${ADD} "$(pwd)/${PROXY}"`],
    ['the PWD variable', `${ADD} "$PWD/${PROXY}"`],
    ['the braced PWD variable', `${ADD} "\${PWD}/${PROXY}"`],
    ['a backtick show-toplevel', `${ADD} "\`git rev-parse --show-toplevel\`/${PROXY}"`],
    ['a substituted show-toplevel', `${ADD} "$(git rev-parse --show-toplevel)/${PROXY}"`],
  ])('refuses a recipe anchored on %s', (_shape, command) => {
    expect(commandsIn(command)).toHaveLength(1)
    expect(misanchored(command)).toBe(true)
  })

  it('accepts the main-checkout anchor and a placeholder the reader fills in', () => {
    const anchored = `${ADD} "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/${PROXY}"`
    expect(misanchored(anchored)).toBe(false)
    expect(misanchored(`${ADD} <worktree>/${PROXY}`)).toBe(false)
  })
})
