// An operator can only set an environment variable they can find. The server's
// own source is the authority on which ones it reads, so this holds the docs
// to it: every key the deployment config declares, and every
// `WHITEBOARD_*` / `MCP_*` / `OTEL_*` the code reads straight off
// `process.env` (or through `envFlag('…')`), appears somewhere under `docs/` or
// in `.env.server.example`.
//
// Keys read through a constant other than `ENV_KEYS` are not seen here; the
// scan is a floor, and `docs/reference/configuration.md` remains where those
// are listed.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../shared/test-utils/repo-root.js'
import { ENV_KEYS } from './security/server-mode-env-config.js'

const REPO_ROOT = repoRoot()
const SOURCE_ROOT = join(REPO_ROOT, 'packages/mcp-server/src')

// Read by code that only a developer or a smoke harness runs, so documenting
// them for an operator would be noise. Checked from the other side: an entry
// whose key the source no longer reads, or that the docs now cover, fails.
const NOT_FOR_OPERATORS: Readonly<Record<string, string>> = {
  WHITEBOARD_SMOKE_RPC_TIMEOUT_MS: 'sizes the e2e smoke harness own request timeout',
}

// Named in the current docs without appearing in this repo's source: the
// operator sets them, a dependency reads them. Checked from the other side: an
// entry the source now names, or the docs no longer mention, fails.
const NOT_READ_BY_SOURCE: Readonly<Record<string, string>> = {
  OTEL_EXPORTER_OTLP_HEADERS: 'the OpenTelemetry exporter reads it, as the docs say',
  OTEL_EXPORTER_OTLP_TIMEOUT: 'the OpenTelemetry exporter reads it, as the docs say',
}

const NAME_PATTERN = /\b((?:WHITEBOARD|MCP|OTEL)_[A-Z0-9_]*[A-Z0-9])\b/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path)
    return /\.(?:[mc]?[jt]sx?)$/.test(entry.name) && !/\.test\.[mc]?[jt]sx?$/.test(entry.name)
      ? [path]
      : []
  })
}

// An ADR is history, so it may name a variable the code stopped reading.
function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'adr' ? [] : markdownFiles(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

/**
 * Every `WHITEBOARD_*` / `MCP_*` / `OTEL_*` name a package or app spells in its
 * source or its scripts (the dev daemon and the smokes read some).
 */
function namesInSource(): Set<string> {
  const roots = ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? ['src', 'scripts']
            .map((dir) => join(REPO_ROOT, group, entry.name, dir))
            .filter((dir) => existsSync(dir))
        : [],
    ),
  )
  const names = new Set<string>()
  for (const root of roots)
    for (const file of sourceFiles(root))
      for (const match of readFileSync(file, 'utf8').matchAll(NAME_PATTERN))
        names.add(match[1] as string)
  return names
}

function keysReadFromEnv(): Set<string> {
  const keys = new Set<string>(Object.values(ENV_KEYS))
  const reads = [
    /\benv(?:\.|\[')((?:WHITEBOARD|MCP|OTEL)_[A-Z0-9_]+)/g,
    /\benvFlag\('((?:WHITEBOARD|MCP|OTEL)_[A-Z0-9_]+)'/g,
  ]
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const read of reads)
      for (const match of source.matchAll(read)) keys.add(match[1] as string)
  }
  return keys
}

const documentation = [
  ...markdownFiles(join(REPO_ROOT, 'docs')),
  join(REPO_ROOT, '.env.server.example'),
]
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

function isDocumented(key: string): boolean {
  return new RegExp(`\\b${key}\\b`).test(documentation)
}

describe('environment variables the server reads are documented', () => {
  const keys = keysReadFromEnv()

  it('scans a real population: the deployment config and the direct reads', () => {
    expect(keys.size).toBeGreaterThan(20)
    expect(keys.has('WHITEBOARD_SERVER_EXTERNAL_URL')).toBe(true)
    expect(keys.has('WHITEBOARD_OTEL_ROLE')).toBe(true)
    // Read through `envFlag('…')` and as a bare `OTEL_*` off `process.env`, a
    // shape the plain `env.WHITEBOARD_*` read does not match: the tracing
    // switches went undocumented for operators while this scan reported clean.
    expect(keys.has('WHITEBOARD_OTEL')).toBe(true)
    expect(keys.has('OTEL_EXPORTER_OTLP_ENDPOINT')).toBe(true)
  })

  it('documents every key an operator can set', () => {
    const missing = [...keys].filter((key) => !(key in NOT_FOR_OPERATORS) && !isDocumented(key))
    expect(missing.sort()).toEqual([])
  })

  it('documents no variable the source does not name', () => {
    const named = namesInSource()
    expect(named.size).toBeGreaterThan(keys.size)
    const documented = new Set(
      [...documentation.matchAll(NAME_PATTERN)].map((match) => match[1] as string),
    )
    const unread = [...documented].filter((key) => !named.has(key) && !(key in NOT_READ_BY_SOURCE))
    expect(unread.sort()).toEqual([])
  })

  it('keeps the not-read list to names the docs still carry and the source still omits', () => {
    const named = namesInSource()
    for (const key of Object.keys(NOT_READ_BY_SOURCE)) {
      expect(named.has(key), `${key} is named by the source now`).toBe(false)
      expect(isDocumented(key), `${key} is no longer documented`).toBe(true)
    }
  })

  it('keeps the not-for-operators list to keys the source still reads and the docs still omit', () => {
    expect(Object.keys(NOT_FOR_OPERATORS).length).toBeGreaterThan(0)
    for (const key of Object.keys(NOT_FOR_OPERATORS)) {
      expect(keys.has(key), `${key} is no longer read by the source`).toBe(true)
      expect(isDocumented(key), `${key} is documented now, so it is for operators`).toBe(false)
    }
  })
})
