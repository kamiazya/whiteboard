import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoroDoc } from 'loro-crdt'

import { instantiateTemplate, insertTemplateTool, listTemplatesTool, resolveTemplateSource } from './template.js'
import { getBuiltinTemplate } from './template-library.js'

function makeEmptySnapshot(): Uint8Array {
  const doc = new LoroDoc()
  doc.commit()
  return doc.export({ mode: 'snapshot' }) as Uint8Array
}

describe('template helpers', () => {
  it('built-in template can be instantiated with variable overrides and scale', () => {
    const template = getBuiltinTemplate('client-api-db')
    expect(template).toBeDefined()
    const instantiated = instantiateTemplate({
      template: template!,
      origin: { x: 100, y: 200 },
      scale: 2,
      variables: {
        client: 'Web',
        api_to_db: 'read replica',
      },
    })

    expect(instantiated.variables.client).toBe('Web')
    const [firstBox, , , , secondArrow] = instantiated.annotations
    expect(firstBox.target).toEqual({ x: 100, y: 280 })
    expect(firstBox.width).toBe(360)
    expect(secondArrow.label).toBe('read replica')
  })

  it('case 341', () => {
    const template = getBuiltinTemplate('client-api-db')
    expect(template).toBeDefined()
    const inst = instantiateTemplate({
      template: template!,
      origin: { x: 10, y: 20 },
    })
    expect(inst.bounds).toBeDefined()
    expect(inst.bounds.x).toBe(10)
    expect(inst.bounds.y).toBe(60)
    expect(inst.bounds.width).toBe(700)
    expect(inst.bounds.height).toBe(84)
  })

  it('case 342', () => {
    const template = getBuiltinTemplate('client-api-db')!
    const inst = instantiateTemplate({
      template,
      origin: { x: 0, y: 0 },
      scale: 2,
    })
    // width 700*2 = 1400, height 84*2 = 168
    expect(inst.bounds.width).toBe(1400)
    expect(inst.bounds.height).toBe(168)
  })

  it('case 343', () => {
    const template = getBuiltinTemplate('event-fanout')!
    const inst = instantiateTemplate({
      template,
      origin: { x: 100, y: 50 },
    })
    //   consumer_a (560,0,200,84), consumer_b (560,240,200,84)
    // x max = 560+200 = 760, y max = 240+84 = 324
    expect(inst.bounds.x).toBe(100) // min box x = 0 → origin.x
    expect(inst.bounds.y).toBe(50) // min box y = 0 → origin.y
    expect(inst.bounds.width).toBe(760)
    expect(inst.bounds.height).toBe(324)
  })

  it('case 344', () => {
    const template = getBuiltinTemplate('client-api-db')!
    const inst = instantiateTemplate({
      template,
      origin: { x: 0, y: 0 },
    })
    expect(typeof inst.templateInstanceId).toBe('string')
    expect(inst.templateInstanceId.length).toBeGreaterThanOrEqual(10)
    for (const a of inst.annotations) {
      expect(a.templateInstanceId).toBe(inst.templateInstanceId)
    }
  })

  it('case 345', () => {
    const template = getBuiltinTemplate('client-api-db')!
    const r1 = instantiateTemplate({ template, origin: { x: 0, y: 0 } })
    const r2 = instantiateTemplate({ template, origin: { x: 0, y: 0 } })
    expect(r1.templateInstanceId).not.toBe(r2.templateInstanceId)
  })

  it('case 346', () => {
    const template = getBuiltinTemplate('client-api-db')!
    const inst = instantiateTemplate({
      template,
      origin: { x: 0, y: 0 },
      templateInstanceId: 'my-explicit-id',
    })
    expect(inst.templateInstanceId).toBe('my-explicit-id')
    for (const a of inst.annotations) {
      expect(a.templateInstanceId).toBe('my-explicit-id')
    }
  })

  it('missing required variables are rejected', () => {
    expect(() =>
      instantiateTemplate({
        template: {
          format: 'excalidraw-tool-template',
          version: 1,
          id: 'custom',
          title: 'Custom',
          description: 'Requires one variable',
          variables: [{ name: 'title' }],
          annotations: [
            {
              type: 'text',
              target: { x: 0, y: 0 },
              text: '{{title}}',
            },
          ],
        },
        origin: { x: 0, y: 0 },
      }),
    ).toThrow(/Missing required template variables: title/)
  })
})

