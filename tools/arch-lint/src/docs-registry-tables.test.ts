/**
 * Two reference tables hand-copy a registry, and a hand copy drifts in
 * silence: the architecture page's "MCP tool surface" listed thirteen tools
 * while sixteen were registered (`wb_thread_edit` was named nowhere under
 * `docs/`), and the keyboard-shortcut reference omitted two bindings the
 * editor handles. Each page is held against the registry it copies.
 *
 * - Tools: `ALL_REGISTERED_TOOLS`, itself compared to a live server's
 *   `tools/list` by the smoke checkpoint.
 * - Shortcuts: `EDITOR_SHORTCUTS`' `display` strings. The undo/redo chords
 *   are NOT in that catalog (`handleUndoRedoKey` in `useDocumentSync.ts`
 *   answers them), so they are asserted from where they live: every key that
 *   handler tests must have a documented chord.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registeredTools } from './registered-tools.js'
import { REPO_ROOT } from './scan-roots.js'

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8')

/** The first cell of every table row under a heading (up to the next one), or in the whole page. */
function firstCells(markdown: string, heading: string | null): string[] {
  const lines = markdown.split('\n')
  const from = heading === null ? -1 : lines.findIndex((line) => line.trim() === heading)
  if (heading !== null && from < 0) return []
  const rest = lines.slice(from + 1)
  const next = heading === null ? -1 : rest.findIndex((line) => /^#{1,6} /.test(line))
  return (next < 0 ? rest : rest.slice(0, next))
    .filter((line) => line.startsWith('|') && !/^\|[\s:-]+\|/.test(line))
    .map((line) => line.split('|')[1]?.trim() ?? '')
    .filter((cell) => cell !== '' && cell !== 'Tool' && cell !== 'Shortcut')
}

const backticked = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string)

describe('the architecture page lists the tools the server registers', () => {
  const page = read('docs/explanation/architecture.md')
  const listed = firstCells(page, '## MCP tool surface').flatMap(backticked)
  const registered = registeredTools()

  it('reads a real table and a real registry', () => {
    expect(registered.length).toBeGreaterThan(10)
    expect(listed.length).toBeGreaterThan(10)
  })

  it.each(registered)('has a row for %s', (tool) => {
    expect(listed).toContain(tool)
  })

  it('names no tool the server does not register', () => {
    expect(listed.filter((name) => !registered.includes(name))).toEqual([])
  })
})

/** `Cmd/Ctrl + A` and `Cmd+A` are one chord; case, spacing and backticks are not meaning. */
const chord = (text: string): string =>
  text
    .replace(/`/g, '')
    .replace(/Cmd\/Ctrl/g, 'Cmd')
    .replace(/\s+/g, '')
    .toLowerCase()

/** Every chord a first cell documents; `/` separates alternatives (`Delete` / `Backspace`). */
const documented = (cells: readonly string[]): string[] =>
  cells.flatMap((cell) => chord(cell).split('/'))

describe('the shortcuts reference documents every binding the editor declares', () => {
  const cells = firstCells(read('docs/reference/keyboard-shortcuts.md'), null)
  const documentedChords = documented(cells)
  const catalog = read('apps/web/src/components/spatial-editor/shortcuts.ts')
  const displays = [...catalog.matchAll(/^\s+display:\s*'((?:[^'\\]|\\.)*)',$/gm)].map(
    (match) => match[1] as string,
  )

  /** A `display` the reference words differently, with the reason it cannot be matched verbatim. */
  const PROSE_FOR: Readonly<Record<string, string>> = {
    Arrows: 'Arrow keys',
  }

  it('reads a real catalog and a real reference', () => {
    expect(displays.length).toBeGreaterThan(15)
    expect(documentedChords.length).toBeGreaterThan(20)
    expect(Object.keys(PROSE_FOR).every((display) => displays.includes(display))).toBe(true)
  })

  it.each(displays)('documents %s', (display) => {
    expect(documentedChords).toContain(chord(PROSE_FOR[display] ?? display))
  })

  it('documents every key the undo and redo handler tests', () => {
    const handler = /function handleUndoRedoKey[\s\S]*?\n}\n/.exec(
      read('apps/web/src/hooks/useDocumentSync.ts'),
    )?.[0]
    const keys = [...(handler ?? '').matchAll(/key === '([a-z])'/g)].map((m) => m[1] as string)
    expect(keys).toEqual(expect.arrayContaining(['z', 'y']))
    for (const key of keys) {
      expect(
        documentedChords.some((entry) => entry === `cmd+${key}` || entry === `cmd+shift+${key}`),
        `Cmd/Ctrl + ${key.toUpperCase()}`,
      ).toBe(true)
    }
  })
})
