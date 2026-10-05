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

const recipes = trackedFiles(REPO_ROOT, '*.md')
  .filter((path) => !path.startsWith('docs/contributing/adr/'))
  .flatMap((path) =>
    commandsIn(readFileSync(join(REPO_ROOT, path), 'utf8')).map((command) => ({ path, command })),
  )
const derived = recipes.filter(({ command }) => command.includes('$(git rev-parse'))

describe('the whiteboard stdio-proxy registration recipe', () => {
  it('finds the recipes it holds, so an empty scan cannot pass', () => {
    const files = new Set(derived.map(({ path }) => path))
    expect(files).toContain('CONTRIBUTING.md')
    expect(files).toContain('docs/contributing/development.md')
  })

  it('anchors every git-derived proxy path on the main checkout, never this checkout', () => {
    const offenders = derived.filter(
      ({ command }) => command.includes('--show-toplevel') || !command.includes('--git-common-dir'),
    )
    expect(
      offenders,
      'derive the proxy path with `$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")`',
    ).toEqual([])
  })
})
