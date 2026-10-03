// A `smoke:*` script in a workspace manifest is a gate somebody wrote to catch
// a specific break, and a gate nothing runs catches nothing while reading
// exactly like coverage. `smoke:pwa-lifecycle` — a real-Chromium walk of the
// service worker's update lifecycle — sat in `apps/web` named by nothing: no
// workflow, no root script, no doc. The mocks that stand in for it in the unit
// tests cannot notice a build whose worker behaves differently.
//
// "Named" is deliberately weak: a workflow step, a root script that delegates
// to it, or a contributing doc that says when to run it. It does not prove the
// step runs on every PR — it proves a reader looking for who runs this gate
// finds an answer, and an unwired script is no longer silent.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, workspaceDirs } from './scan-roots.js'

interface Manifest {
  scripts?: Record<string, string>
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf-8')) as Manifest
}

/** Every `smoke:*` script declared by an `apps/*` or `packages/*` manifest, as `<dir> <script>`. */
function workspaceSmokeScripts(): { dir: string; script: string }[] {
  return workspaceDirs()
    .filter((dir) => dir.startsWith('apps/') || dir.startsWith('packages/'))
    .flatMap((dir) =>
      Object.keys(readManifest(dir).scripts ?? {})
        .filter((script) => script.startsWith('smoke:'))
        .map((script) => ({ dir, script })),
    )
}

function markdownFiles(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

/** Everything a script may legitimately be named in, concatenated: workflows, root scripts, contributing docs. */
function namingCorpus(): string {
  const workflows = readdirSync(join(REPO_ROOT, '.github/workflows'))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf-8'))
  const rootScripts = Object.values(readManifest('.').scripts ?? {})
  const docs = markdownFiles('docs/contributing').map((path) =>
    readFileSync(join(REPO_ROOT, path), 'utf-8'),
  )
  return [...workflows, ...rootScripts, ...docs].join('\n')
}

/**
 * `smoke:bridge` must not be satisfied by `smoke:bridge:firefox`, nor
 * `smoke:codex` by `smoke:codex-config`, so the name has to end where the
 * mention ends.
 */
function isNamed(script: string, corpus: string): boolean {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w:-])${escaped}(?![\\w:-])`).test(corpus)
}

describe('workspace smoke scripts', () => {
  it('are each named by a workflow, a root script or a contributing doc', () => {
    const corpus = namingCorpus()
    const unnamed = workspaceSmokeScripts()
      .filter(({ script }) => !isNamed(script, corpus))
      .map(({ dir, script }) => `${dir} ${script}`)

    expect(
      unnamed,
      'a smoke script nothing runs or documents is a gate that reads as coverage. Add a ci.yml ' +
        'step, a root script, or a line in docs/contributing — or delete the script.',
    ).toEqual([])
  })

  // The assertion above passes over an empty list if the enumeration or the
  // corpus read nothing, and over everything if the matcher accepts any name.
  it('finds the scripts and the corpus it matches them against', () => {
    const scripts = workspaceSmokeScripts().map(({ script }) => script)
    const corpus = namingCorpus()

    expect(scripts.length).toBeGreaterThan(20)
    expect(scripts).toContain('smoke:pwa-precache')
    expect(isNamed('smoke:pwa-precache', corpus)).toBe(true)
  })

  it('does not accept a name that no workflow, root script or doc carries', () => {
    const corpus = namingCorpus()

    expect(isNamed('smoke:no-such-gate-anywhere', corpus)).toBe(false)
  })

  it('does not count a longer name for its prefix', () => {
    expect(isNamed('smoke:bridge', 'pnpm smoke:bridge:firefox')).toBe(false)
    expect(isNamed('smoke:bridge', 'pnpm smoke:bridge --flag')).toBe(true)
    expect(isNamed('smoke:codex', 'run smoke:codex-config')).toBe(false)
  })
})
