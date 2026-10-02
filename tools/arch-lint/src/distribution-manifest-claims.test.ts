/**
 * What the distribution manifests promise must be something the product does.
 *
 * `server.json` is the MCP registry listing, `.codex-plugin/plugin.json` and
 * `gemini-extension.json` are the first thing a Codex or Gemini user reads
 * and what they offer as starter prompts. Those are prose nothing else
 * reads, and they went stale in one direction: they kept advertising what
 * the product no longer (or never) did. Two claims in particular:
 *
 * - **A PNG export.** No tool returns PNG; the only rendered export an agent
 *   can ask for is SVG (`docs/reference/export-formats.md`), so a starter
 *   prompt asking for PNG cannot be fulfilled.
 * - **A page the daemon serves.** The daemon listens on an owner-only
 *   socket and serves no page of its own (ADR-0050 decision 3); the hosted
 *   app reaches it through the browser extension. A listing that says a
 *   canvas is "served by a local daemon on 127.0.0.1" describes a surface
 *   that is gone.
 *
 * `codex-plugin-spec.test.ts` holds the SHAPE of the Codex manifest and
 * deliberately asserts `expect.any(String)` for the text, so this holds the
 * words.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registeredTools } from './registered-tools.js'
import { REPO_ROOT } from './scan-roots.js'

const MANIFESTS = ['.codex-plugin/plugin.json', 'gemini-extension.json', 'server.json'] as const

const RETIRED_CLAIMS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /PNG/, why: 'no tool returns PNG; SVG is the only rendered export' },
  { pattern: /127\.0\.0\.1/, why: 'the daemon listens on an owner-only socket, not a port' },
  { pattern: /served by a local daemon/i, why: 'the daemon serves no page of its own' },
  { pattern: /in your browser/i, why: 'the hosted app reaches the daemon through the extension' },
  { pattern: /patch nodes/i, why: 'no patch tool exists; edits are one wb_canvas_edit batch' },
  { pattern: /create canvases/i, why: 'a workspace holds documents; a canvas is the surface' },
]

/** Every string a JSON document holds, with where it sits. */
function stringsOf(value: unknown, path = ''): { path: string; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, held]) => stringsOf(held, `${path}/${key}`))
}

const manifests = MANIFESTS.map((file) => ({
  file,
  strings: stringsOf(JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8'))),
}))

/** Tool-shaped names a prompt mentions that no server registers. */
function unregisteredToolsIn(prompt: string, registered: readonly string[]): string[] {
  const mentioned = prompt.match(/\b(?:wb_[a-z_]+|canvas_view)\b/g) ?? []
  return mentioned.filter((name) => !registered.includes(name))
}

describe('distribution manifests advertise only what the product does', () => {
  it('reads real text from all three manifests', () => {
    for (const { file, strings } of manifests) {
      expect(
        strings.some(({ text }) => text.length > 40),
        file,
      ).toBe(true)
    }
  })

  it.each(RETIRED_CLAIMS)('claims nothing matching $pattern ($why)', ({ pattern }) => {
    const offending = manifests.flatMap(({ file, strings }) =>
      strings.filter(({ text }) => pattern.test(text)).map(({ path }) => `${file}${path}`),
    )
    expect(offending).toEqual([])
  })

  it('only names, in a starter prompt, a tool the server registers', () => {
    const registered = registeredTools()
    expect(registered.length).toBeGreaterThan(10)
    const prompts = manifests
      .flatMap(({ strings }) => strings)
      .filter(({ path }) => path.startsWith('/interface/defaultPrompt'))
    expect(prompts.length).toBeGreaterThan(1)
    expect(prompts.flatMap(({ text }) => unregisteredToolsIn(text, registered))).toEqual([])
  })

  // The registry listing is read by people choosing whether to install, and
  // it is the one place a stale tool list is read as a promise.
  it('names, in every manifest, only tools the server registers', () => {
    const registered = registeredTools()
    const named = manifests.flatMap(({ file, strings }) =>
      strings.flatMap(({ text }) =>
        unregisteredToolsIn(text, registered).map((name) => `${file}: ${name}`),
      ),
    )
    expect(named).toEqual([])
  })

  it('lets the registry listing say what the tools are for, by name', () => {
    const description = manifests
      .find(({ file }) => file === 'server.json')
      ?.strings.find(({ path }) => path === '/description')?.text
    const registered = registeredTools()
    const named = registered.filter((tool) => description?.includes(tool))
    expect(named.length).toBeGreaterThanOrEqual(3)
  })

  // The registry refuses a package whose manifest does not name the listing
  // that claims it, so the two names are one fact written twice.
  it('claims the registry name server.json lists under, as the package says it', () => {
    const listing = JSON.parse(readFileSync(join(REPO_ROOT, 'server.json'), 'utf-8')) as {
      name: string
    }
    const published = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/mcp-server/package.json'), 'utf-8'),
    ) as { mcpName?: string }
    expect(published.mcpName).toBe(listing.name)
  })

  it('recognises a tool name that is not registered, so a clean answer is not a blind one', () => {
    expect(unregisteredToolsIn('Call wb_export_png on it', ['wb_scene_render'])).toEqual([
      'wb_export_png',
    ])
    expect(unregisteredToolsIn('Call wb_scene_render', ['wb_scene_render'])).toEqual([])
  })
})
