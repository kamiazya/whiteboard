// Regression test that ensures UI_LINKED_TOOLS (mcp-smoke-coverage.ts) stays
// in sync with the actual `_meta.ui.resourceUri` declarations in
// tool-registration.ts, and that the security-sensitive exclusions
// (canvas_open, export_canvas) are never accidentally linked.
//
// Verification strategy mirrors tool-annotations.test.ts: read the
// registration source directly rather than instantiating a real McpServer,
// so this test does not depend on daemon/transport wiring.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS, UI_LINKED_TOOLS } from './mcp-smoke-coverage.js'
import { RESOURCE_MIME_TYPE } from './mcp-apps.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const registrationSrc = readFileSync(resolve(__dirname, 'tool-registration.ts'), 'utf-8')

// Splits tool-registration.ts's `tools: RegisteredTool[]` array into one
// chunk per defineTool({...}) entry so each entry's _meta can be checked
// independently of the others.
function splitDefineToolEntries(src: string): string[] {
  const marker = '\n    defineTool({'
  return src
    .split(marker)
    .slice(1)
    .map((chunk) => marker.slice(1) + chunk)
}

function toolNameOf(entry: string): string | null {
  const m = entry.match(/name:\s*([a-zA-Z0-9_]+)\.name,/)
  return m ? m[1] : null
}

// Verifies a defineTool entry's `visibility` field, when present, is an
// inline array literal that includes "app" — anything else (omitted,
// literal-inclusive) is fine, but a non-literal reference (e.g. a shared
// `visibility: MODEL_ONLY_VISIBILITY` constant) can't be checked textually,
// so it must fail loudly rather than let the array-literal regex silently
// find no match and pass vacuously.
function assertVisibilityAllowsApp(entry: string): void {
  const arrayMatch = entry.match(/visibility:\s*\[([^\]]*)\]/)
  if (arrayMatch) {
    expect(arrayMatch[1]).toMatch(/["']app["']/)
    return
  }
  const identifierMatch = entry.match(/visibility:\s*([A-Za-z_$][\w$]*)/)
  if (identifierMatch) {
    throw new Error(
      `visibility uses a non-literal reference (${identifierMatch[1]}) this guard cannot verify textually; ` +
        'inline the array literal, or extend this check, so "app" inclusion stays provable',
    )
  }
  // visibility omitted entirely defaults to ["model", "app"] (see comment
  // on the caller) — nothing further to assert.
}

describe('MCP Apps UI-linked tools coverage', () => {
  it('UI_LINKED_TOOLS is a subset of ALL_REGISTERED_TOOLS', () => {
    for (const name of UI_LINKED_TOOLS) {
      expect(ALL_REGISTERED_TOOLS as readonly string[]).toContain(name)
    }
  })

  it('every entry with `_meta: { ui:` in tool-registration.ts references the registered resource URI constant', () => {
    // tool-registration.ts imports CANVAS_VIEW_RESOURCE_URI from mcp-apps.js
    // rather than inlining the literal, so this checks the source uses that
    // identifier — and mcp-apps.test.ts separately locks the constant's
    // value to the URI actually passed to server.registerResource().
    expect(registrationSrc).toMatch(
      /import\s*\{\s*CANVAS_VIEW_RESOURCE_URI\s*\}\s*from\s*'\.\/mcp-apps\.js'/,
    )
    const entries = splitDefineToolEntries(registrationSrc)
    const uiLinkedEntries = entries.filter((e) => /_meta:\s*\{\s*ui:/.test(e))
    expect(uiLinkedEntries.length).toBeGreaterThan(0)
    for (const entry of uiLinkedEntries) {
      expect(entry).toContain('CANVAS_VIEW_RESOURCE_URI')
    }
    // Sanity: RESOURCE_MIME_TYPE is what the resource is served with,
    // confirming this test imports from the same authoritative module.
    expect(RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app')
  })

  it('canvas_open and export_canvas are explicitly NOT UI-linked', () => {
    const entries = splitDefineToolEntries(registrationSrc)
    for (const forbidden of ['openTool', 'exportCanvas']) {
      const entry = entries.find((e) => new RegExp(`name:\\s*${forbidden}\\.name,`).test(e))
      expect(entry, `expected a defineTool entry for ${forbidden}`).toBeDefined()
      expect(entry).not.toMatch(/_meta:\s*\{\s*ui:/)
    }
  })

  it('canvas_view is the only tool with a defineTool entry carrying `_meta.ui`', () => {
    const entries = splitDefineToolEntries(registrationSrc)
    const linkedNames = entries.filter((e) => /_meta:\s*\{\s*ui:/.test(e)).map((e) => toolNameOf(e))
    expect(linkedNames).toEqual(['viewTool'])
  })

  it('canvas_view leaves `visibility` unset or app-inclusive, so the MCP Apps host can call it back for Refresh', () => {
    // ext-apps' McpUiToolMeta.visibility defaults to ["model", "app"] when
    // omitted (spec.types.d.ts), which already permits an app-initiated
    // callServerTool — this pins that canvas_view never narrows it to
    // ["model"] only, which would silently break the widget's Refresh
    // button without touching any test that calls canvas_view as the model.
    const entries = splitDefineToolEntries(registrationSrc)
    const viewEntry = entries.find((e) => toolNameOf(e) === 'viewTool')
    expect(viewEntry).toBeDefined()
    assertVisibilityAllowsApp(viewEntry ?? '')
  })

  it('flags a non-literal `visibility` reference instead of passing vacuously', () => {
    // Guards the guard: a future edit to `visibility: MODEL_ONLY_VISIBILITY`
    // (a non-literal reference) must fail this check, not silently pass it
    // the way a literal-array-only regex would.
    expect(() => assertVisibilityAllowsApp('visibility: MODEL_ONLY_VISIBILITY,')).toThrow()
  })
})
