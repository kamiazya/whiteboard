import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

// The documents a maintainer follows at the moment they act — the security
// policy, the release runbook, the deploy notes and the contributor guide —
// describe machinery that lives in workflows, a wrangler config and a
// package manifest. Each check below reads the machine side and requires the
// prose to agree with it, so a job, environment or project name that changes
// in one place fails here instead of misleading the next release.

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf-8')

const RELEASE_YML = read('.github/workflows/release.yml')

/** Job ids of a workflow: two-space-indented keys under the top-level `jobs:`. */
function jobIds(workflow: string): string[] {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length)
  return [...jobs.matchAll(/^ {2}([a-z][\w-]*):\s*$/gm)].map((m) => m[1] as string)
}

/** Environment names a workflow binds, in either the scalar or the `name:` form. */
function environments(workflow: string): string[] {
  const names = [
    ...workflow.matchAll(/^ {4}environment:\s*([\w-]+)\s*$/gm),
    ...workflow.matchAll(/^ {4}environment:\s*\n(?: {6}[^\n]*\n)*? {6}name:\s*([\w-]+)\s*$/gm),
  ].map((m) => m[1] as string)
  return [...new Set(names)]
}

describe('the release runbook names every job and environment release.yml defines', () => {
  const releasing = read('docs/contributing/releasing.md')

  it('reads a real workflow', () => {
    expect(jobIds(RELEASE_YML)).toEqual(
      expect.arrayContaining([
        'release-please',
        'advance-stable',
        'publish-mcp',
        'docker-publish-sign',
        'deploy-web',
      ]),
    )
    expect(environments(RELEASE_YML)).toEqual(
      expect.arrayContaining(['production-npm', 'production-docker', 'production-web']),
    )
  })

  it.each(jobIds(RELEASE_YML))('names the job `%s` in releasing.md and CONTRIBUTING.md', (job) => {
    expect(releasing, `releasing.md does not name \`${job}\``).toContain(`\`${job}\``)
    // release-please is the tool CONTRIBUTING already names throughout; the
    // jobs it triggers are the part a contributor would not otherwise find.
    if (job !== 'release-please') {
      expect(read('CONTRIBUTING.md'), `CONTRIBUTING.md does not name \`${job}\``).toContain(
        `\`${job}\``,
      )
    }
  })

  it.each(
    environments(RELEASE_YML),
  )('lists the environment `%s` under Required GitHub Environments', (env) => {
    const start = releasing.indexOf('## Required GitHub Environments')
    const section = releasing.slice(start, releasing.indexOf('\n## ', start + 3))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(section, `the section does not name \`${env}\``).toContain(`\`${env}\``)
  })

  it('says advance-stable never forces and what to do when it fails', () => {
    const section = releasing.slice(releasing.indexOf('### `advance-stable` job'))
    expect(section).toMatch(/non-fast-forward/i)
    expect(section).toContain('gh run rerun')
    // The workflow's push has no force flag; the doc must not promise one.
    expect(RELEASE_YML).not.toMatch(/git push[^\n]*(--force|-f\b|\+refs)/)
  })
})

describe('the Cloudflare Pages notes agree with the deploy workflows', () => {
  const pages = read('docs/contributing/deployment/cloudflare-pages.md')
  const wrangler = read('apps/web/wrangler.toml')
  const projectName = /^name\s*=\s*"([^"]+)"/m.exec(wrangler)?.[1]
  const workflowDir = join(REPO_ROOT, '.github/workflows')
  const deployWorkflows = readdirSync(workflowDir).filter((f) =>
    readFileSync(join(workflowDir, f), 'utf-8').includes('pages deploy'),
  )

  it('reads a project name and the deploy workflows', () => {
    expect(projectName).toBeTruthy()
    expect(deployWorkflows.length).toBeGreaterThanOrEqual(3)
  })

  it("passes the wrangler.toml project name to every `--project-name`, in the docs and in the workflows' deploy commands", () => {
    const named = [pages, ...deployWorkflows.map((f) => read(`.github/workflows/${f}`))].flatMap(
      (text) => [...text.matchAll(/--project-name[= ]([\w-]+)/g)].map((m) => m[1]),
    )
    expect(named.length).toBeGreaterThanOrEqual(4)
    expect(named.filter((n) => n !== projectName)).toEqual([])
  })

  it.each(deployWorkflows)('names the deploying workflow %s', (workflow) => {
    expect(pages).toContain(workflow)
  })

  it('names the preview script apps/web defines', () => {
    const scripts = (JSON.parse(read('apps/web/package.json')) as { scripts: object }).scripts
    expect(Object.keys(scripts)).toContain('preview:pages')
    expect(pages).toContain('preview:pages')
    expect(read('apps/web/README.md')).toContain('preview:pages')
  })

  it('does not claim the deploy is unwired or wrangler is unused', () => {
    expect(pages).not.toMatch(/not wired up yet/i)
    expect(pages).not.toMatch(/`wrangler pages dev` is not part of/i)
    expect(read('apps/web/README.md')).not.toMatch(/not currently implemented/i)
    expect(read('docs/contributing/testing.md')).not.toMatch(
      /no `\.github\/workflows\/` file deploys/i,
    )
  })

  // Pages serves index.html for an unknown path only while the project has no
  // top-level 404.html, and wrangler rejects a `/* /index.html 200` rule as a
  // loop, so neither file may exist in what `public/` ships into dist/.
  it('ships neither _redirects nor 404.html from public/', () => {
    expect(existsSync(join(REPO_ROOT, 'apps/web/public/_headers'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'apps/web/public/_redirects'))).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'apps/web/public/404.html'))).toBe(false)
  })
})

