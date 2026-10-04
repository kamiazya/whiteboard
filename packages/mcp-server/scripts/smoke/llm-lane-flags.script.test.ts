// The scripts that spend model API quota (the claude/codex CLI smokes and the tool-surface eval)
// must treat a question or a typo as a refusal, never as the real run: `--help` prints usage and
// spends nothing, an unknown option exits 2.
//
// Spend is ruled out by running with NO `claude` / `codex` on PATH and asserting the USAGE text. A
// script that fell through to its real run would print its "SKIP: CLI not found" line instead.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPTS = [
  { file: 'smoke/mcp-claude-cli-smoke.mjs', usage: /usage: mcp-claude-cli-smoke/ },
  { file: 'smoke/mcp-codex-cli-smoke.mjs', usage: /usage: mcp-codex-cli-smoke/ },
  { file: 'eval/mcp-tool-surface-eval.mjs', usage: /usage: mcp-tool-surface-eval/ },
] as const

function run(file: string, args: string[]) {
  return spawnSync(process.execPath, [resolve(import.meta.dirname, '..', file), ...args], {
    // Empty PATH: neither CLI can be found, so any real run would print its SKIP line.
    env: { ...process.env, PATH: '' },
    encoding: 'utf8',
    timeout: 60_000,
  })
}

describe('quota-spending scripts refuse what they do not recognise', () => {
  for (const { file, usage } of SCRIPTS) {
    it(`${file} --help prints usage, exits 0 and does not reach the real run`, () => {
      const result = run(file, ['--help'])
      const output = `${result.stdout}${result.stderr}`

      expect(result.status, output).toBe(0)
      expect(output).toMatch(usage)
      expect(output).not.toMatch(/SKIP/)
    })

    it(`${file} --bogus exits 2 with usage`, () => {
      const result = run(file, ['--bogus'])
      const output = `${result.stdout}${result.stderr}`

      expect(result.status, output).toBe(2)
      expect(output).toMatch(usage)
      expect(output).not.toMatch(/SKIP/)
    })
  }

  it('the eval treats --dryrun, a typo of --dry-run, as a refusal rather than the real lane', () => {
    const result = run('eval/mcp-tool-surface-eval.mjs', ['--dryrun'])

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(2)
  })
})
