// The URL builder's action union is a promise that a route answers it. Types
// cannot see the daemon's registrations, so a deleted route leaves its action
// compiling and every caller of it getting a 404.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCUMENT_API_ACTIONS } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { describe, expect, it } from 'vitest'

const ROUTES_DIR = join(import.meta.dirname, 'routes')

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesUnder(full)
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [full] : []
  })
}

/** The action every `onDocumentAction(app, '<method>', '<action>', …)` registration names. */
function registeredActionsIn(source: string): string[] {
  return [...source.matchAll(/onDocumentAction\(\s*app,\s*'\w+',\s*'([\w-]+)'/g)].map(
    (m) => m[1] as string,
  )
}

describe('documentByIdApiUrl actions', () => {
  // Read off the registration calls, so no app is needed.
  const registeredActions = new Set(
    sourcesUnder(ROUTES_DIR).flatMap((file) => registeredActionsIn(readFileSync(file, 'utf8'))),
  )

  it('finds the registered document actions at all', () => {
    expect(registeredActions.size).toBeGreaterThan(3)
  })

  it.each(DOCUMENT_API_ACTIONS)('has a registered route behind %s', (action) => {
    expect(registeredActions.has(action)).toBe(true)
  })

  it('reads a registration as the routes spell one', () => {
    expect(registeredActionsIn("onDocumentAction(app, 'get', 'snapshot', handler)")).toEqual([
      'snapshot',
    ])
    expect(registeredActionsIn("onDocumentAction(\n  app,\n  'post',\n  'export-svg',")).toEqual([
      'export-svg',
    ])
  })
})
