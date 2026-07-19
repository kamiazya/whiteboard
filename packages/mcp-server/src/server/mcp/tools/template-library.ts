import { z } from 'zod'
import type { BatchAnnotationItem } from './annotate-batch.js'
import type { GridLayout } from './resolve-layout.js'

const pointSchema = z.object({
  x: z.number(),
  y: z.number(),
})

const multilineTextSchema = z.union([z.string(), z.array(z.string())])

const templateVariableSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  default: z.string().optional(),
})

const templateLayoutSchema = z.object({
  cols: z.number(),
  rows: z.number(),
  cellW: z.number(),
  cellH: z.number(),
  gap: z.number(),
  origin: pointSchema,
})

const templateAnnotationSchema = z
  .object({
    type: z.enum(['arrow', 'text', 'rectangle', 'highlight', 'box_with_label', 'group']),
    imageId: z.string().optional(),
    coords: z.enum(['absolute']).optional(),
    target: pointSchema.optional(),
    row: z.number().optional(),
    col: z.number().optional(),
    text: multilineTextSchema.optional(),
    subText: multilineTextSchema.optional(),
    subTextPosition: z.enum(['top', 'inside-bottom']).optional(),
    autoFit: z.boolean().optional(),
    color: z.string().optional(),
    // Visual style overrides for rect/box/highlight/arrow annotations.
    backgroundColor: z.string().optional(),
    fillStyle: z.enum(['solid', 'hachure', 'cross-hatch']).optional(),
    strokeWidth: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    endTarget: pointSchema.optional(),
    startBoxId: z.string().optional(),
    endBoxId: z.string().optional(),
    label: z.string().optional(),
    labelOffset: z.number().optional(),
    labelSide: z.enum(['auto', 'above', 'below', 'left', 'right']).optional(),
    memberIds: z.array(z.string()).optional(),
    padding: z.number().optional(),
    title: multilineTextSchema.optional(),
    name: z.string().optional(),
    startBoxName: z.string().optional(),
    endBoxName: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.imageId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Template annotations do not support imageId.',
        path: ['imageId'],
      })
    }
  })

export const whiteboardTemplateSchema = z.object({
  format: z.literal('excalidraw-tool-template').default('excalidraw-tool-template'),
  version: z.literal(1).default(1),
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).optional(),
  variables: z.array(templateVariableSchema).optional(),
  layout: templateLayoutSchema.optional(),
  annotations: z.array(templateAnnotationSchema).min(1),
})

export type WhiteboardTemplate = z.infer<typeof whiteboardTemplateSchema> & {
  annotations: BatchAnnotationItem[]
  layout?: GridLayout
}

type WhiteboardTemplateVariable = z.infer<typeof templateVariableSchema>

