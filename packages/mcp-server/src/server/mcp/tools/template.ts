import { readFile } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import type { DaemonClient } from '../daemon-client.js'
import { definedProps } from '../../defined-props.js'
import { annotateBatchTool, type BatchAnnotationItem } from './annotate-batch.js'
import type { GridLayout } from './resolve-layout.js'
import {
  BUILTIN_TEMPLATES,
  getBuiltinTemplate,
  type WhiteboardTemplate,
  type WhiteboardTemplateAnnotation,
  whiteboardTemplateSchema,
} from './template-library.js'

type TemplateVariables = Record<string, string>

interface InstantiateTemplateArgs {
  template: WhiteboardTemplate
  origin: { x: number; y: number }
  scale?: number
  variables?: TemplateVariables
  // Optional pre-generated templateInstanceId for tests or callers that already track it.
  // When omitted, a new id is generated with nanoid().
  templateInstanceId?: string
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

function requirePositiveScale(scale: number | undefined): number {
  if (scale === undefined) return 1
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('scale must be a positive number')
  }
  return scale
}

function resolveTemplateVariables(
  template: WhiteboardTemplate,
  overrides: TemplateVariables | undefined,
): TemplateVariables {
  const resolved: TemplateVariables = {}
  const missing: string[] = []
  for (const variable of template.variables ?? []) {
    const value = overrides?.[variable.name] ?? variable.default
    if (value === undefined) {
      missing.push(variable.name)
      continue
    }
    resolved[variable.name] = value
  }
  if (missing.length > 0) {
    throw new Error(`Missing required template variables: ${missing.join(', ')}`)
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    resolved[key] = value
  }
  return resolved
}

function interpolateString(value: string, variables: TemplateVariables): string {
  return value.replace(PLACEHOLDER_RE, (_, key: string) => variables[key] ?? `{{${key}}}`)
}

function interpolateText(
  value: string | string[] | undefined,
  variables: TemplateVariables,
): string | string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map((line) => interpolateString(line, variables))
  return interpolateString(value, variables)
}

function scalePoint(point: { x: number; y: number }, scale: number, origin: { x: number; y: number }) {
  return {
    x: origin.x + point.x * scale,
    y: origin.y + point.y * scale,
  }
}

function instantiateAnnotation(
  annotation: WhiteboardTemplateAnnotation,
  scale: number,
  origin: { x: number; y: number },
  variables: TemplateVariables,
  templateInstanceId: string,
): BatchAnnotationItem {
  const {
    type,
    imageId,
    coords,
    target,
    row,
    col,
    text,
    title,
    subText,
    subTextPosition,
    autoFit,
    color,
    backgroundColor,
    fillStyle,
    strokeWidth,
    width,
    height,
    align,
    endTarget,
    startBoxId,
    endBoxId,
    label,
    labelOffset,
    labelSide,
    memberIds,
    padding,
    name,
    startBoxName,
    endBoxName,
  } = annotation
  return {
    // Attach the same templateInstanceId to every instantiated annotation so they can be targeted together later.
    type,
    templateInstanceId,
    ...definedProps({
      imageId,
      coords,
      target: target ? scalePoint(target, scale, origin) : undefined,
      row,
      col,
      text: interpolateText(text, variables),
      subText: interpolateText(subText, variables),
      title: interpolateText(title, variables),
      subTextPosition,
      autoFit,
      color,
      backgroundColor,
      fillStyle,
      strokeWidth,
      width: width !== undefined ? width * scale : undefined,
      height: height !== undefined ? height * scale : undefined,
      align,
      endTarget: endTarget ? scalePoint(endTarget, scale, origin) : undefined,
      startBoxId,
      endBoxId,
      label: label ? interpolateString(label, variables) : undefined,
      labelOffset:
        labelOffset !== undefined ? labelOffset * scale : undefined,
      labelSide,
      memberIds,
      padding: padding !== undefined ? padding * scale : undefined,
      name: name ? interpolateString(name, variables) : undefined,
      startBoxName: startBoxName
        ? interpolateString(startBoxName, variables)
        : undefined,
      endBoxName: endBoxName
        ? interpolateString(endBoxName, variables)
        : undefined,
    }),
  }
}

