// Contract tests for the server-mode Docker artifact.
//
// These tests read Dockerfile.server, docker-compose.server.yml,
// .env.server.example, and docs/how-to/self-host-with-docker.md and assert that the
// published contracts are met without running Docker:
//
//   - Entrypoint uses `whiteboard server run --json`, not daemon run or --token.
//   - Non-root user is configured.
//   - /data volume and WHITEBOARD_DATA_DIR=/data are present.
//   - Sensitive auth env vars are NOT baked into the image.
//   - Port binding is loopback-only in the Compose example.
//   - Required env vars are present in the env example.
//   - Forbidden patterns (wildcard origins, http:// external URL, credentialed
//     JWKS URI, "OAuth 2.1 compliant") are absent from example/docs.
//
// Manual mutation checks (run after editing the Dockerfile or examples):
//   - Change ENTRYPOINT to `daemon run` → test "entrypoint" fails.
//   - Add `--token=` to ENTRYPOINT → test "no daemon flags" fails.
//   - Remove USER directive → test "non-root user" fails.
//   - Remove VOLUME /data → test "data volume" fails.
//   - Add `WHITEBOARD_SERVER_EXTERNAL_URL=...` as ENV → test "no baked secrets" fails.
//   - Change port binding to 0.0.0.0 → test "loopback port binding" fails.
//   - Remove WHITEBOARD_SERVER_JWKS_URI from env example → required vars test fails.
//   - Add `--allowed-origins=*` to env example → forbidden pattern test fails.
//   - Revert the env example's usage comment to `cp .env.server.example .env.server`
//     (or change compose's env_file to .env.server) → test "usage comment names the
//     same env file that compose env_file declares" fails.
//   - Drop the `NODE_VERSION="$(cat .node-version)"` prefix from the env example's
//     compose-up instruction → test "usage comment keeps the NODE_VERSION build-arg
//     prefix" fails, while the cp-target equality test above stays green.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readText(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
}

const dockerfile = readText('Dockerfile.server')

/**
 * The base every stage builds `FROM`. A regex rather than the literal string,
 * because `${NODE_VERSION}` here is Dockerfile ARG interpolation and biome
 * reads a JS template placeholder that was never escaped.
 */
const GLIBC_BASE = /^FROM node:\$\{NODE_VERSION\}-slim/m
const compose = readText('docker-compose.server.yml')
const envExample = readText('.env.server.example')
const docs = readText('docs/how-to/self-host-with-docker.md')

