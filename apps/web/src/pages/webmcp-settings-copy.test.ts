/**
 * The WebMCP toggle's description is the user's sole privacy statement
 * about what an in-page agent can read, so it must claim exactly what the
 * one registered tool returns — getAppContextResultSchema is
 * {provider: {mode}, canvas: identity | null}, nothing else. The first
 * version promised a "selection count" and "viewport" the tool never
 * returned: overstating the exposed surface in the very copy someone reads
 * to decide whether to flip the switch.
 */
import { describe, expect, it } from 'vitest'
import { getAppContextResultSchema } from '../lib/commands/types.js'

const sources = import.meta.glob('./SettingsPage.tsx', { query: '?raw', import: 'default' })

async function settingsSource(): Promise<string> {
  const loader = sources['./SettingsPage.tsx']
  expect(loader, 'SettingsPage source loader').toBeDefined()
  return (await loader?.()) as string
}

describe('WebMCP settings copy matches the tool contract', () => {
  it('claims no field the schema does not carry', async () => {
    const source = await settingsSource()
    const descStart = source.indexOf('webMcpDescId}')
    expect(descStart).toBeGreaterThan(-1)
    const description = source.slice(descStart, source.indexOf('</p>', descStart))
    // The two claims the copy used to overstate. Naming them as NON-exposed
    // ("Never exposes ... selection, viewport") is fine and expected; what
    // must not come back is an affirmative claim, which always read as
    // "read a ... (..., selection count, viewport)".
    expect(description).not.toMatch(/read[^.]*selection/i)
    expect(description).not.toMatch(/read[^.]*viewport/i)
  })

  it('the schema still carries only provider mode and canvas identity — the copy is written to THIS shape', () => {
    // If the tool ever starts returning more (selection, viewport), this
    // fails first and the copy is re-reviewed together with the schema.
    const keys = Object.keys(getAppContextResultSchema.shape)
    expect(keys.sort()).toEqual(['canvas', 'provider'])
  })
})
