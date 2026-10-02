// An operator can only set an environment variable they can find. The server's
// own source is the authority on which ones it reads, so this holds the docs
// to it: every key the deployment config declares, and every
// `WHITEBOARD_*` / `MCP_*` the code reads straight off `process.env`, appears
// somewhere under `docs/` or in `.env.server.example`.
//
// Keys read through a constant other than `ENV_KEYS` are not seen here; the
// scan is a floor, and `docs/reference/configuration.md` remains where those
// are listed.
import { readdirSync, readFileSync } from 'node:fs'
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

function keysReadFromEnv(): Set<string> {
  const keys = new Set<string>(Object.values(ENV_KEYS))
  const read = /\benv(?:\.|\[')((?:WHITEBOARD|MCP)_[A-Z0-9_]+)/g
  for (const file of sourceFiles(SOURCE_ROOT)) {
    for (const match of readFileSync(file, 'utf8').matchAll(read)) keys.add(match[1] as string)
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
  })

  it('documents every key an operator can set', () => {
    const missing = [...keys].filter((key) => !(key in NOT_FOR_OPERATORS) && !isDocumented(key))
    expect(missing.sort()).toEqual([])
  })

  it('keeps the not-for-operators list to keys the source still reads and the docs still omit', () => {
    expect(Object.keys(NOT_FOR_OPERATORS).length).toBeGreaterThan(0)
    for (const key of Object.keys(NOT_FOR_OPERATORS)) {
      expect(keys.has(key), `${key} is no longer read by the source`).toBe(true)
      expect(isDocumented(key), `${key} is documented now, so it is for operators`).toBe(false)
    }
  })
})
