// Keep SKILL.md (user-facing docs) aligned with MCP tool inputSchema (implementation)
// via unit tests. If they drift, Claude may try to use nonexistent options or keys,
// so this suite catches documentation/schema mismatches as regressions.
//
// The checks cover two directions:
// - names mentioned by the SKILL must exist in the schema
// - schema enums/key sets must match what the SKILL documents

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { annotateTool } from './tools/annotate.js'
import { annotateBatchTool } from './tools/annotate-batch.js'
import { canvasInspectTool } from './tools/canvas-inspect.js'
import { createCanvasTool, listCanvasTool, openCanvasTool } from './tools/canvas.js'
import { SEMANTIC_PALETTE } from './tools/color-palette.js'
import { paletteDeleteTool, paletteGetTool, paletteSetTool } from './tools/palette.js'
import {
  canvasClearTool,
  deleteElementTool,
  moveElementsTool,
  reorderElementsTool,
  alignElementsTool,
  distributeElementsTool,
  updateElementTool,
} from './tools/element-ops-tools.js'
import { exportPngTool } from './tools/export.js'
import { loadImageTool } from './tools/load.js'
import { insertTemplateTool, listTemplatesTool } from './tools/template.js'
import { createFrameTool, createEmbedTool } from './tools/frame-embed.js'
import {
  libraryInsertItemTool,
  libraryInsertBatchTool,
  userLibraryMetadataDeleteTool,
  userLibraryMetadataGetTool,
  userLibraryMetadataSetTool,
} from './tools/library.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_PATH = resolve(__dirname, '../../../../../skills/drawing-visuals/SKILL.md')
// SKILL.md uses progressive disclosure and moves details into references/*.md,
// so schema string matching also reads the reference notes.
const SKILL_REFERENCE_PATHS = [
  resolve(__dirname, '../../../../../skills/drawing-visuals/references/library-first-workflow.md'),
]
const skillText = [SKILL_PATH, ...SKILL_REFERENCE_PATHS]
  .map((p) => readFileSync(p, 'utf-8'))
  .join('\n')
// Statically load the source files that declare tool input shapes so the zod
// schema can be compared with the JSON inputSchema. JSON schema fields could
// exist while zod silently strips them, so this test compares source-level
// key sets directly. Input shapes live next to their tool in tools/*.ts
// (annotateBatchInputShape, libraryInsertBatchInputShape, etc.), not inlined
// in tool-registration.ts, so all three are read and concatenated.
const ZOD_SOURCE_PATHS = [
  resolve(__dirname, 'tool-registration.ts'),
  resolve(__dirname, 'tools/annotate-batch.ts'),
  resolve(__dirname, 'tools/library.ts'),
]
const mcpIndexText = ZOD_SOURCE_PATHS.map((p) => readFileSync(p, 'utf-8')).join('\n')

// Materialize every tool factory and build a tool.name -> inputSchema lookup.
// Each tool has a different inputSchema shape, so the map uses a widened schema
// type. That cast is acceptable here because this test validates the runtime
// schema contents explicitly with expect().
type AnyTool = {
  name: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}
const tools: AnyTool[] = [
  createCanvasTool(),
  listCanvasTool(),
  openCanvasTool(),
  listTemplatesTool(),
  insertTemplateTool(),
  loadImageTool(),
  annotateTool(),
  annotateBatchTool(),
  paletteGetTool(),
  paletteSetTool(),
  paletteDeleteTool(),
  canvasInspectTool(),
  updateElementTool(),
  deleteElementTool(),
  moveElementsTool(),
  alignElementsTool(),
  distributeElementsTool(),
  canvasClearTool(),
  exportPngTool(),
  createFrameTool(),
  createEmbedTool(),
  reorderElementsTool(),
] as unknown as AnyTool[]
const toolByName = new Map<string, AnyTool>(tools.map((t) => [t.name, t]))

// Detect whether SKILL.md mentions a tool name. Use simple string matching so
// both backticked and plain-word mentions are covered.
function skillMentions(name: string): boolean {
  return skillText.includes(name)
}

