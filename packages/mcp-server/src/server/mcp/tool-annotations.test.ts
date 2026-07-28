// Regression test that ensures every registerTool call has a TOOL_PROFILES
// annotations entry. This catches missing annotations when new tools are added.
//
// Verification strategy: read the source files that declare the profiles and
// the registrations independently, then cross-check their counts.
//
// TOOL_PROFILES lives in tool-profiles.ts.
// Tool registrations live in tool-registration.ts as `defineTool({...})`
// entries in a data-driven array (each one calls registerToolWithAnnotations
// through the defineTool identity helper).

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TOOL_PROFILES } from './tool-profiles.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function readSource(name: string): string {
  const p = resolve(__dirname, name)
  if (!existsSync(p)) throw new Error(`Expected source file not found: ${name}`)
  return readFileSync(p, 'utf-8')
}

const profilesSrc = readSource('tool-profiles.ts')
const registrationSrc = readSource('tool-registration.ts')
const opencanvasSrc = readSource('opencanvas-tools.ts')

function extractProfileKeys(src: string): string[] {
  const re = /^\s{2}([a-z_]+):\s*\{\s*profile:/gm
  const out: string[] = []
  let m
  while ((m = re.exec(src)) !== null) {
    out.push(m[1])
  }
  return out
}

function countRegisterCalls(src: string): number {
  return (src.match(/^\s*defineTool\(\s*\{/gm) ?? []).length
}

function countOpenCanvasTools(src: string): number {
  const zodObject = (src.match(/registerZodObjectTool\(server,/g) ?? []).length
  const direct = (src.match(/registerToolWithAnnotations\(\s*\n\s*server,/g) ?? []).length
  return zodObject + direct
}

describe('MCP tool annotations coverage', () => {
  it('matches TOOL_PROFILES entry count to total tool registration count', () => {
    const profileKeys = extractProfileKeys(profilesSrc)
    const legacyCount = countRegisterCalls(registrationSrc)
    const openCanvasCount = countOpenCanvasTools(opencanvasSrc)
    expect(profileKeys.length).toBe(legacyCount + openCanvasCount)
    expect(profileKeys.length).toBeGreaterThan(20)
  })

  it('does not duplicate TOOL_PROFILES keys', () => {
    const keys = extractProfileKeys(profilesSrc)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every TOOL_PROFILES entry a title', () => {
    const re = /^\s{2}[a-z_]+:\s*\{\s*profile:[^}]+\},/gm
    const entries = profilesSrc.match(re) ?? []
    for (const entry of entries) {
      expect(entry).toMatch(/title:/)
    }
  })

  it('never annotates create_pairing_link as read-only, since its response discloses the live daemon bearer token', () => {
    expect(TOOL_PROFILES.create_pairing_link.profile.readOnlyHint).not.toBe(true)
  })
})
