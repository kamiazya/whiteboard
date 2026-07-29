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

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

function readText(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8')
}

const dockerfile = readText('Dockerfile.server')
const compose = readText('docker-compose.server.yml')
const envExample = readText('.env.server.example')
const docs = readText('docs/how-to/self-host-with-docker.md')

describe('Dockerfile.server contracts', () => {
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
    // Must add a group and user, and switch to it with USER directive.
    expect(dockerfile).toMatch(/addgroup/)
    expect(dockerfile).toMatch(/adduser/)
    expect(dockerfile).toMatch(/^USER\s+whiteboard/m)
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