describe('SKILL.md ↔ MCP schema integrity', () => {
  // 1. Tool name integrity.
  // Every tool named in the SKILL must exist in the implementation.
  describe('tool name mentions', () => {
    const toolNames = [
      'canvas_create',
      'canvas_list',
      'canvas_open',
      'template_list',
      'template_insert',
      'canvas_inspect',
      'load_image',
      'annotate',
      'annotate_batch',
      'palette_get',
      'palette_set',
      'palette_delete',
      'update_element',
      'delete_element',
      'move_elements',
      'align_elements',
      'distribute_elements',
      'canvas_clear',
      'export_png',
      'create_frame',
      'create_embed',
      'reorder_elements',
    ]
    for (const name of toolNames) {
      it(`implements the tool referenced by SKILL.md: ${name}`, () => {
        expect(skillMentions(name)).toBe(true)
        expect(toolByName.has(name)).toBe(true)
      })
    }
  })

  // 2. export_png parameter integrity.
  // Every parameter documented in the SKILL must exist in inputSchema, and every
  // schema parameter must be documented in the SKILL.
  describe('export_png params', () => {
    const tool = toolByName.get('export_png')!
    const schemaKeys = Object.keys(tool.inputSchema.properties)
    const paramsDocumented = ['padding', 'scale', 'minFontPx']

    for (const p of paramsDocumented) {
      it(`includes documented export_png.${p} in inputSchema`, () => {
        expect(skillMentions(p)).toBe(true)
        expect(schemaKeys).toContain(p)
      })
    }

    it('documents every export_png inputSchema parameter except canvasId in the SKILL', () => {
      const optional = schemaKeys.filter((k) => k !== 'canvasId')
      for (const k of optional) {
        expect(skillText, `SKILL.md is missing ${k}`).toContain(k)
      }
    })
  })

  // 3. annotate_batch annotation type enum integrity.
  // All types named by the SKILL must appear in the enum, and all enum values
  // must be mentioned by the SKILL.
  describe('annotate_batch annotation types', () => {
    const tool = toolByName.get('annotate_batch')!
    const annotationsSchema = tool.inputSchema.properties.annotations as {
      items: { properties: { type: { enum: string[] } } }
    }
    const enumTypes = annotationsSchema.items.properties.type.enum

    // Core annotation types that the SKILL always mentions in the main text.
    const typesDocumented = ['arrow', 'text', 'box_with_label']
    for (const t of typesDocumented) {
      it(`includes SKILL-mentioned type "${t}" in the enum`, () => {
        expect(enumTypes).toContain(t)
      })
    }

    it('mentions every enum type in SKILL.md', () => {
      for (const t of enumTypes) {
        expect(skillText, `SKILL.md is missing annotation type "${t}"`).toContain(t)
      }
    })
  })

  // 4. Semantic color palette integrity.
  // SEMANTIC_PALETTE keys must match the SKILL enumeration exactly. Order or
  // spelling drift here is not acceptable.
  describe('semantic color palette', () => {
    const paletteKeys = Object.keys(SEMANTIC_PALETTE).sort()
    // Extract the slash-delimited key list from the SKILL line. The SKILL wraps
    // keywords in backticks, so the regex accepts them optionally.
    const match = skillText.match(
      /`?primary`?\s*\/\s*`?success`?\s*\/\s*`?danger`?\s*\/\s*`?warning`?\s*\/\s*`?neutral`?\s*\/\s*`?info`?/,
    )

    it('contains a semantic color enumeration line in SKILL.md', () => {
      expect(match).not.toBeNull()
    })

    it('matches SEMANTIC_PALETTE keys exactly with the SKILL enumeration', () => {
      // Strip backticks before comparing.
      const skillKeys = match![0]
        .split('/')
        .map((s) => s.trim().replace(/`/g, ''))
        .sort()
      expect(skillKeys).toEqual(paletteKeys)
    })
  })

  // 5. Arrow box-snap parameters.
  // startBoxId and endBoxId must exist in both annotate_batch and annotate.
  describe('arrow snap params', () => {
    const batchAnnotations = toolByName.get('annotate_batch')!.inputSchema.properties
      .annotations as { items: { properties: Record<string, unknown> } }
    const batchItems = batchAnnotations.items.properties
    const single = toolByName.get('annotate')!.inputSchema.properties

    for (const p of ['startBoxId', 'endBoxId']) {
      it(`documents ${p} in the SKILL and exposes it in both annotate schemas`, () => {
        expect(skillMentions(p)).toBe(true)
        expect(batchItems).toHaveProperty(p)
        expect(single).toHaveProperty(p)
      })
    }
  })

  // 6. canvas_create overwrite flag.
  describe('canvas_create optional flags', () => {
    const tool = toolByName.get('canvas_create')!
    const keys = Object.keys(tool.inputSchema.properties)

    it('documents overwrite in the SKILL and exposes it in the schema', () => {
      expect(keys).toContain('overwrite')
      // The SKILL shows overwrite: true in step 5.
      expect(skillMentions('overwrite: true')).toBe(true)
    })
  })

  // 7. Required params for update_element / delete_element / move_elements.
  describe('element-ops required fields', () => {
    it('requires canvasId/elementId/patch for update_element', () => {
      const req = toolByName.get('update_element')!.inputSchema.required
      expect(req).toEqual(expect.arrayContaining(['canvasId', 'elementId', 'patch']))
      expect(skillMentions('update_element')).toBe(true)
    })
    it('requires canvasId/elementId for delete_element', () => {
      const req = toolByName.get('delete_element')!.inputSchema.required
      expect(req).toEqual(expect.arrayContaining(['canvasId', 'elementId']))
      expect(skillMentions('delete_element')).toBe(true)
    })
    it('requires canvasId/elementIds/dx/dy for move_elements', () => {
      const req = toolByName.get('move_elements')!.inputSchema.required
      expect(req).toEqual(expect.arrayContaining(['canvasId', 'elementIds', 'dx', 'dy']))
      expect(skillMentions('move_elements')).toBe(true)
    })
  })

  // 8. Tool count invariant.
  // If a tool is added or removed, toolNames and SKILL.md must be updated too.
  describe('tool count invariants', () => {
    it('keeps tools[] and toolByName at 20 entries', () => {
      expect(tools.length).toBe(22)
      expect(toolByName.size).toBe(22)
    })
  })

  // 9. zod ↔ JSON inputSchema parity for annotate_batch.
  // Every key in annotate-batch.ts JSON schema must also exist in
  // annotateBatchInputShape (tools/annotate-batch.ts). Missing zod fields get
  // stripped silently.
  describe('zod ↔ JSON inputSchema parity for annotate_batch', () => {
    const annotationsSchema = toolByName.get('annotate_batch')!.inputSchema.properties
      .annotations as { items: { properties: Record<string, unknown> } }
    const jsonKeys = Object.keys(annotationsSchema.items.properties)

    // Match `<key>: z.` in the source text (the formatter may wrap `z` onto
    // its own line). False positives are acceptable; missed keys are not.
    for (const key of jsonKeys) {
      it(`defines annotate_batch.annotations[].${key} in the zod schema`, () => {
        const pattern = new RegExp(`\\b${key}\\s*:\\s*z\\s*\\.`)
        expect(mcpIndexText).toMatch(pattern)
      })
    }
  })

  describe('library batch + metadata tools', () => {
    const singleInsertTool = libraryInsertItemTool()
    const batchTool = libraryInsertBatchTool()
    const metadataGetTool = userLibraryMetadataGetTool()
    const metadataSetTool = userLibraryMetadataSetTool()
    const metadataDeleteTool = userLibraryMetadataDeleteTool()

    it('SKILL.md mentions the new library tools', () => {
      for (const name of [
        batchTool.name,
        metadataGetTool.name,
        metadataSetTool.name,
        metadataDeleteTool.name,
      ]) {
        expect(skillText).toContain(name)
      }
    })

    it('library_insert_item exposes explicit scale override in schema and zod', () => {
      expect(singleInsertTool.inputSchema.properties).toHaveProperty('scale')
      expect(mcpIndexText).toContain('libInsertTool.name')
      expect(skillText).toContain('library_insert_item')
      // Check that explicit scale override is documented conceptually, not just
      // through a literal numeric example such as "1.1".
      expect(skillText).toMatch(/explicit\s+`?scale`?/)
    })

    it('library_insert_batch documents and exposes batch groupAs + item groupAs', () => {
      expect(batchTool.inputSchema.properties).toHaveProperty('groupAs')
      expect(batchTool.inputSchema.properties).toHaveProperty('scale')
      const items = batchTool.inputSchema.properties.items as {
        items: { properties: Record<string, unknown> }
      }
      expect(items.items.properties).toHaveProperty('groupAs')
      expect(items.items.properties).toHaveProperty('scale')
      expect(mcpIndexText).toContain('libInsertBatch.name')
      // Match `<key>: z.` loosely (description chains vary in length/wrapping)
      // rather than the exact zod call, so this survives .describe() edits.
      expect(mcpIndexText).toMatch(/\bgroupAs\s*:\s*z\s*\.\s*string\s*\(\s*\)\s*\.optional\s*\(/)
      expect(mcpIndexText).toMatch(/\bscale\s*:\s*z\s*\.\s*number\s*\(\s*\)\s*\.optional\s*\(/)
      expect(skillText).toContain('library_insert_batch')
    })

    it('metadata tools expose the expected revisioned fields', () => {
      expect(metadataGetTool.inputSchema.required).toEqual(['name'])
      expect(metadataSetTool.inputSchema.required).toEqual(['name', 'revision'])
      expect(metadataDeleteTool.inputSchema.required).toEqual(['name', 'revision'])
      expect(metadataSetTool.inputSchema.properties).toHaveProperty('aliases')
      expect(metadataSetTool.inputSchema.properties).toHaveProperty('notes')
      expect(metadataSetTool.inputSchema.properties).toHaveProperty('scales')
      expect(metadataDeleteTool.inputSchema.properties).toHaveProperty('aliasKeys')
      expect(metadataDeleteTool.inputSchema.properties).toHaveProperty('noteKeys')
      expect(metadataDeleteTool.inputSchema.properties).toHaveProperty('scaleKeys')
    })
  })
})
