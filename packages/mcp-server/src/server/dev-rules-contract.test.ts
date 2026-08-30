import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// apps/web's jsdom vitest project used to run unnamed, so `--project
// web-jsdom` matched nothing while a sibling `--project web-browser` in the
// same command still matched — silently running only the browser project and
// exiting 0. .claude/rules/dev-flow.md is ALWAYS-ON context read by every
// session in this repo, so its false claim that no such project exists was
// what made the workaround permanent. This guard runs in mcp-node (part of
// the lefthook pre-push gate), independent of the web-jsdom project it
// describes, so a rebase that reinstates the false claim fails before it can
// be pushed.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const RULE_AND_SKILL_FILES = [
  '.claude/rules/dev-flow.md',
  '.claude/rules/architecture-map.md',
  '.claude/rules/integrator-flow.md',
  '.claude/rules/vocabulary.md',
  '.claude/skills/test-layer-selection/SKILL.md',
]

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

describe('dev-flow.md agrees with reality about the web-jsdom project', () => {
  it('mentions web-jsdom and pnpm test:web-jsdom whenever the config declares the project named that', () => {
    const devFlow = read('.claude/rules/dev-flow.md')
    if (read('apps/web/vitest.config.ts').includes("name: 'web-jsdom'")) {
      expect(devFlow).toContain('web-jsdom')
      expect(devFlow).toContain('pnpm test:web-jsdom')
    }
  })

  it('keeps the silent-unmatched-filter hazard: the paired-filter example, the CI command, the "twice in one session" consequence, and the web-node non-equivalence', () => {
    const devFlow = read('.claude/rules/dev-flow.md')
    expect(devFlow, 'lost the --project web-jsdom --project web-browser example').toContain(
      '--project web-jsdom --project web-browser',
    )
    expect(devFlow, 'lost the "reached CI twice in one session" consequence').toContain(
      'reach CI twice in one session',
    )
    expect(devFlow, 'lost the CI command to match locally').toContain(
      'pnpm --filter @kamiazya/whiteboard-web test',
    )
    expect(
      devFlow,
      'lost the web-node non-equivalence marker (--project web-jsdom alone omits web-node)',
    ).toContain('web-node')
  })

  it('no rule or skill file reintroduces the retired claim', () => {
    const offenders = RULE_AND_SKILL_FILES.filter((path) => {
      const content = read(path)
      return (
        content.includes('There is no `web-jsdom` project at the root') ||
        /is NOT a root vitest project/.test(content)
      )
    })
    expect(offenders).toEqual([])
  })
})

describe('test-layer-selection SKILL.md agrees with reality about the web-jsdom project', () => {
  it('names the project web-jsdom and lists both the narrow and CI-matching commands, in agreement with its frontmatter description', () => {
    const skill = read('.claude/skills/test-layer-selection/SKILL.md')
    const frontmatterEnd = skill.indexOf('\n---', 4)
    const frontmatter = skill.slice(0, frontmatterEnd)
    const body = skill.slice(frontmatterEnd)

    expect(body).toContain('web-jsdom')
    expect(body).toContain('pnpm test:web-jsdom')
    expect(body).toContain('pnpm --filter @kamiazya/whiteboard-web test')

    expect(frontmatter).toContain('web-jsdom')
    expect(frontmatter).not.toContain('apps/web jsdom')
  })
})

// The `## Skills` line in dev-flow.md is an always-on INDEX of what is
// loadable on demand, and nothing checked it against the directory. A skill
// added next month is simply absent from every session's index, the index
// still reads complete, and the skill is found only by whoever remembers it.
// Same list-goes-stale-in-silence shape as `mutation-lane-coverage.test.ts`,
// and it was already stale when this guard was written.
const SKILLS_DIR = '.claude/skills'

/**
 * Skill directories deliberately NOT in the always-on index, with the reason.
 * Guarded from both sides below, so an entry cannot outlive what it names.
 */
const NOT_INDEXED: Record<string, string> = {
  'whiteboard-smoke':
    'Superseded by whiteboard-mcp-smoke. Its own description still says "Excalidraw MCP" — a vocabulary this repo retired — and nothing in .claude/ reaches it. Left on disk pending a decision to delete it; indexing it would advertise it as current.',
}

function indexedSkills(): string[] {
  const devFlow = read('.claude/rules/dev-flow.md')
  const section = devFlow.split('## Skills (load for detail)')[1] ?? ''
  // The first paragraph after the heading is the list itself.
  const list = section.split('\n\n')[1] ?? ''
  return [...list.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]!)
}

function skillDirectories(): string[] {
  return readdirSync(join(REPO_ROOT, SKILLS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

describe("dev-flow.md's skills index agrees with the skills on disk", () => {
  it('indexes every skill directory except the ones recorded as deliberate', () => {
    const missing = skillDirectories().filter(
      (name) => !indexedSkills().includes(name) && !(name in NOT_INDEXED),
    )
    expect(missing).toEqual([])
  })

  it('indexes nothing that is no longer on disk', () => {
    const onDisk = skillDirectories()
    expect(indexedSkills().filter((name) => !onDisk.includes(name))).toEqual([])
  })

  it('records no exemption that is indexed anyway or no longer exists', () => {
    const onDisk = skillDirectories()
    const stale = Object.keys(NOT_INDEXED).filter(
      (name) => !onDisk.includes(name) || indexedSkills().includes(name),
    )
    expect(stale).toEqual([])
  })
})

describe('steward stays at the path the harness reads', () => {
  it('exists at .claude/skills/steward/SKILL.md while dev-flow.md says the harness reads it there', () => {
    // Unlike every other skill, this one is fetched by EXACT PATH on a PR
    // event rather than by name. Renaming the directory keeps it invocable as
    // a skill and silently stops the harness ever reading it, with nothing
    // failing and no symptom to notice.
    if (read('.claude/rules/dev-flow.md').includes('.claude/skills/steward/SKILL.md')) {
      expect(existsSync(join(REPO_ROOT, SKILLS_DIR, 'steward/SKILL.md'))).toBe(true)
    }
  })
})
