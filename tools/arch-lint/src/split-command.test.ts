// The tier runners build spawnSync argv through splitCommand, with no shell,
// so a matrix command carrying shell metacharacters or an env assignment must
// be refused rather than executed. publish-gate-runner.test.ts holds the
// runner's refusal; this holds the parser's own contract.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const { splitCommand } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/split-command.mjs')).href
)) as { splitCommand: (command: string) => string[] }

const matrix = JSON.parse(
  readFileSync(join(REPO_ROOT, 'tests/e2e/distribution/release-gate-matrix.json'), 'utf-8'),
) as { gates: { id: string; command: string; requiredFor: string[] }[] }

// The tiers a matrix-driven runner executes; the others run as scripts.
const RUNNER_TIERS = ['publish', 'pages-release']

describe('splitCommand', () => {
  it('splits plain commands and collapses surrounding and repeated whitespace', () => {
    expect(splitCommand('pnpm build')).toEqual(['pnpm', 'build'])
    expect(splitCommand('  pnpm   --filter  @kamiazya/whiteboard-web   smoke:artifact ')).toEqual([
      'pnpm',
      '--filter',
      '@kamiazya/whiteboard-web',
      'smoke:artifact',
    ])
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['a command chain', 'pnpm build && rm -rf /'],
    ['a substitution', 'echo $HOME'],
    ['a quote', 'cat "a b"'],
    ['a pipe', 'pnpm build | tee log'],
    ['an env assignment', 'FOO=bar pnpm build'],
  ])('refuses %s', (_shape, command) => {
    expect(() => splitCommand(command)).toThrow()
  })

  it('accepts every gate command a matrix-driven runner executes', () => {
    const runnerGates = matrix.gates.filter((gate) =>
      gate.requiredFor.some((tier) => RUNNER_TIERS.includes(tier)),
    )
    expect(runnerGates.length).toBeGreaterThan(5)
    for (const gate of runnerGates) {
      expect(() => splitCommand(gate.command), `gate "${gate.id}" must be shell-safe`).not.toThrow()
    }
  })
})