describe('template source resolution', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whiteboard-template-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a valid custom template file', async () => {
    const templatePath = join(dir, 'custom-template.json')
    await writeFile(
      templatePath,
      JSON.stringify({
        format: 'excalidraw-tool-template',
        version: 1,
        id: 'custom-template',
        title: 'Custom Template',
        description: 'External file template',
        annotations: [
          {
            type: 'text',
            target: { x: 0, y: 0 },
            text: 'hello',
          },
        ],
      }),
    )

    const resolved = await resolveTemplateSource({ templatePath })
    expect(resolved.source).toBe('file')
    expect(resolved.template.id).toBe('custom-template')
  })

  it('rejects unsupported image-based template annotations', async () => {
    const templatePath = join(dir, 'invalid-template.json')
    await writeFile(
      templatePath,
      JSON.stringify({
        format: 'excalidraw-tool-template',
        version: 1,
        id: 'invalid-template',
        title: 'Invalid',
        description: 'Uses imageId',
        annotations: [
          {
            type: 'text',
            imageId: 'img-1',
            target: { x: 0, y: 0 },
            text: 'bad',
          },
        ],
      }),
    )

    await expect(resolveTemplateSource({ templatePath })).rejects.toThrow(/imageId/)
  })

  it('rejects when both templateId and templatePath are given', async () => {
    await expect(
      resolveTemplateSource({
        templateId: 'client-api-db',
        templatePath: join(dir, 'does-not-exist.json'),
      }),
    ).rejects.toThrow(/Specify either templateId or templatePath, not both/)
  })

  it('rejects when neither templateId nor templatePath is given', async () => {
    await expect(resolveTemplateSource({})).rejects.toThrow(
      /templateId or templatePath is required/,
    )
  })
})

describe('instantiateTemplate scale validation', () => {
  it('rejects non-positive scale (0 / negative / NaN / Infinity)', () => {
    const template = getBuiltinTemplate('client-api-db')!
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        instantiateTemplate({
          template,
          origin: { x: 0, y: 0 },
          scale: bad,
        }),
      ).toThrow(/scale must be a positive number/)
    }
  })

  it('treats scale=undefined as 1 (no multiplication)', () => {
    const template = getBuiltinTemplate('client-api-db')!
    const r = instantiateTemplate({ template, origin: { x: 10, y: 20 } })
    const clientBox = r.annotations.find((a) => a.name === 'client')!
    expect(clientBox.target).toEqual({ x: 10, y: 60 })
    expect(clientBox.width).toBe(180)
  })
})

describe('template tools', () => {
  let originalFetch: typeof globalThis.fetch
  const client = {
    port: 3099,
    baseUrl: 'http://localhost:3099',
    request: (path: string, init?: RequestInit) =>
      globalThis.fetch(new URL(path, 'http://localhost:3099'), init),
    touch: async () => undefined,
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('template_list returns built-in templates with variable metadata', async () => {
    const tool = listTemplatesTool()
    const res = await tool.execute()
    expect(res.templates.map((template) => template.id)).toContain('client-api-db')
    const clientApiDb = res.templates.find((template) => template.id === 'client-api-db')
    expect(clientApiDb?.variables.some((variable) => variable.name === 'client')).toBe(true)
  })

  it('template_insert expands a template via annotate_batch and returns inserted ids', async () => {
    const snapshot = makeEmptySnapshot()
    const updateBodies: Uint8Array[] = []
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const textUrl = url.toString()
      if (textUrl.endsWith('/palette')) {
        return new Response(JSON.stringify({ palette: {} }), { status: 200 })
      }
      if (textUrl.endsWith('/snapshot')) {
        return new Response(snapshot, { status: 200 })
      }
      if (textUrl.endsWith('/update')) {
        updateBodies.push(new Uint8Array(init?.body as Uint8Array))
        return new Response(null, { status: 200 })
      }
      throw new Error(`unexpected fetch ${textUrl}`)
    }) as unknown as typeof globalThis.fetch

    const tool = insertTemplateTool()
    const res = await tool.execute(
      {
        canvasId: 'sess-1/diagram',
        templateId: 'client-api-db',
        target: { x: 10, y: 20 },
        variables: {
          client: 'Browser',
        },
      },
      client,
    )

    expect(res.templateId).toBe('client-api-db')
    expect(res.source).toBe('builtin')
    expect(res.variables.client).toBe('Browser')
    expect(res.annotations).toHaveLength(5)
    expect(res.elementIds.length).toBeGreaterThanOrEqual(5)
    expect(updateBodies).toHaveLength(1)
  })
})
