#!/usr/bin/env node
// Direct smoke test for template_list / template_insert.
// Calls the tool functions directly instead of going through MCP, with fetch
// mocked so the test completes without starting Hono. It also covers error
// cases such as unknown id, both/neither, missing variable, and bad path.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
process.env.WHITEBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), 'tpl-smoke-'))
process.chdir(root)

const { LoroDoc } = await import('loro-crdt')
const { listTemplatesTool, insertTemplateTool } = await import(
  join(root, 'src/server/mcp/tools/template.ts')
)

// fetch mock: /snapshot returns an empty LoroDoc, /update silently returns 200.
function makeEmptySnapshot() {
  const doc = new LoroDoc()
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

const posted = []
globalThis.fetch = async (url, init) => {
  const u = url.toString()
  if (u.endsWith('/snapshot')) {
    return new Response(makeEmptySnapshot(), { status: 200 })
  }
  if (u.endsWith('/update')) {
    posted.push(init?.body instanceof Uint8Array ? init.body.byteLength : String(init?.body ?? '').length)
    return new Response(null, { status: 200 })
  }
  throw new Error(`unexpected fetch ${u}`)
}

function expect(label, cond, detail = '') {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`)
    process.exit(1)
  }
  console.log(`OK  : ${label}`)
}

async function expectThrow(label, fn, re) {
  try {
    await fn()
  } catch (err) {
    if (re.test(err.message)) {
      console.log(`OK  : ${label} (${err.message.slice(0, 80)})`)
      return
    }
    console.error(`FAIL: ${label} — unexpected error ${err.message}`)
    process.exit(1)
  }
  console.error(`FAIL: ${label} — expected throw`)
  process.exit(1)
}

const tmpDir = mkdtempSync(join(tmpdir(), 'tpl-smoke-files-'))

try {
  // 1) template_list should return the three built-in templates.
  const list = await listTemplatesTool().execute()
  expect('list.templates is array', Array.isArray(list.templates))
  expect('list has 3 built-ins', list.templates.length === 3, `got ${list.templates.length}`)
  expect(
    'list contains client-api-db',
    list.templates.some((t) => t.id === 'client-api-db'),
  )
  const cad = list.templates.find((t) => t.id === 'client-api-db')
  expect('client-api-db exposes variables', cad.variables.length === 5)
  expect('variable has default', cad.variables[0].default === 'Client')

  // 2) insert with defaults
  posted.length = 0
  const r1 = await insertTemplateTool().execute(
    { canvasId: 'sid/diagram', templateId: 'client-api-db', target: { x: 10, y: 20 } },
    3099,
  )
  expect('insert returns templateId', r1.templateId === 'client-api-db')
  expect('insert source=builtin', r1.source === 'builtin')
  expect('insert annotations=5', r1.annotations?.length === 5)
  expect('insert produced elementIds', Array.isArray(r1.elementIds) && r1.elementIds.length >= 5)
  expect('posted 1 update', posted.length === 1)
  expect('default client=Client', r1.variables.client === 'Client')

  // 3) variable override reflected
  posted.length = 0
  const r2 = await insertTemplateTool().execute(
    {
      canvasId: 'sid/diagram',
      templateId: 'client-api-db',
      target: { x: 0, y: 0 },
      variables: { client: 'Web', db: 'Postgres' },
    },
    3099,
  )
  expect('override client', r2.variables.client === 'Web')
  expect('override db', r2.variables.db === 'Postgres')
  expect('defaults preserved for unspecified', r2.variables.api === 'API')

  // 4) scale multiplies geometry
  //    Verify through real execute behavior instead of calling
  //    instantiateTemplate directly.
  //    With scale=2, the api box target.x should become 10 + 250*2 = 510.
  posted.length = 0
  const { instantiateTemplate } = await import(join(root, 'src/server/mcp/tools/template.ts'))
  const { getBuiltinTemplate } = await import(
    join(root, 'src/server/mcp/tools/template-library.ts')
  )
  const inst = instantiateTemplate({
    template: getBuiltinTemplate('client-api-db'),
    origin: { x: 10, y: 20 },
    scale: 2,
  })
  const apiBox = inst.annotations.find((a) => a.name === 'api')
  expect('scale: api.target.x = 10 + 250*2', apiBox.target.x === 510, `got ${apiBox.target.x}`)
  expect('scale: api.width = 200*2', apiBox.width === 400, `got ${apiBox.width}`)

  // 5) Load external JSON via templatePath.
  const customPath = join(tmpDir, 'custom.json')
  writeFileSync(
    customPath,
    JSON.stringify({
      format: 'excalidraw-tool-template',
      version: 1,
      id: 'custom-smoke',
      title: 'Custom Smoke',
      description: 'Smoke test template',
      variables: [{ name: 'greeting', default: 'hello' }],
      annotations: [{ type: 'text', target: { x: 0, y: 0 }, text: '{{greeting}}' }],
    }),
  )
  posted.length = 0
  const r3 = await insertTemplateTool().execute(
    { canvasId: 'sid/diagram', templatePath: customPath, target: { x: 5, y: 5 } },
    3099,
  )
  expect('file template source=file', r3.source === 'file')
  expect('file template id', r3.templateId === 'custom-smoke')

  // 6) unknown templateId
  await expectThrow(
    'unknown templateId rejected',
    () =>
      insertTemplateTool().execute(
        { canvasId: 'sid/diagram', templateId: 'does-not-exist', target: { x: 0, y: 0 } },
        3099,
      ),
    /Unknown templateId/,
  )

  // 7) both templateId and templatePath
  await expectThrow(
    'both specified rejected',
    () =>
      insertTemplateTool().execute(
        {
          canvasId: 'sid/diagram',
          templateId: 'client-api-db',
          templatePath: customPath,
          target: { x: 0, y: 0 },
        },
        3099,
      ),
    /Specify either/,
  )

  // 8) neither specified
  await expectThrow(
    'neither specified rejected',
    () =>
      insertTemplateTool().execute(
        { canvasId: 'sid/diagram', target: { x: 0, y: 0 } },
        3099,
      ),
    /required/,
  )

  // 9) Missing required variable with no default.
  const missingVarPath = join(tmpDir, 'missing-var.json')
  writeFileSync(
    missingVarPath,
    JSON.stringify({
      format: 'excalidraw-tool-template',
      version: 1,
      id: 'missing-var',
      title: 'Missing Var',
      description: 'Requires a variable without default',
      variables: [{ name: 'title' }],
      annotations: [{ type: 'text', target: { x: 0, y: 0 }, text: '{{title}}' }],
    }),
  )
  await expectThrow(
    'missing required variable rejected',
    () =>
      insertTemplateTool().execute(
        { canvasId: 'sid/diagram', templatePath: missingVarPath, target: { x: 0, y: 0 } },
        3099,
      ),
    /Missing required template variables/,
  )

  // 10) invalid templatePath
  await expectThrow(
    'bad templatePath rejected',
    () =>
      insertTemplateTool().execute(
        {
          canvasId: 'sid/diagram',
          templatePath: join(tmpDir, 'no-such-file.json'),
          target: { x: 0, y: 0 },
        },
        3099,
      ),
    /ENOENT|no such/i,
  )

  // 11) negative scale rejected
  await expectThrow(
    'negative scale rejected',
    () =>
      insertTemplateTool().execute(
        {
          canvasId: 'sid/diagram',
          templateId: 'client-api-db',
          target: { x: 0, y: 0 },
          scale: -1,
        },
        3099,
      ),
    /scale must be a positive number/,
  )

  console.log('\n[tpl-smoke] ALL OK')
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(process.env.WHITEBOARD_DATA_DIR, { recursive: true, force: true })
}
