import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import type { DaemonClient } from '../daemon-client.js'
import { instantiateTemplate, insertTemplateTool, listTemplatesTool } from './template.js'
import { getBuiltinTemplate } from './template-library.js'

function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) throw new Error(`${label}${detail ? ` ${detail}` : ''}`)
}

async function checkThrows(label: string, fn: () => Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof Error && re.test(err.message)) return
    throw new Error(
      `${label} — unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  throw new Error(`${label} — expected throw but none occurred`)
}

function makeEmptySnapshot(): Uint8Array {
  const doc = new LoroDoc()
  doc.commit()
  return doc.export({ mode: 'snapshot' }) as Uint8Array
}

/**
 * Runs all template tool smoke checks.
 *
 * Callers must set process.env.WHITEBOARD_DATA_DIR before calling.
 * This function manages its own fetch mock and temp file directory.
 */
export async function runTemplateSmokeChecks(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tpl-smoke-files-'))
  const savedFetch = globalThis.fetch as typeof globalThis.fetch | undefined

  try {
    const posted: number[] = []
    globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const u = url.toString()
      if (u.endsWith('/exists')) {
        return new Response(JSON.stringify({ exists: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.endsWith('/snapshot')) {
        return new Response(makeEmptySnapshot(), { status: 200 })
      }
      if (u.endsWith('/update')) {
        posted.push(
          init?.body instanceof Uint8Array ? init.body.byteLength : String(init?.body ?? '').length,
        )
        return new Response(null, { status: 200 })
      }
      throw new Error(`unexpected fetch ${u}`)
    }

    const fakeClient: DaemonClient = {
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      request: (path, init) => globalThis.fetch(`http://127.0.0.1:3099${path}`, init),
      touch: async () => {},
    }

    // 1) template_list: three built-in templates
    const list = await listTemplatesTool().execute()
    check('list.templates is array', Array.isArray(list.templates))
    check('list has 3 built-ins', list.templates.length === 3, `got ${list.templates.length}`)
    check(
      'list contains client-api-db',
      list.templates.some((t) => t.id === 'client-api-db'),
    )
    const cad = list.templates.find((t) => t.id === 'client-api-db')!
    check('client-api-db exposes variables', cad.variables.length === 5)
    check('variable has default', cad.variables[0].default === 'Client')

    // 2) insert with defaults
    posted.length = 0
    const r1 = await insertTemplateTool().execute(
      { canvasId: 'sid/diagram', templateId: 'client-api-db', target: { x: 10, y: 20 } },
      fakeClient,
    )
    check('insert returns templateId', r1.templateId === 'client-api-db')
    check('insert source=builtin', r1.source === 'builtin')
    check('insert annotations=5', (r1.annotations as unknown[])?.length === 5)
    check('insert produced elementIds', Array.isArray(r1.elementIds) && r1.elementIds.length >= 5)
    check('posted 1 update', posted.length === 1)
    check('default client=Client', r1.variables.client === 'Client')

    // 3) variable override reflected
    posted.length = 0
    const r2 = await insertTemplateTool().execute(
      {
        canvasId: 'sid/diagram',
        templateId: 'client-api-db',
        target: { x: 0, y: 0 },
        variables: { client: 'Web', db: 'Postgres' },
      },
      fakeClient,
    )
    check('override client', r2.variables.client === 'Web')
    check('override db', r2.variables.db === 'Postgres')
    check('defaults preserved for unspecified', r2.variables.api === 'API')

    // 4) scale multiplies geometry
    const inst = instantiateTemplate({
      template: getBuiltinTemplate('client-api-db')!,
      origin: { x: 10, y: 20 },
      scale: 2,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiBox = (inst.annotations as any[]).find((a) => a.name === 'api')
    check('scale: api.target.x = 10 + 250*2', apiBox.target.x === 510, `got ${apiBox.target.x}`)
    check('scale: api.width = 200*2', apiBox.width === 400, `got ${apiBox.width}`)

    // 5) external JSON via templatePath
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
      fakeClient,
    )
    check('file template source=file', r3.source === 'file')
    check('file template id', r3.templateId === 'custom-smoke')

    // 6) unknown templateId
    await checkThrows(
      'unknown templateId rejected',
      () =>
        insertTemplateTool().execute(
          { canvasId: 'sid/diagram', templateId: 'does-not-exist', target: { x: 0, y: 0 } },
          fakeClient,
        ),
      /Unknown templateId/,
    )

    // 7) both templateId and templatePath
    await checkThrows(
      'both specified rejected',
      () =>
        insertTemplateTool().execute(
          {
            canvasId: 'sid/diagram',
            templateId: 'client-api-db',
            templatePath: customPath,
            target: { x: 0, y: 0 },
          },
          fakeClient,
        ),
      /Specify either/,
    )

    // 8) neither specified
    await checkThrows(
      'neither specified rejected',
      () =>
        insertTemplateTool().execute(
          { canvasId: 'sid/diagram', target: { x: 0, y: 0 } },
          fakeClient,
        ),
      /required/,
    )

    // 9) missing required variable with no default
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
    await checkThrows(
      'missing required variable rejected',
      () =>
        insertTemplateTool().execute(
          { canvasId: 'sid/diagram', templatePath: missingVarPath, target: { x: 0, y: 0 } },
          fakeClient,
        ),
      /Missing required template variables/,
    )

    // 10) invalid templatePath
    await checkThrows(
      'bad templatePath rejected',
      () =>
        insertTemplateTool().execute(
          {
            canvasId: 'sid/diagram',
            templatePath: join(tmpDir, 'no-such-file.json'),
            target: { x: 0, y: 0 },
          },
          fakeClient,
        ),
      /ENOENT|no such/i,
    )

    // 11) negative scale rejected
    await checkThrows(
      'negative scale rejected',
      () =>
        insertTemplateTool().execute(
          {
            canvasId: 'sid/diagram',
            templateId: 'client-api-db',
            target: { x: 0, y: 0 },
            scale: -1,
          },
          fakeClient,
        ),
      /scale must be a positive number/,
    )
  } finally {
    if (savedFetch !== undefined) {
      globalThis.fetch = savedFetch
    }
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