describe('Dockerfile.server contracts', () => {
  it('gives the fetch stage every file pnpm fetch resolves from', () => {
    // `pnpm fetch` runs against a hand-picked subset of the repo, so any
    // file the lockfile RESOLUTION depends on has to be copied before it —
    // and a missing one fails the image build outright
    // (ERR_PNPM_PATCH_NOT_FOUND), which is how patches/ was found missing.
    const workspace = readText('pnpm-workspace.yaml')
    if (!/^patchedDependencies:/m.test(workspace)) return
    // Comments stripped first: the Dockerfile explains this requirement in
    // prose right above the COPY, and matching that mention instead of the
    // RUN line put the boundary before the very line being checked.
    const instructions = dockerfile.replace(/^\s*#.*$/gm, '')
    const beforeFetch = instructions.slice(0, instructions.indexOf('pnpm fetch'))
    expect(beforeFetch).toMatch(/^COPY\s+patches\b/m)
  })

  it('entrypoint uses whiteboard server run --json (not daemon run)', () => {
    expect(dockerfile).toMatch(/ENTRYPOINT.*server.*run.*--json/)
    // Comments may mention "daemon run" to explain what the image does NOT support.
    // Only check non-comment lines for the forbidden pattern.
    const nonComment = dockerfile
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(nonComment).not.toMatch(/daemon run/)
    expect(nonComment).not.toMatch(/daemon\s+run/)
  })

  it('does not include --token, WHITEBOARD_DAEMON_TOKEN, or daemon flags', () => {
    // Comments may reference these names to document exclusions; check only
    // non-comment lines so the intent is clear without false positives.
    const nonComment = dockerfile
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(nonComment).not.toMatch(/--token[=\s]/)
    expect(nonComment).not.toMatch(/WHITEBOARD_DAEMON_TOKEN/)
    const execLines = nonComment.split('\n').filter((l) => /^\s*(CMD|ENTRYPOINT|RUN)\b/.test(l))
    for (const line of execLines) {
      expect(line).not.toMatch(/\bdaemon\b/)
    }
  })

  it('configures a non-root user', () => {
    // The PROPERTY is a system user at uid/gid 1001 that the image switches
    // to. Asserted by uid rather than by the tool's name: this was
    // `addgroup`/`adduser` (BusyBox) while the base was Alpine, and matching
    // the spelling would have made a libc change look like a security
    // regression.
    expect(dockerfile).toMatch(/^RUN\s+groupadd\b.*\b1001\b/m)
    expect(dockerfile).toMatch(/useradd\b.*\b1001\b/m)
    expect(dockerfile).toMatch(/^USER\s+whiteboard/m)
  })

  // Alpine is the obvious "make the image smaller" edit, and it produces an
  // image that BUILDS and cannot start: the musl libsql prebuild this
  // dependency graph resolves fails with `fcntl64: symbol not found`. Measured
  // on CI once the docker smokes started running there. Going back means first
  // checking the resolved libsql has a musl prebuild that loads.
  it('runs on a glibc base, which libsql needs', () => {
    expect(dockerfile).toMatch(GLIBC_BASE)
    expect(dockerfile, 'a musl base needs a libsql musl prebuild that loads').not.toMatch(
      /^FROM node:\$\{NODE_VERSION\}-alpine/m,
    )
  })

  it('declares /data as a VOLUME and sets WHITEBOARD_DATA_DIR=/data', () => {
    expect(dockerfile).toMatch(/VOLUME\s+\/data/)
    expect(dockerfile).toMatch(/WHITEBOARD_DATA_DIR=\/data/)
  })

  it('exposes port 3099', () => {
    expect(dockerfile).toMatch(/EXPOSE\s+3099/)
  })

  it('does not bake WHITEBOARD_SERVER_* auth vars into the image', () => {
    // These must be supplied at run time, not hardcoded in ENV directives.
    const envLines = dockerfile
      .split('\n')
      .filter((l) => /^\s*ENV\b/.test(l))
      .join('\n')
    expect(envLines).not.toMatch(/WHITEBOARD_SERVER_EXTERNAL_URL/)
    expect(envLines).not.toMatch(/WHITEBOARD_SERVER_AUTH_STRATEGY/)
    expect(envLines).not.toMatch(/WHITEBOARD_SERVER_JWT_ISSUER/)
    expect(envLines).not.toMatch(/WHITEBOARD_SERVER_JWT_AUDIENCE/)
    expect(envLines).not.toMatch(/WHITEBOARD_SERVER_JWKS_URI/)
    expect(envLines).not.toMatch(/WHITEBOARD_SERVER_ALLOWED_ORIGINS/)
  })

  it('healthcheck uses /api/runtime/ping (not /api/runtime/status or doctor)', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/)
    expect(dockerfile).toMatch(/api\/runtime\/ping/)
    // doctor is not the default healthcheck — only the ping endpoint
    const healthcheckLine = dockerfile
      .split('\n')
      .filter((l) => /HEALTHCHECK/.test(l))
      .join('\n')
    expect(healthcheckLine).not.toMatch(/server doctor/)
    expect(healthcheckLine).not.toMatch(/runtime\/status/)
  })

  it('uses multi-stage build (build + runtime stages)', () => {
    const fromLines = dockerfile.split('\n').filter((l) => /^FROM\b/.test(l))
    expect(fromLines.length).toBeGreaterThanOrEqual(2)
    expect(fromLines.some((l) => l.includes('AS build'))).toBe(true)
    expect(fromLines.some((l) => l.includes('AS runtime'))).toBe(true)
  })
})