describe('SECURITY.md defers to the security model page and carries no retired claim', () => {
  const security = read('SECURITY.md')

  it('links the single description of the model', () => {
    expect(security).toContain('docs/explanation/security-model.md')
    expect(existsSync(join(REPO_ROOT, 'docs/explanation/security-model.md'))).toBe(true)
  })

  it('names server mode as in scope and the shipped provenance', () => {
    expect(security).toMatch(/server mode/i)
    expect(security).toContain('npm provenance')
    expect(security).toContain('cosign')
    expect(RELEASE_YML).toContain('--provenance')
    expect(RELEASE_YML).toContain('cosign sign')
  })

  const RETIRED = [
    {
      pattern: /127\.0\.0\.1/,
      why: 'the daemon listens on an owner-only socket, not a loopback address (ADR-0050)',
      example: 'the daemon binds to `127.0.0.1` only',
    },
    {
      pattern: /WebSocket/i,
      why: 'sync runs over SSE; there is no WebSocket',
      example: 'WebSocket frames are capped at 8 MiB',
    },
    {
      pattern: /\bslug\b/i,
      why: 'the word is retired (vocabulary.md); a document is addressed by path',
      example: 'all `sessionId` / `slug` / `fileId` URL parameters',
    },
    {
      pattern: /library_install/,
      why: 'no such tool exists',
      example: '`library_install` and friends fetch',
    },
    {
      pattern: /no `?npm provenance`?|npm package is unsigned/i,
      why: 'release.yml publishes with npm provenance and signs the image with cosign',
      example: 'The npm package is unsigned (no `npm provenance` yet)',
    },
    {
      pattern: /Multi-tenant or remote[^.]*not supported/i,
      why: 'server mode is a supported, documented deployment',
      example: 'Multi-tenant or remote MCP deployments are not supported.',
    },
    {
      pattern: /Bearer token issued by the daemon at startup/i,
      why: 'a hosted page holds no daemon credential; the native host attaches it',
      example: 'require a Bearer token issued by the daemon at startup',
    },
  ] as const

  it.each(RETIRED)('still matches its own example: $why', ({ pattern, example }) => {
    expect(pattern.test(example)).toBe(true)
  })

  it.each(RETIRED)('is absent from SECURITY.md: $pattern', ({ pattern, why }) => {
    expect(pattern.test(security), why).toBe(false)
  })
})

describe('CONTRIBUTING.md and testing.md carry the packaging and layout pointers', () => {
  const contributing = read('CONTRIBUTING.md')
  const testing = read('docs/contributing/testing.md')

  it('names the packaged smoke, which the root package defines and CI runs', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: object }).scripts
    expect(Object.keys(scripts)).toContain('smoke:distribution:packaged:node')
    expect(read('.github/workflows/ci.yml')).toContain('pnpm smoke:distribution:packaged:node')
    expect(contributing).toContain('pnpm smoke:distribution:packaged:node')
    expect(testing).toContain('pnpm smoke:distribution:packaged:node')
  })

  it("lists the tarball's real `files` and the script that checks it, run from the package", () => {
    const files = (JSON.parse(read('packages/mcp-server/package.json')) as { files: string[] })
      .files
    const section = contributing.slice(contributing.indexOf('### Local checks before merging'))
    const checks = section.slice(0, section.indexOf('### Config files'))
    for (const file of files) expect(checks, `${file} missing`).toContain(file)
    expect(checks).not.toContain('skills/')
    expect(checks).toContain('cd packages/mcp-server')
    expect(checks).toContain('tools/checks/src/verify-pack-contents.mjs')
    expect(existsSync(join(REPO_ROOT, 'tools/checks/src/verify-pack-contents.mjs'))).toBe(true)
  })

  it('points a reader at the architecture map and its data file', () => {
    const section = contributing.slice(contributing.indexOf('## Where code goes'))
    const body = section.slice(0, section.indexOf('\n## ', 3))
    expect(body.length).toBeGreaterThan(100)
    for (const target of [
      '.claude/rules/architecture-map.md',
      'tools/arch-lint/src/architecture-map.data.ts',
    ]) {
      expect(body).toContain(target)
      expect(existsSync(join(REPO_ROOT, target))).toBe(true)
    }
  })

  it('leaves no marketing copy placeholder in the user docs home', () => {
    expect(read('docs/README.md')).not.toMatch(/copy TBD/i)
  })
})
