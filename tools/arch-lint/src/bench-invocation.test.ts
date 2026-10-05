// A benchmark's table IS its output, and two mistakes each leave a bench
// command printing no numbers.
//
// The reporter: vitest 5 defaults to `minimal` whenever std-env reports an
// agent (a Claude Code shell's CLAUDECODE=1 alone is enough), and it renders
// only failing tests — no bench table. The script names its reporter rather
// than the root config, because a `reporters` key there also replaces the
// `github-actions` reporter vitest adds on CI, whose annotations flake-watch
// reads.
//
// The project: bench mode runs a project's benchmark files under a sibling
// named `<name> (bench)`, and a bare `--project <name>` answers `No projects
// matched the filter`. So a file's "Run with" line is checked against the
// inventory, and `pnpm bench` against every project that declares benchmarks.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

const { readVitestProjects } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/vitest-projects.mjs')).href
)) as {
  readVitestProjects: (repoRoot: string) => { configPath: string; name: string | undefined }[]
}

/** Reporters that render a bench table for a passing run. */
const TABLE_REPORTERS = new Set(['default', 'verbose', 'tree'])

const benchScript =
  (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
  ).scripts?.bench ?? ''

/** `<name> (bench)` -> the directory its benchmark files live under. */
const benchProjects = new Map<string, string>(
  readVitestProjects(REPO_ROOT)
    .filter(({ configPath }) =>
      /\bbenchmark:\s*\{/.test(readFileSync(join(REPO_ROOT, configPath), 'utf-8')),
    )
    .map(({ configPath, name }) => [`${name} (bench)`, `${dirname(configPath)}/`] as const),
)

const benchFiles = trackedFiles(REPO_ROOT, '*.bench.ts')

/** Every `--project` value in a command, quoted or bare. */
function projectFilters(command: string): string[] {
  return [...command.matchAll(/(?:--project|-p)[ =](?:"([^"]+)"|'([^']+)'|(\S+))/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  )
}

/** Every `--reporter` value in a command. */
function reporters(command: string): string[] {
  return [...command.matchAll(/--reporter[ =](\S+)/g)].map((m) => m[1] ?? '')
}

/** The bench projects `command` selects; `pnpm bench` is whatever the root script selects. */
function selectedProjects(command: string): string[] {
  if (command.trim() === 'pnpm bench') return projectFilters(benchScript)
  return projectFilters(command)
}

describe('benchmark invocations print their numbers and reach their files', () => {
  it('reads the real benchmark projects and files', () => {
    expect(benchProjects.has('canvas-render-node (bench)')).toBe(true)
    expect(benchProjects.size).toBeGreaterThanOrEqual(2)
    expect(benchFiles.length).toBeGreaterThanOrEqual(4)
  })

  it('reads a filter and a reporter in each spelling a script uses', () => {
    expect(projectFilters('vitest bench --project "a (bench)" -p b --project=c')).toEqual([
      'a (bench)',
      'b',
      'c',
    ])
    expect(reporters('vitest bench --reporter=default --reporter json')).toEqual([
      'default',
      'json',
    ])
  })

  it('the root bench script names a reporter that renders the table', () => {
    expect(
      reporters(benchScript).some((name) => TABLE_REPORTERS.has(name)),
      `${benchScript} — without one, an agent session gets the minimal reporter and no table`,
    ).toBe(true)
  })

  it('the root bench script selects every project that declares benchmarks, by its bench name', () => {
    expect(projectFilters(benchScript).sort()).toEqual([...benchProjects.keys()].sort())
  })

  it('every bench file says how to run it, and that command reaches it', () => {
    const wrong = benchFiles.flatMap((file) => {
      const command = readFileSync(join(REPO_ROOT, file), 'utf-8').match(/Run with `([^`]+)`/)?.[1]
      if (command === undefined) return [`${file}: no "Run with \`<command>\`" line`]
      const reaches = selectedProjects(command).some((project) =>
        file.startsWith(benchProjects.get(project) ?? '\0'),
      )
      return reaches ? [] : [`${file}: \`${command}\` selects no bench project holding it`]
    })
    expect(wrong).toEqual([])
  })
})
