/**
 * "Which content type does this extension get" is answered in ONE place for
 * the scripts that serve a built app, and this scan is the executable half.
 *
 * Five scripts each carried their own table and their own idea of the request
 * path: one lacked `.wasm`, `.json` and `.woff2`, another keyed on the bare
 * extension and a third on the dotted one, and three joined the decoded path
 * onto the root without checking that it stayed inside. They agreed only
 * while nothing exercised the difference. `tools/checks/src/serve-dist.mjs` is
 * the home; a script that needs a variation passes `headers`, `onRequest` or
 * `transform` rather than writing a server.
 *
 * The scan reads each plain-Node script with its comments removed and looks
 * for the spelling a table takes: three or more distinct web content types as
 * string literals in one file, or, in a script that starts an HTTP server,
 * three or more content types of any kind — a table a type or two away from
 * the web list (`application/json`, `image/png`, `font/woff`) is still a table.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, scriptFiles } from './scan-roots.js'
import { stripComments } from './strip-comments.js'

const HOME = 'tools/checks/src/serve-dist.mjs'

const WEB_TYPE =
  /['"`](?:text\/(?:html|css|javascript)|application\/(?:javascript|wasm)|image\/svg\+xml|font\/(?:woff2|ttf))\b/g

/** Any `type/subtype` under a top-level media type, as a literal. */
const ANY_TYPE = /['"`](?:text|application|image|font|audio|video)\/[\w.+-]+/g

/** A script that answers HTTP itself, where a content-type table means one more server. */
const SERVES_HTTP = /\bcreateServer\b|['"]node:https?['"]|\bfrom\s+['"]https?['"]/

/** How many distinct web content types a source spells as literals. */
function webTypesIn(source: string): number {
  return new Set(stripComments(source).match(WEB_TYPE)).size
}

/** Whether a source spells a content-type table: see the header for the two ways. */
function spellsTable(source: string): boolean {
  const code = stripComments(source)
  if (new Set(code.match(WEB_TYPE)).size >= 3) return true
  return SERVES_HTTP.test(code) && new Set(code.match(ANY_TYPE)).size >= 3
}

const scripts = scriptFiles()

const MIME_TABLE_OF_A_SMOKE = `
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
}`

describe('a built app is served by one server', () => {
  it('reaches the scripts and recognises a table when it sees one', () => {
    expect(scripts.length).toBeGreaterThan(40)
    expect(scripts).toContain(HOME)
    expect(spellsTable(MIME_TABLE_OF_A_SMOKE)).toBe(true)
    // The subject is present: the home itself spells the table.
    expect(spellsTable(readFileSync(join(REPO_ROOT, HOME), 'utf8'))).toBe(true)
  })

  it('does not mistake one type, or a comment, for a table', () => {
    expect(webTypesIn(`const type = 'text/html'`)).toBe(1)
    expect(webTypesIn(`// text/html text/css image/svg+xml application/wasm`)).toBe(0)
    expect(spellsTable(`// text/html text/css image/svg+xml application/wasm`)).toBe(false)
  })

  it('recognises a table of types off the web list in a script that serves', () => {
    const offList = `import { createServer } from 'node:http'
const TYPES = {
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
  woff: 'font/woff',
}`
    expect(webTypesIn(offList)).toBe(2)
    expect(spellsTable(offList)).toBe(true)
    // A client that sends and accepts a few types is not a server's table.
    const client = `await fetch(url, { headers: { accept: 'application/json', 'content-type': 'application/octet-stream' } })
const png = 'image/png'`
    expect(spellsTable(client)).toBe(false)
  })

  it('no script writes its own content-type table', () => {
    const hits = scripts
      .filter((rel) => rel !== HOME)
      .filter((rel) => spellsTable(readFileSync(join(REPO_ROOT, rel), 'utf8')))
    expect(
      hits,
      `import \`serveDist\` from ${HOME}: a second table drifts, and the copies each missed a type the build emits`,
    ).toEqual([])
  })
})
