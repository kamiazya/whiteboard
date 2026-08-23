import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/**
 * release-please's `type: json` updater does not edit a line — it parses the
 * whole file and re-serialises it, and its serialiser puts every array
 * element on its own line. Biome's formatter does the opposite: a short array
 * that fits the line width is collapsed onto one. So the two disagree about
 * any release-please target that contains a short array, and the release PR
 * arrives with `check` red on files nobody wrote.
 *
 * It hid for a long time because it depends on CONTENT, not configuration:
 * `server.json` is a target too and survives untouched, having no short
 * array to expand. The failure appeared when `keywords` and `args` arrays
 * were added to the plugin manifests, long after the config was written.
 *
 * The fix is to let release-please's shape stand — these files are edited by
 * a bot far more often than by a person — so biome's formatter is off for
 * exactly the targets and nothing else. Linting still applies.
 *
 * This test is what stops the exemption drifting from the target list: add a
 * file to `extra-files` without exempting it and the next release PR is red
 * again, for the same reason, months later.
 */
describe('release-please JSON targets are exempt from biome formatting', () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'release-please-config.json'), 'utf-8'))
  const biome = JSON.parse(readFileSync(join(REPO_ROOT, 'biome.json'), 'utf-8'))

  const targets: string[] = [
    ...new Set(
      Object.values(config.packages as Record<string, { 'extra-files'?: unknown[] }>)
        .flatMap((pkg) => pkg['extra-files'] ?? [])
        .filter((entry): entry is { type: string; path: string } => {
          const candidate = entry as { type?: unknown; path?: unknown }
          return candidate.type === 'json' && typeof candidate.path === 'string'
        })
        .map((entry) => entry.path),
    ),
  ]

  const exempted: string[] = (biome.overrides as { includes?: string[]; formatter?: unknown }[])
    .filter((override) => (override.formatter as { enabled?: boolean })?.enabled === false)
    .flatMap((override) => override.includes ?? [])

  it('finds the targets, so an empty comparison cannot pass vacuously', () => {
    expect(targets.length).toBeGreaterThan(3)
    expect(targets).toContain('server.json')
  })

  for (const target of targets) {
    it(`${target} is exempt`, () => {
      expect(exempted).toContain(target)
    })
  }
})
