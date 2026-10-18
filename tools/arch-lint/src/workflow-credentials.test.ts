import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

// Where a workflow's credentials may sit, read across every workflow: the git
// token a checkout leaves in .git/config, and the deploy and publish secrets
// a job is handed. release.yml's OIDC and registry-push jobs have their own
// rules in ci-policy.test.ts.

interface WorkflowStep {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  'working-directory'?: string
}
interface WorkflowJob {
  needs?: string | string[]
  permissions?: Record<string, string>
  outputs?: Record<string, string>
  steps?: WorkflowStep[]
}
interface WorkflowJobSite {
  site: string
  file: string
  id: string
  job: WorkflowJob
}

function everyWorkflowJob(): WorkflowJobSite[] {
  const dir = join(REPO_ROOT, '.github/workflows')
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((file) => {
      const workflow = parseYaml(readFileSync(join(dir, file), 'utf-8')) as {
        jobs?: Record<string, WorkflowJob>
      }
      return Object.entries(workflow.jobs ?? {}).map(([id, job]) => ({
        site: `${file}:${id}`,
        file,
        id,
        job,
      }))
    })
}

describe('workflows — a checkout keeps the job token only where the job pushes with it', () => {
  // actions/checkout writes the token into .git/config unless told not to, and
  // every later step — the install, the build, the PR's own tests — can read it.
  const PUSHES_WITH_TOKEN: Record<string, string> = {
    'release.yml:advance-stable':
      'fast-forwards the stable branch with `git push origin`, which uses the token',
  }
  const sites = everyWorkflowJob()
  const checkouts = sites.flatMap(({ site, job }) =>
    (job.steps ?? [])
      .filter((step) => (step.uses ?? '').startsWith('actions/checkout@'))
      .map((step) => ({ site, step })),
  )

  it('finds the checkouts', () => {
    expect(checkouts.length).toBeGreaterThan(20)
  })

  it('every checkout outside the ledger sets persist-credentials: false', () => {
    const keeping = checkouts
      .filter(({ site }) => PUSHES_WITH_TOKEN[site] === undefined)
      .filter(({ step }) => step.with?.['persist-credentials'] !== false)
      .map(({ site }) => site)
    expect(keeping).toEqual([])
  })

  it.each(Object.keys(PUSHES_WITH_TOKEN))('ledgered %s still pushes', (site) => {
    const job = sites.find((s) => s.site === site)?.job
    const runs = (job?.steps ?? []).map((step) => step.run ?? '')
    expect(runs.some((run) => /\bgit push\b/.test(run))).toBe(true)
  })
})

/**
 * A deploy or publish secret is handed to one step, but a step boundary is no
 * boundary inside one job's filesystem: an earlier install or build runs
 * dependency code that can rewrite whatever the secret-holding step executes
 * next — the wrangler binary, a composite action's checkout, a script. So a
 * job that holds such a secret runs no repository or dependency code at all.
 * The Cloudflare deploys receive a site a contents-read build job produced,
 * check it, and deploy it with a wrangler installed from its own lockfile
 * under `--ignore-scripts`, so nothing in the job executes before wrangler.
 */
