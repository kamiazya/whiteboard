/**
 * A tool-shaped name in prose is a claim that a tool by that name exists.
 *
 * `skills-tool-surface.test.ts` holds the model-facing skills to the
 * registered list; the user and contributor docs and the README were held to
 * nothing, so a how-to kept telling a reader that `wb_document_set` and
 * `wb_document_create` refuse a malformed tag long after both had become ops
 * of `wb_workspace_edit`. Every `wb_*` / `canvas_*` token in that prose is
 * judged here against the same list the live server's `tools/list` is held to.
 *
 * ADRs are history and name the surface as it stood when decided.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registeredTools } from './registered-tools.js'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

const SURFACE = (path: string): boolean =>
  path.endsWith('.md') &&
  ((path.startsWith('docs/') && !path.startsWith('docs/contributing/adr/')) ||
    path.startsWith('skills/') ||
    path === 'README.md')

const TOOL_SHAPED = /\b(?:wb_[a-z_]+|canvas_[a-z_]+)\b/g

/**
 * A retired name that prose keeps because its subject is the history of a
 * defect, never the tool a reader should call. Keyed `file#token`; rewording
 * the sentence out of the name retires the entry.
 */
const HISTORICAL: Readonly<Record<string, string>> = {
  'docs/contributing/architecture/canvas-render-decisions.md#wb_scene_digest':
    'records what the fallback text measurer got wrong at the time the digest tool still answered `truncated`',
}

const registered = new Set(registeredTools())
const surface = trackedFiles(REPO_ROOT).filter(SURFACE)

const found = surface.flatMap((file) =>
  [...new Set(readFileSync(join(REPO_ROOT, file), 'utf-8').match(TOOL_SHAPED) ?? [])]
    .filter((token) => !registered.has(token))
    .map((token) => `${file}#${token}`),
)

describe('prose names only tools the server registers', () => {
  it('scans a real prose surface against a real registry', () => {
    expect(registered.size).toBeGreaterThan(10)
    expect(surface.length).toBeGreaterThan(40)
    expect(surface).toEqual(
      expect.arrayContaining([
        'README.md',
        'docs/how-to/organize-with-tags.md',
        'docs/explanation/architecture.md',
        'skills/drawing-visuals/SKILL.md',
      ]),
    )
    expect(surface.some((file) => file.startsWith('docs/contributing/adr/'))).toBe(false)
  })

  it('finds no unregistered tool name outside the recorded history', () => {
    expect(found.filter((entry) => !(entry in HISTORICAL))).toEqual([])
  })

  it('holds no exemption for prose that no longer names the tool', () => {
    expect(Object.keys(HISTORICAL).filter((entry) => !found.includes(entry))).toEqual([])
  })

  it.each([
    ['a how-to sentence', '`wb_document_set` and `wb_document_create` refuse'],
    ['an app tool', 'the `canvas_open` tool'],
  ])('matches the shape it exists for: %s', (_where, phrase) => {
    expect(phrase.match(TOOL_SHAPED)?.length ?? 0).toBeGreaterThan(0)
  })
})