export const BUILTIN_TEMPLATES: WhiteboardTemplate[] = [
  {
    format: 'excalidraw-tool-template',
    version: 1,
    id: 'client-api-db',
    title: 'Client -> API -> DB',
    description: 'Three-tier request path for app/browser, service, and database.',
    tags: ['architecture', 'backend', 'flow'],
    variables: [
      { name: 'client', description: 'Left box label', default: 'Client' },
      { name: 'api', description: 'Center box label', default: 'API' },
      { name: 'db', description: 'Right box label', default: 'Database' },
      { name: 'client_to_api', description: 'Arrow label from client to API', default: 'HTTPS' },
      { name: 'api_to_db', description: 'Arrow label from API to DB', default: 'SQL' },
    ],
    annotations: [
      {
        type: 'box_with_label',
        name: 'client',
        target: { x: 0, y: 40 },
        width: 180,
        height: 84,
        text: '{{client}}',
        color: 'info',
      },
      {
        type: 'box_with_label',
        name: 'api',
        target: { x: 250, y: 40 },
        width: 200,
        height: 84,
        text: '{{api}}',
        color: 'primary',
      },
      {
        type: 'box_with_label',
        name: 'db',
        target: { x: 520, y: 40 },
        width: 180,
        height: 84,
        text: '{{db}}',
        color: 'neutral',
      },
      {
        type: 'arrow',
        startBoxName: 'client',
        endBoxName: 'api',
        label: '{{client_to_api}}',
        color: 'primary',
      },
      {
        type: 'arrow',
        startBoxName: 'api',
        endBoxName: 'db',
        label: '{{api_to_db}}',
        color: 'neutral',
      },
    ],
  },
  {
    format: 'excalidraw-tool-template',
    version: 1,
    id: 'queue-worker',
    title: 'Queue + Worker',
    description: 'Producer, queue, worker, and storage pipeline for async processing.',
    tags: ['architecture', 'async', 'queue'],
    variables: [
      { name: 'producer', description: 'Producer box label', default: 'Producer' },
      { name: 'queue', description: 'Queue box label', default: 'Queue' },
      { name: 'worker', description: 'Worker box label', default: 'Worker' },
      { name: 'store', description: 'Storage box label', default: 'Store' },
      { name: 'enqueue', description: 'Arrow label from producer to queue', default: 'enqueue' },
      { name: 'consume', description: 'Arrow label from queue to worker', default: 'consume' },
      { name: 'persist', description: 'Arrow label from worker to store', default: 'persist' },
    ],
    annotations: [
      {
        type: 'box_with_label',
        name: 'producer',
        target: { x: 0, y: 40 },
        width: 180,
        height: 84,
        text: '{{producer}}',
        color: 'info',
      },
      {
        type: 'box_with_label',
        name: 'queue',
        target: { x: 220, y: 40 },
        width: 180,
        height: 84,
        text: '{{queue}}',
        color: 'warning',
      },
      {
        type: 'box_with_label',
        name: 'worker',
        target: { x: 440, y: 40 },
        width: 180,
        height: 84,
        text: '{{worker}}',
        color: 'primary',
      },
      {
        type: 'box_with_label',
        name: 'store',
        target: { x: 660, y: 40 },
        width: 180,
        height: 84,
        text: '{{store}}',
        color: 'success',
      },
      {
        type: 'arrow',
        startBoxName: 'producer',
        endBoxName: 'queue',
        label: '{{enqueue}}',
        color: 'warning',
      },
      {
        type: 'arrow',
        startBoxName: 'queue',
        endBoxName: 'worker',
        label: '{{consume}}',
        color: 'primary',
      },
      {
        type: 'arrow',
        startBoxName: 'worker',
        endBoxName: 'store',
        label: '{{persist}}',
        color: 'success',
      },
    ],
  },
  {
    format: 'excalidraw-tool-template',
    version: 1,
    id: 'event-fanout',
    title: 'Event Fan-Out',
    description: 'One producer publishing to an event topic that fans out to two consumers.',
    tags: ['architecture', 'event', 'fanout'],
    variables: [
      { name: 'producer', description: 'Producer box label', default: 'Producer' },
      { name: 'topic', description: 'Topic or bus label', default: 'Event Topic' },
      { name: 'consumer_a', description: 'Top consumer label', default: 'Consumer A' },
      { name: 'consumer_b', description: 'Bottom consumer label', default: 'Consumer B' },
      { name: 'publish', description: 'Arrow label from producer to topic', default: 'publish' },
      { name: 'deliver_a', description: 'Arrow label to top consumer', default: 'deliver' },
      { name: 'deliver_b', description: 'Arrow label to bottom consumer', default: 'deliver' },
    ],
    annotations: [
      {
        type: 'box_with_label',
        name: 'producer',
        target: { x: 0, y: 120 },
        width: 180,
        height: 84,
        text: '{{producer}}',
        color: 'info',
      },
      {
        type: 'box_with_label',
        name: 'topic',
        target: { x: 260, y: 120 },
        width: 210,
        height: 84,
        text: '{{topic}}',
        color: 'warning',
      },
      {
        type: 'box_with_label',
        name: 'consumer_a',
        target: { x: 560, y: 0 },
        width: 200,
        height: 84,
        text: '{{consumer_a}}',
        color: 'success',
      },
      {
        type: 'box_with_label',
        name: 'consumer_b',
        target: { x: 560, y: 240 },
        width: 200,
        height: 84,
        text: '{{consumer_b}}',
        color: 'success',
      },
      {
        type: 'arrow',
        startBoxName: 'producer',
        endBoxName: 'topic',
        label: '{{publish}}',
        color: 'warning',
      },
      {
        type: 'arrow',
        startBoxName: 'topic',
        endBoxName: 'consumer_a',
        label: '{{deliver_a}}',
        color: 'success',
      },
      {
        type: 'arrow',
        startBoxName: 'topic',
        endBoxName: 'consumer_b',
        label: '{{deliver_b}}',
        color: 'success',
      },
    ],
  },
]

export function getBuiltinTemplate(templateId: string): WhiteboardTemplate | undefined {
  return BUILTIN_TEMPLATES.find((template) => template.id === templateId)
}