describe('workflows — a job holding a deploy or publish secret runs no repository or dependency code', () => {
  // Every repository secret is a credential: one a job is handed is something
  // that job's code could exfiltrate. GITHUB_TOKEN is the exception, because it
  // is the job token every job holds anyway and `permissions:` scopes it.
  const CREDENTIAL_SECRET_RE = /secrets\.(?!GITHUB_TOKEN\b)\w+/
  // A credential job that has to READ the whole tree, and so checks out more
  // than the deploy tooling. Reading is not running: the job still executes no
  // repository or dependency code, which the step findings below hold.
  const READS_WHOLE_TREE: Record<string, string> = {
    'sonarqube.yml:scan':
      'the SonarQube scanner analyses every source file and maps coverage onto it; it parses them and executes none',
  }
  const DEPLOY_TOOLING_DIR = '.github/deploy'
  // The one install a credential job may run: the deploy tooling's own
  // lockfile, integrity-checked and with every lifecycle script off.
  const TOOLING_INSTALL_RE = /^\s*npm ci --ignore-scripts(?: --no-audit| --no-fund)*\s*$/
  // And the one read beside it: the installed version, for wrangler-action.
  const TOOLING_VERSION_LINE = `echo "wrangler=$(jq -r '.packages["node_modules/wrangler"].version' package-lock.json)" >> "$GITHUB_OUTPUT"`
  const RUNS_CODE = [
    /\bpnpm\b/,
    /\bnpx\b/,
    /\bcorepack\b/,
    /\bnode\s/,
    /\bnpm\s+(install|i|ci|run|run-script|exec|test|pack|rebuild|publish)\b/,
    /\byarn\b/,
    /\bbun\b/,
    /\b(?:bash|sh)\s+(?:-\S+\s+)*[^\s;&|-]/,
    /\bpython3?\b/,
    /(?:^|[\s;&|(])\.{1,2}\/\S/m,
    /\bdocker\s+(?:build|buildx\s+build)\b/,
    /\bwrangler\b/,
  ]
  const COMMIT_PINNED_RE = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/

  const holdsCredential = (job: WorkflowJob): boolean =>
    CREDENTIAL_SECRET_RE.test(JSON.stringify(job))

  /** Every step of a credential job that could run code the job did not pin. */
  function findings(job: WorkflowJob, site = ''): string[] {
    return (job.steps ?? []).flatMap((step) => {
      const label = step.name ?? step.uses ?? step.run ?? '?'
      const uses = step.uses ?? ''
      if (uses.startsWith('./')) return [`${label}: runs a repository action`]
      if (uses !== '' && !COMMIT_PINNED_RE.test(uses)) return [`${label}: action not SHA-pinned`]
      if (uses.startsWith('actions/checkout@')) {
        if (step.with?.['persist-credentials'] !== false) return [`${label}: keeps the job token`]
        const tooling =
          READS_WHOLE_TREE[site] !== undefined ||
          String(step.with?.['sparse-checkout'] ?? '').trim() === DEPLOY_TOOLING_DIR
        return tooling ? [] : [`${label}: checks out more than ${DEPLOY_TOOLING_DIR}`]
      }
      const lines = (step.run ?? '')
        .split('\n')
        .filter(
          (line) =>
            !(
              step['working-directory'] === DEPLOY_TOOLING_DIR &&
              (TOOLING_INSTALL_RE.test(line) || line.trim() === TOOLING_VERSION_LINE)
            ),
        )
        .join('\n')
      return RUNS_CODE.filter((pattern) => pattern.test(lines)).map(
        (pattern) => `${label}: runs ${pattern}`,
      )
    })
  }

  const credentialJobs = everyWorkflowJob().filter(({ job }) => holdsCredential(job))

  it('finds the jobs holding a deploy or publish secret', () => {
    expect(credentialJobs.map(({ site }) => site)).toEqual(
      expect.arrayContaining([
        'release.yml:release-please',
        'release.yml:deploy-web',
        'deploy-preview.yml:deploy-latest',
        'preview-pr-deploy.yml:deploy',
        'sonarqube.yml:scan',
      ]),
    )
  })

  it.each(
    credentialJobs.map(({ site, job }) => [site, job] as const),
  )('%s runs no install, build, test or repository action', (site, job) => {
    expect(findings(job, site)).toEqual([])
  })

  it.each(Object.keys(READS_WHOLE_TREE))('ledgered %s still holds a credential', (site) => {
    expect(credentialJobs.map((s) => s.site)).toContain(site)
  })

  // The scanner runs no repository code unless its configuration names a
  // program for it: `sonar.nodejs.executable` or `sonar.scanner.javaExePath`
  // pointing into the checkout would run that file with the token in reach.
  it('sonar-project.properties names no program for the scanner to run', () => {
    const properties = readFileSync(join(REPO_ROOT, 'sonar-project.properties'), 'utf-8')
    const keys = properties
      .split('\n')
      .map((line) => /^\s*([\w.-]+)\s*[=:]/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined)
    expect(keys).toContain('sonar.projectKey')
    expect(keys.filter((key) => /executable|exepath/i.test(key))).toEqual([])
  })

  it('flags an install planted in the SonarQube scan job', () => {
    const scan = credentialJobs.find(({ site }) => site === 'sonarqube.yml:scan')?.job
    expect(scan).toBeDefined()
    const steps = scan?.steps ?? []
    const planted: WorkflowJob = {
      ...scan,
      steps: [
        ...steps.slice(0, 1),
        { uses: './.github/actions/setup-pnpm' },
        { run: 'pnpm install --frozen-lockfile' },
        ...steps.slice(1),
      ],
    }
    expect(findings(planted, 'sonarqube.yml:scan')).toHaveLength(2)
  })

  it('flags a build planted in a deploy job', () => {
    const planted: WorkflowJob = {
      steps: [
        { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' },
        { uses: './.github/actions/setup-pnpm' },
        { run: 'pnpm install --frozen-lockfile' },
        { run: 'pnpm --filter @kamiazya/whiteboard-web build' },
        { run: 'npm ci --ignore-scripts' },
        {
          uses: 'cloudflare/wrangler-action@v4',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
          with: { apiToken: '${{ secrets.CLOUDFLARE_API_TOKEN }}' },
        },
      ],
    }
    expect(holdsCredential(planted)).toBe(true)
    expect(findings(planted)).toHaveLength(6)
  })

  // Read tolerantly so a missing file fails the pin assertion by name rather
  // than aborting the whole file at collection.
  const readTooling = (file: string): unknown => {
    const path = join(REPO_ROOT, DEPLOY_TOOLING_DIR, file)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}
  }
  const toolingLock = readTooling('package-lock.json') as {
    packages?: Record<string, { version?: string }>
  }
  const toolingManifest = readTooling('package.json') as {
    dependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
  const lockedWrangler = toolingLock.packages?.['node_modules/wrangler']?.version

  it('pins wrangler exactly in the deploy tooling and its lockfile', () => {
    expect(lockedWrangler).toMatch(/^\d+\.\d+\.\d+$/)
    expect(toolingManifest.dependencies).toEqual({ wrangler: lockedWrangler })
    expect(toolingManifest.scripts).toBeUndefined()
  })

  const deployJobs = credentialJobs.filter(({ job }) =>
    (job.steps ?? []).some((step) => (step.uses ?? '').startsWith('cloudflare/wrangler-action@')),
  )

  it('finds the Cloudflare deploy jobs', () => {
    expect(deployJobs.map(({ site }) => site)).toEqual([
      'deploy-preview.yml:deploy-latest',
      'preview-pr-deploy.yml:deploy',
      'release.yml:deploy-web',
    ])
  })

  const jobsByFile = new Map<string, Record<string, WorkflowJob>>()
  for (const { file, id, job } of everyWorkflowJob()) {
    jobsByFile.set(file, { ...(jobsByFile.get(file) ?? {}), [id]: job })
  }

  describe.each(
    deployJobs.map(({ site, file, job }) => [site, file, job] as const),
  )('%s', (_site, file, job) => {
    const steps = job.steps ?? []
    const deployAt = steps.findIndex((s) =>
      (s.uses ?? '').startsWith('cloudflare/wrangler-action@'),
    )
    const before = steps.slice(0, deployAt)

    it('deploys with the tooling wrangler, so the action installs nothing', () => {
      const action = steps[deployAt]?.with ?? {}
      expect(action.workingDirectory).toBe(DEPLOY_TOOLING_DIR)
      expect(action.packageManager).toBe('npm')
      // The action installs its own wrangler unless the one present equals
      // wranglerVersion exactly, so the version is read from the lockfile the
      // tooling step just installed from.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
      expect(action.wranglerVersion).toBe('${{ steps.tooling.outputs.wrangler }}')
      const tooling = before.find((s) => s.id === 'tooling')
      expect(tooling?.['working-directory']).toBe(DEPLOY_TOOLING_DIR)
      const lines = (tooling?.run ?? '').split('\n')
      expect(lines.some((line) => TOOLING_INSTALL_RE.test(line))).toBe(true)
      expect(lines).toContain(TOOLING_VERSION_LINE)
    })

    it('deploys an artifact it checked first', () => {
      const download = before.find((s) => (s.uses ?? '').startsWith('actions/download-artifact@'))
      expect(download, 'downloads the built site before deploying').toBeDefined()
      if (download?.with?.['run-id'] !== undefined) {
        // Another run's artifact: no digest from it is worth more than the
        // artifact itself, so what it may contain is what is checked.
        const guard = before.find((s) => s.id === 'guard')
        expect(guard?.run).toContain('_worker.js')
        expect(guard?.run).toContain('_routes.json')
        expect(steps[deployAt]?.if).toContain("steps.guard.outputs.ready == 'true'")
        return
      }
      const jobs = jobsByFile.get(file) ?? {}
      const builders = [job.needs ?? []]
        .flat()
        .filter((id) => Object.keys(jobs[id]?.outputs ?? {}).some((key) => key.endsWith('sha256')))
      expect(builders, 'a needed job publishing a sha256 output').toHaveLength(1)
      expect(before.some((s) => /sha256sum\s+(-c|--check)\b/.test(s.run ?? ''))).toBe(true)
      const builder = jobs[builders[0] as string] as WorkflowJob
      expect(builder.permissions).toEqual({ contents: 'read' })
      expect(holdsCredential(builder)).toBe(false)
    })
  })
})

/**
 * A job whose output is published or deployed builds from a cold pnpm store.
 * The store cache is keyed only by the lockfile hash, with a prefix fallback,
 * and the default branch's own test, coverage and mutation jobs — which run
 * every dev and test dependency — write it. A store poisoned there would be
 * linked into the npm tarball, the image or the site, and the sha256 the build
 * reports is taken after the install, so it would certify the poisoned output.
 * So every job a publishing job `needs`, transitively, opts out of the store
 * cache and restores no other cache. A `workflow_run` upstream is out of
 * reach here by design: preview-pr-build.yml runs the PR's own copy of its
 * file, so nothing in it can be enforced from the default branch, and its
 * deploy checks what the artifact contains instead.
 */
describe('workflows — every job a publish or deploy job needs builds from a cold store', () => {
  const SETUP_PNPM = './.github/actions/setup-pnpm'
  const CACHE_ACTION_RE = /^actions\/cache(?:\/restore)?@/
  const SETUP_NODE_RE = /^actions\/setup-node@/
  // A publish or deploy credential: a repository secret, or a token the job
  // mints for a registry — npm and Sigstore OIDC, the GHCR push.
  const publishes = (job: WorkflowJob): boolean =>
    /secrets\.(?!GITHUB_TOKEN\b)\w+/.test(JSON.stringify(job)) ||
    job.permissions?.['id-token'] === 'write' ||
    job.permissions?.packages === 'write'

  const sites = everyWorkflowJob()
  const byFile = new Map<string, Map<string, WorkflowJob>>()
  for (const { file, id, job } of sites) {
    byFile.set(file, (byFile.get(file) ?? new Map()).set(id, job))
  }
  function upstream(file: string, id: string, seen = new Set<string>()): Set<string> {
    for (const need of [byFile.get(file)?.get(id)?.needs ?? []].flat()) {
      if (seen.has(need)) continue
      seen.add(need)
      upstream(file, need, seen)
    }
    return seen
  }
  const upstreamSites = [
    ...new Set(
      sites
        .filter(({ job }) => publishes(job))
        .flatMap(({ file, id }) => [...upstream(file, id)].map((need) => `${file}:${need}`)),
    ),
  ].sort()

  function cacheFindings(job: WorkflowJob): string[] {
    return (job.steps ?? []).flatMap((step) => {
      const uses = step.uses ?? ''
      const label = step.name ?? uses
      if (uses === SETUP_PNPM && step.with?.['cache-store'] !== 'false')
        return [`${label}: restores the pnpm store cache`]
      if (CACHE_ACTION_RE.test(uses)) return [`${label}: restores a cache`]
      if (SETUP_NODE_RE.test(uses) && step.with?.cache !== undefined)
        return [`${label}: setup-node restores a package-manager cache`]
      return []
    })
  }

  it('finds the build jobs upstream of a publish or deploy', () => {
    expect(upstreamSites).toEqual(
      expect.arrayContaining([
        'deploy-preview.yml:build-latest',
        'release.yml:build-docker',
        'release.yml:build-mcp',
        'release.yml:build-web',
        'sonarqube.yml:coverage',
      ]),
    )
  })

  it.each(upstreamSites)('%s restores no cache', (site) => {
    const job = sites.find((s) => s.site === site)?.job as WorkflowJob
    expect(cacheFindings(job)).toEqual([])
  })

  it('flags each way a cache can be restored', () => {
    expect(
      cacheFindings({
        steps: [
          { uses: SETUP_PNPM },
          { uses: SETUP_PNPM, with: { 'cache-store': 'false' } },
          { uses: 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9' },
          { uses: 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9' },
          {
            uses: 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
            with: { cache: 'pnpm' },
          },
        ],
      }),
    ).toHaveLength(4)
  })

  // `cache-store: 'false'` is only worth what the action does with it.
  it("setup-pnpm restores nothing when cache-store is 'false'", () => {
    const action = parseYaml(
      readFileSync(join(REPO_ROOT, '.github/actions/setup-pnpm/action.yml'), 'utf-8'),
    ) as { runs?: { steps?: WorkflowStep[] } }
    const steps = action.runs?.steps ?? []
    const caches = steps.filter((step) => CACHE_ACTION_RE.test(step.uses ?? ''))
    expect(caches.length).toBeGreaterThan(0)
    for (const step of caches) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
      expect(step.if?.replace(/\s+/g, '')).toBe("${{inputs.cache-store=='true'}}")
    }
    const setupNode = steps.filter((step) => SETUP_NODE_RE.test(step.uses ?? ''))
    expect(setupNode).toHaveLength(1)
    for (const step of setupNode) {
      expect(step.with?.cache).toBeUndefined()
      // setup-node detects a package manager on its own unless told not to.
      expect(step.with?.['package-manager-cache']).toBe(false)
    }
  })
})
