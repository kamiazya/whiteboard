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

function readDevFlow(): string {
  return readFileSync(join(REPO_ROOT, '.claude/rules/dev-flow.md'), 'utf8')
}

function readTestLayerSkill(): string {
  return readFileSync(join(REPO_ROOT, '.claude/skills/test-layer-selection/SKILL.md'), 'utf8')
}

function readAppsWebVitestConfig(): string {
  return readFileSync(join(REPO_ROOT, 'apps/web/vitest.config.ts'), 'utf8')
}

describe('dev-flow.md agrees with reality about the web-jsdom project', () => {
  it('no longer claims there is no root web-jsdom project', () => {
    const devFlow = readDevFlow()
    expect(devFlow).not.toContain('There is no `web-jsdom` project at the root')
  })

  it('mentions web-jsdom and pnpm test:web-jsdom whenever the config declares the project named that', () => {
    const devFlow = readDevFlow()
    const config = readAppsWebVitestConfig()
    if (config.includes("name: 'web-jsdom'")) {
      expect(devFlow).toContain('web-jsdom')
      expect(devFlow).toContain('pnpm test:web-jsdom')
    }
  })

  it('keeps the silent-unmatched-filter hazard: the paired-filter example, the CI command, the "twice in one session" consequence, and the web-node non-equivalence', () => {
    const devFlow = readDevFlow()
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

  it('no other rule or skill file reintroduces the retired claim', () => {
    const offenders: string[] = []
    for (const path of [
      join(REPO_ROOT, '.claude/rules/dev-flow.md'),
      join(REPO_ROOT, '.claude/rules/architecture-map.md'),
      join(REPO_ROOT, '.claude/rules/integrator-flow.md'),
      join(REPO_ROOT, '.claude/rules/vocabulary.md'),
      join(REPO_ROOT, '.claude/skills/test-layer-selection/SKILL.md'),
    ]) {
      const content = readFileSync(path, 'utf8')
      if (
        content.includes('There is no `web-jsdom` project at the root') ||
        /is NOT a root vitest project/.test(content)
      ) {
        offenders.push(path)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('test-layer-selection SKILL.md agrees with reality about the web-jsdom project', () => {
  it('names the project web-jsdom and lists both the narrow and CI-matching commands, in agreement with its frontmatter description', () => {
    const skill = readTestLayerSkill()
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
