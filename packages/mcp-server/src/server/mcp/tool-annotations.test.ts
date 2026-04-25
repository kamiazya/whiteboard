// Regression test that ensures every registerTool call has a TOOL_PROFILES
// annotations entry. This catches missing annotations when new tools are added.
//
// Verification strategy: read mcp/index.ts as text and compare
// 1. TOOL_PROFILES key count (`<name>: { profile:` pattern)
// 2. registerToolWithAnnotations call count

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8')

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
  return (src.match(/registerToolWithAnnotations\(\s*server\s*,/g) ?? []).length
}

describe('MCP tool annotations coverage', () => {
  it('matches TOOL_PROFILES entry count to registerToolWithAnnotations call count', () => {
    const profileKeys = extractProfileKeys(indexSource)
    const callCount = countRegisterCalls(indexSource)
    expect(profileKeys.length).toBe(callCount)
    expect(profileKeys.length).toBeGreaterThan(20)
  })

  it('does not duplicate TOOL_PROFILES keys', () => {
    const keys = extractProfileKeys(indexSource)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every TOOL_PROFILES entry a title', () => {
    const re = /^\s{2}[a-z_]+:\s*\{\s*profile:[^}]+\},/gm
    const entries = indexSource.match(re) ?? []
    for (const entry of entries) {
      expect(entry).toMatch(/title:/)
    }
  })
})
