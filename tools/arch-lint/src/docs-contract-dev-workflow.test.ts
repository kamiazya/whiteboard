import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeText } from './markdown-code.js'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// The dev workflow's own instructions (skills, hook remedies, workflow briefs,
// contributor docs) are read by a session at the moment it acts on them, and a
// command that does not work there costs more than a wrong comment: the reader
// follows it, it fails or does nothing, and the failure looks like the repo's.
// Each check below pins one instruction that was found not to work.

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf-8')

// `gh pr view|checks|list|status` and `gh repo view` are GraphQL-backed, and a
// Claude Code web session answers every one with HTTP 403 — a normal
// contributor path, not an edge. The watch loop that treated that failure as
// an empty answer reported a clean PR. So the files that tell an agent how to
// WATCH or TRIAGE a PR read GitHub over REST (`gh api`), and may name the
// GraphQL forms only to forbid them.
const REST_ONLY_FILES = [
  '.claude/skills/ci-triage/SKILL.md',
  '.claude/workflows/ci-triage.workflow.mjs',
  '.claude/workflows/pr-feedback.workflow.mjs',
  '.claude/workflows/dependabot-triage.workflow.mjs',
]
const GRAPHQL_GH = /\bgh\s+(?:pr\s+(?:view|checks|list|status)|repo\s+view)\b/
const FORBIDS_IT = /GraphQL|\b403\b|\bnever\b|\bREST\b/

describe('PR watch and triage instructions read GitHub over REST', () => {
  it.each(REST_ONLY_FILES)('%s names no GraphQL-backed gh call as something to run', (file) => {
    const lines = read(file).split('\n')
    expect(lines.length, `${file} read as empty`).toBeGreaterThan(10)
    const offending = lines
      .map((text, index) => ({ text, line: index + 1 }))
      .filter(({ text }) => GRAPHQL_GH.test(text) && !FORBIDS_IT.test(text))
    expect(
      offending,
      `${file} tells an agent to run a GraphQL-backed gh command; use \`gh api repos/{owner}/{repo}/…\``,
    ).toEqual([])
  })

  it('the ci-triage watch loops never turn a failed read into an empty one', () => {
    const loops = [
      ...read('.claude/skills/ci-triage/SKILL.md').matchAll(/```bash\n(PR=<PR>[\s\S]*?)```/g),
    ]
    expect(loops.length, 'the two watch loops were not found').toBe(2)
    for (const [, loop] of loops) expect(loop).not.toMatch(/\|\|\s*echo\s+'\[\]'/)
  })
})

// Every checkout and worktree runs `pnpm mcp:http:dev` under the same process
// name, so a stop command that matches the name stops every lane's daemon at
// once, not this one. A checkout is identified by its data dir, and the stop
// command that reads it is `pnpm mcp:http:stop`.
describe('docs never tell a reader to stop a daemon by process name', () => {
  const docs = trackedFiles(REPO_ROOT, '*.md')

  it('reads a plausible set of documents', () => {
    expect(docs.length).toBeGreaterThan(50)
    expect(docs).toContain('docs/contributing/development.md')
  })

  it('names no `pkill -f` anywhere', () => {
    const offenders = docs.filter((file) => /\bpkill\s+-f\b/.test(read(file)))
    expect(offenders, 'stop a dev daemon with `pnpm mcp:http:stop`').toEqual([])
  })

  it('names the per-checkout stop command where the daemon is documented', () => {
    expect(read('docs/contributing/development.md')).toContain('pnpm mcp:http:stop')
  })
})

// `gh <name>` where <name> is not one of gh's own commands is an EXTENSION, and
// an extension is absent on a fresh machine: the reader gets
// `unknown command "image" for "gh"`. A skill that tells its reader to run one
// carries the install line itself, since nothing else in the repo does.
const GH_CORE_COMMANDS = new Set([
  'agent-task',
  'alias',
  'api',
  'attestation',
  'auth',
  'browse',
  'cache',
  'codespace',
  'completion',
  'config',
  'copilot',
  'extension',
  'gist',
  'gpg-key',
  'help',
  'issue',
  'label',
  'licenses',
  'org',
  'pr',
  'preview',
  'project',
  'release',
  'repo',
  'ruleset',
  'run',
  'search',
  'secret',
  'ssh-key',
  'status',
  'variable',
  'version',
  'workflow',
])

describe('a gh extension a skill tells its reader to run is installed by the same skill', () => {
  const skills = trackedFiles(REPO_ROOT, '.claude/skills/**/*.md')

  /** A skill is its directory: the install line may sit in SKILL.md while a sibling file runs the command. */
  const skillText = (file: string): string => {
    const dir = file.split('/').slice(0, 3).join('/')
    return skills
      .filter((other) => other.startsWith(`${dir}/`))
      .map(read)
      .join('\n')
  }

  const extensionsNamed = (file: string): string[] => [
    ...new Set(
      [...codeText(read(file)).matchAll(/(?:^|[\s`$(])gh ([a-z][a-z-]*)\b/gm)]
        .map((m) => m[1] as string)
        .filter((name) => !GH_CORE_COMMANDS.has(name)),
    ),
  ]

  it('reads the skills, and finds the two extensions this repo uses', () => {
    expect(skills.length).toBeGreaterThan(20)
    const found = new Set(skills.flatMap(extensionsNamed))
    expect(found.has('stack')).toBe(true)
    expect(found.has('image')).toBe(true)
  })

  it('has an install line beside every extension command', () => {
    const missing = skills.flatMap((file) =>
      extensionsNamed(file)
        .filter(
          (name) => !new RegExp(`gh extension install \\S*gh-${name}\\b`).test(skillText(file)),
        )
        .map(
          (name) =>
            `${file}: \`gh ${name}\` has no \`gh extension install <owner>/gh-${name}\` line`,
        ),
    )
    expect(missing).toEqual([])
  })
})