describe('docker-compose.server.yml contracts', () => {
  it('port binding is loopback-only (127.0.0.1), not 0.0.0.0', () => {
    // Must NOT expose to all interfaces.
    expect(compose).not.toMatch(/"0\.0\.0\.0:\d+:\d+"/)
    expect(compose).not.toMatch(/'0\.0\.0\.0:\d+:\d+'/)
    expect(compose).not.toMatch(/^\s*-\s*"?\d+:\d+"?\s*$/m)
    expect(compose).toMatch(/127\.0\.0\.1:3099:3099/)
  })

  it('does not include WHITEBOARD_DAEMON_TOKEN or daemon run', () => {
    expect(compose).not.toMatch(/WHITEBOARD_DAEMON_TOKEN/)
    expect(compose).not.toMatch(/daemon run/)
  })

  it('references Dockerfile.server', () => {
    expect(compose).toMatch(/Dockerfile\.server/)
  })

  it('mounts a data volume at /data', () => {
    expect(compose).toMatch(/\/data/)
    expect(compose).toMatch(/whiteboard_data/)
  })
})

describe('.env.server.example contracts', () => {
  const REQUIRED_VARS = [
    'WHITEBOARD_SERVER_EXTERNAL_URL',
    'WHITEBOARD_SERVER_AUTH_STRATEGY',
    'WHITEBOARD_SERVER_JWT_ISSUER',
    'WHITEBOARD_SERVER_JWT_AUDIENCE',
    'WHITEBOARD_SERVER_JWKS_URI',
    'WHITEBOARD_SERVER_ALLOWED_ORIGINS',
  ]

  for (const varName of REQUIRED_VARS) {
    it(`contains required variable ${varName}`, () => {
      expect(envExample).toMatch(new RegExp(`^${varName}=`, 'm'))
    })
  }

  it('WHITEBOARD_SERVER_EXTERNAL_URL uses https:// placeholder', () => {
    const match = envExample.match(/^WHITEBOARD_SERVER_EXTERNAL_URL=(.+)$/m)
    expect(match).not.toBeNull()
    expect(match![1]).toMatch(/^https:\/\//)
  })

  it('WHITEBOARD_SERVER_JWKS_URI uses https:// (no credentials or query params)', () => {
    const match = envExample.match(/^WHITEBOARD_SERVER_JWKS_URI=(.+)$/m)
    expect(match).not.toBeNull()
    const uri = match![1]
    expect(uri).toMatch(/^https:\/\//)
    // No credentials (user:pass@) in the URI.
    expect(uri).not.toMatch(/:[^/].*@/)
    // No query parameters or fragments that could carry secrets.
    expect(uri).not.toMatch(/[?#]/)
  })

  it('WHITEBOARD_SERVER_ALLOWED_ORIGINS does not contain a wildcard', () => {
    const match = envExample.match(/^WHITEBOARD_SERVER_ALLOWED_ORIGINS=(.+)$/m)
    expect(match).not.toBeNull()
    expect(match![1]).not.toContain('*')
  })

  it('does not contain an http:// external URL', () => {
    // All external URL examples must use https://.
    const lines = envExample
      .split('\n')
      .filter((l) => l.startsWith('WHITEBOARD_SERVER_EXTERNAL_URL='))
    for (const line of lines) {
      expect(line).not.toMatch(/=http:\/\//)
    }
  })

  it('does not mention WHITEBOARD_DAEMON_TOKEN', () => {
    expect(envExample).not.toMatch(/WHITEBOARD_DAEMON_TOKEN/)
  })

  it('does not reference the whiteboard daemon run command', () => {
    expect(envExample).not.toMatch(/whiteboard daemon run/)
  })

  it('usage comment names the same env file that compose env_file declares', () => {
    const composeEnvFile = compose.match(/env_file:\s*\n\s*-\s*(\S+)/)
    expect(composeEnvFile).not.toBeNull()
    const cpTarget = envExample.match(/cp \.env\.server\.example\s+(\S+)/)
    expect(cpTarget).not.toBeNull()
    expect(cpTarget![1]).toBe(composeEnvFile![1])
  })

  it('usage comment keeps the NODE_VERSION build-arg prefix on the compose up line', () => {
    expect(envExample).toMatch(
      /NODE_VERSION="\$\(cat \.node-version\)" docker compose -f docker-compose\.server\.yml up -d --build/,
    )
  })

  it('does not reference the stale --env-file .env.server instruction', () => {
    expect(envExample).not.toContain('--env-file .env.server')
  })
})

describe('docs/how-to/self-host-with-docker.md contracts', () => {
  it('references whiteboard server run, not daemon run', () => {
    expect(docs).toMatch(/whiteboard server run/)
    expect(docs).not.toMatch(/whiteboard daemon run/)
  })

  it('mentions reverse proxy and TLS termination', () => {
    expect(docs).toMatch(/reverse proxy/i)
    expect(docs).toMatch(/TLS/i)
  })

  it('does not claim "OAuth 2.1 compliant"', () => {
    expect(docs).not.toMatch(/OAuth 2\.1 compliant/i)
  })

  it('does not mix local-daemon token terminology with server-mode', () => {
    // doc may mention WHITEBOARD_DAEMON_TOKEN to warn against it, but must not
    // assign it (WHITEBOARD_DAEMON_TOKEN=) or suggest using it in server mode
    expect(docs).not.toMatch(/WHITEBOARD_DAEMON_TOKEN=/)
    expect(docs).not.toMatch(/daemon.*token.*server.mode/i)
  })

  it('non-root user is documented', () => {
    expect(docs).toMatch(/non.root/i)
  })

  it('data volume is documented', () => {
    expect(docs).toMatch(/\/data/)
    expect(docs).toMatch(/volume/i)
  })
})

// Every place that builds Dockerfile.server has to supply NODE_VERSION.
//
// The ARG has no default on purpose, so a build that omits it resolves
// `FROM node:${NODE_VERSION}-slim` to `node:-slim` and fails on an
// invalid reference. Three of the four call sites omitted it and nothing was
// red: the two Docker smokes run only on the release path, and the
// build-push-action step runs only on a release tag — so the first execution
// of any of them would have been during a publish. The one call site that did
// pass it (publish:dry-run:docker) is the one CI runs, which is exactly the
// shape that makes a green pipeline say nothing about the release path.
//
// A classify-family scan (see .claude/rules/coverage-ledger.md), guarded from
// both sides: a file that reaches the image build and is not classified fails,
// and a classified file that no longer reaches it fails too. The scan matches
// the shared helper as well as the Dockerfile name, because delegating to the
// helper is precisely what would otherwise drop a call site out of view.
type DockerfileUse =
  | { builds: 'direct' }
  | { builds: 'via-helper' }
  | { builds: false; reason: string }

const BUILD_HELPER = 'resolveServerImage'

const DOCKERFILE_USES = {
  'docker-compose.server.yml': { builds: 'direct' },
  '.github/workflows/release.yml': { builds: 'direct' },
  'packages/mcp-server/scripts/release/publish-dry-run-docker.mjs': { builds: 'direct' },
  'tests/e2e/distribution/smoke-helpers.mjs': { builds: 'direct' },
  'tests/e2e/distribution/packaged-server-mode-docker-smoke.mjs': { builds: 'via-helper' },
  'tests/e2e/distribution/packaged-server-mode-backup-restore-smoke.mjs': { builds: 'via-helper' },
  '.github/workflows/ci.yml': {
    builds: false,
    reason: 'names the file in a comment; the build itself is pnpm publish:dry-run:docker',
  },
  'tools/checks/src/docker-build-inputs.mjs': {
    builds: false,
    reason: 'reads the Dockerfile to derive which diffs can affect a build; never runs one',
  },
  'tools/arch-lint/src/repo-root-files.test.ts': {
    builds: false,
    reason: 'asserts the file is an allowed repo-root entry',
  },
  'tests/e2e/distribution/release-gate-matrix.json': {
    builds: false,
    reason: 'a gate description quotes the filename',
  },
  'tests/e2e/distribution/supply-chain-policy.json': {
    builds: false,
    reason: 'an artifact description quotes the filename',
  },
  'packages/mcp-server/src/server/docker-contract.test.ts': {
    builds: false,
    reason: 'this file — it reads the Dockerfile to assert its contracts',
  },
  'packages/mcp-server/src/server/release/docker-build-inputs.test.ts': {
    builds: false,
    reason: 'covers the diff-affects-build derivation',
  },
  'packages/mcp-server/src/server/release/dockerfile-cache-mounts.test.ts': {
    builds: false,
    reason: 'asserts the file declares no cache mount a cached layer would empty',
  },
  'packages/mcp-server/src/server/release/smoke-image-reuse.test.ts': {
    builds: false,
    reason: 'covers the reuse contract with an injected docker, never a real build',
  },
  'packages/mcp-server/scripts/release/buildx-progress.test.ts': {
    builds: false,
    reason:
      'its sample of buildx progress output quotes the Dockerfile name, as real output does; the parser under test reads text and never runs a build',
  },
} satisfies Record<string, DockerfileUse>

// Directories a build invocation could plausibly live in. Deliberately not the
// whole tree: docs/ describes the file in prose, and node_modules/ is noise.
const SCAN_DIRS = [
  '.',
  '.github/workflows',
  'tests/e2e/distribution',
  'packages/mcp-server/scripts/release',
  'packages/mcp-server/src/server',
  'packages/mcp-server/src/server/release',
  'tools/checks/src',
  'tools/arch-lint/src',
]

function filesReachingTheImageBuild(): string[] {
  const found: string[] = []
  for (const dir of SCAN_DIRS) {
    for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!/\.(mjs|ts|yml|yaml|json)$/.test(entry.name)) continue
      const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`
      const text = readText(rel)
      if (text.includes('Dockerfile.server') || text.includes(BUILD_HELPER)) found.push(rel)
    }
  }
  return found.sort()
}

describe('every Dockerfile.server build supplies NODE_VERSION', () => {
  const reaching = filesReachingTheImageBuild()

  it('the ARG has no default, which is what makes omitting it fatal', () => {
    expect(dockerfile).toMatch(/^ARG NODE_VERSION$/m)
    expect(dockerfile).toMatch(GLIBC_BASE)
  })

  it('found a plausible number of files reaching the image build', () => {
    // A scan that silently matches nothing reports itself as "every entry is
    // stale", which sends the reader to the wrong file entirely.
    expect(reaching.length).toBeGreaterThan(5)
  })

  it('classifies every file that reaches the image build', () => {
    const unclassified = reaching.filter((f) => !(f in DOCKERFILE_USES))
    expect(
      unclassified,
      'a new file reaches the image build — say in DOCKERFILE_USES whether it BUILDS the image',
    ).toEqual([])
  })

  it('has no entry naming a file that no longer reaches the image build', () => {
    const stale = Object.keys(DOCKERFILE_USES).filter((f) => !reaching.includes(f))
    expect(stale).toEqual([])
  })

  // Each alternative is one real mechanism for PASSING a build arg, and the
  // order matters: the key comes before the value. A plain
  // `.toContain('NODE_VERSION')` was tried first and let the original defect
  // straight through — release.yml names the variable in a step name and a
  // comment, so the file mentioned it while the build-push-action step passed
  // nothing. A guard that matches prose is a guard that passes on the bug it
  // was written for.
  const PASSES_BUILD_ARG = [
    /--build-arg[\s\S]{0,80}NODE_VERSION=/, // docker CLI / buildx argv
    /build-args:[\s\S]{0,200}NODE_VERSION=/, // docker/build-push-action
    /\bargs:[\s\S]{0,120}NODE_VERSION:/, // compose build.args
  ]

  it('passes the build arg from every file that builds the image directly', () => {
    for (const [file, use] of Object.entries(DOCKERFILE_USES)) {
      if (use.builds !== 'direct') continue
      const text = readText(file)
      expect(
        PASSES_BUILD_ARG.some((re) => re.test(text)),
        `${file} builds Dockerfile.server without passing NODE_VERSION — the build resolves node:-slim and fails`,
      ).toBe(true)
    }
  })

  it('routes every indirect builder through the one helper that supplies it', () => {
    for (const [file, use] of Object.entries(DOCKERFILE_USES)) {
      if (use.builds !== 'via-helper') continue
      const text = readText(file)
      expect(text, `${file} must import ${BUILD_HELPER}`).toContain(BUILD_HELPER)
      expect(
        text,
        `${file} builds the image itself instead of going through ${BUILD_HELPER} — that is how the build arg went missing`,
      ).not.toMatch(/\[\s*'build'/)
    }
  })

  it('gives a real reason for every file classified as not building', () => {
    for (const [file, use] of Object.entries(DOCKERFILE_USES)) {
      if (use.builds !== false) continue
      expect(use.reason.trim().length, `${file} needs a reason`).toBeGreaterThan(20)
    }
  })
})