export function instantiateTemplate(args: InstantiateTemplateArgs): {
  layout?: GridLayout
  annotations: BatchAnnotationItem[]
  variables: TemplateVariables
  bounds: { x: number; y: number; width: number; height: number }
  templateInstanceId: string
} {
  const scale = requirePositiveScale(args.scale)
  const variables = resolveTemplateVariables(args.template, args.variables)
  // Generate a fresh instance id per call when one is not supplied.
  const templateInstanceId = args.templateInstanceId ?? nanoid()
  const layout = args.template.layout
    ? {
        ...args.template.layout,
        cellW: args.template.layout.cellW * scale,
        cellH: args.template.layout.cellH * scale,
        gap: args.template.layout.gap * scale,
        origin: scalePoint(args.template.layout.origin, scale, args.origin),
      }
    : undefined

  const annotations = args.template.annotations.map((annotation) =>
    instantiateAnnotation(annotation, scale, args.origin, variables, templateInstanceId),
  )

  // bounds: union bbox of all instantiated annotations.
  // Only box-like annotations with target + width + height contribute. Arrows are skipped
  // because their coordinates depend on connected boxes, so this stays a conservative
  // approximation of the planned placement area. If nothing contributes (for example all
  // arrows), return origin as a 0x0 bbox. Callers can stack the next template at
  // bounds.y + bounds.height + gap.
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const a of annotations) {
    if (a.target && a.width !== undefined && a.height !== undefined) {
      if (a.target.x < minX) minX = a.target.x
      if (a.target.y < minY) minY = a.target.y
      if (a.target.x + a.width > maxX) maxX = a.target.x + a.width
      if (a.target.y + a.height > maxY) maxY = a.target.y + a.height
    }
  }
  const bounds = Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : { x: args.origin.x, y: args.origin.y, width: 0, height: 0 }

  return { annotations, variables, bounds, templateInstanceId, ...definedProps({ layout }) }
}

async function loadTemplateFromPath(templatePath: string): Promise<WhiteboardTemplate> {
  const raw = await readFile(templatePath, 'utf-8')
  const parsed = JSON.parse(raw) as unknown
  return whiteboardTemplateSchema.parse(parsed) as WhiteboardTemplate
}

export async function resolveTemplateSource(args: {
  templateId?: string
  templatePath?: string
}): Promise<{ template: WhiteboardTemplate; source: 'builtin' | 'file' }> {
  if (!args.templateId && !args.templatePath) {
    throw new Error('templateId or templatePath is required')
  }
  if (args.templateId && args.templatePath) {
    throw new Error('Specify either templateId or templatePath, not both')
  }

  if (args.templateId) {
    const template = getBuiltinTemplate(args.templateId)
    if (!template) {
      const ids = BUILTIN_TEMPLATES.map((item) => item.id).join(', ')
      throw new Error(`Unknown templateId "${args.templateId}". Available templates: ${ids}`)
    }
    return { template, source: 'builtin' }
  }

  return { template: await loadTemplateFromPath(args.templatePath!), source: 'file' }
}

export function listTemplatesTool() {
  return {
    name: 'template_list',
    description:
      'List built-in whiteboard templates/components that can be inserted with template_insert. Templates are lightweight annotate_batch recipes intended for reusable architecture parts.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    execute: async () => ({
      templates: BUILTIN_TEMPLATES.map((template) => ({
        id: template.id,
        title: template.title,
        description: template.description,
        tags: template.tags ?? [],
        variables: (template.variables ?? []).map((variable) => ({
          name: variable.name,
          description: variable.description,
          default: variable.default,
        })),
      })),
    }),
  }
}

export function insertTemplateTool() {
  return {
    name: 'template_insert',
    description:
      'Insert a built-in or file-based template onto a canvas. Templates are resolved into annotate_batch annotations, so they remain editable after insertion. Use templateId for built-ins or templatePath for a custom JSON template.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string', description: 'Canvas ID (workspaceId/slug)' },
        templateId: {
          type: 'string',
          description: 'Built-in template id returned by template_list.',
        },
        templatePath: {
          type: 'string',
          description:
            'Absolute path to a custom template JSON file. Use instead of templateId.',
        },
        target: {
          type: 'object',
          description:
            'Insertion origin in canvas coordinates. Template coordinates are offset from this point.',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        scale: {
          type: 'number',
          description: 'Optional scale multiplier applied to template geometry. Default 1.',
        },
        variables: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional placeholder values keyed by variable name. Overrides template defaults.',
        },
      },
      required: ['canvasId', 'target'],
    },
    execute: async (
      args: {
        canvasId: string
        templateId?: string
        templatePath?: string
        target: { x: number; y: number }
        scale?: number
        variables?: TemplateVariables
      },
      client: DaemonClient,
    ) => {
      const { template, source } = await resolveTemplateSource(
        definedProps({ templateId: args.templateId, templatePath: args.templatePath }),
      )
      const instantiated = instantiateTemplate({
        template,
        origin: args.target,
        ...definedProps({ scale: args.scale, variables: args.variables }),
      })
      const batchTool = annotateBatchTool()
      const result = await batchTool.execute(
        {
          canvasId: args.canvasId,
          annotations: instantiated.annotations,
          ...definedProps({ layout: instantiated.layout }),
        },
        client,
      )
      return {
        ...result,
        templateId: template.id,
        source,
        variables: instantiated.variables,
        bounds: instantiated.bounds,
        templateInstanceId: instantiated.templateInstanceId,
      }
    },
  }
}
