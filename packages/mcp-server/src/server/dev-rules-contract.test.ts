import { readFileSync } from 'node:fs'
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
