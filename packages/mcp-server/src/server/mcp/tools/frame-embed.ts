import { LoroMap } from 'loro-crdt'
import { nanoid } from 'nanoid'
import type { DaemonClient } from '../daemon-client.js'
import { parseCanvasId } from './canvas-id.js'
import { apiGetSnapshot, apiPostLoroUpdate } from './annotate.js'

// MCP tools for creating Excalidraw frame and embeddable elements. Frames group
// child elements via frameId. Embeddables store a URL in link; allowlisted domains
// render as iframes, while unsupported domains remain as canvas elements until validated.

const MAX_MEMBER_IDS = 500

// Shared Excalidraw base fields for frame and embeddable elements. Kept local so
// annotation-specific fields do not leak into this shape.
function createBaseFields(args: {
  id: string
  type: 'frame' | 'embeddable'
  x: number
  y: number
  width: number
  height: number
  link?: string | null
  frameName?: string | null
}): Record<string, unknown> {
  const now = Date.now()
  return {
    id: args.id,
    type: args.type,
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
    angle: 0,
    strokeColor: args.type === 'frame' ? '#bbbbbb' : '#1971c2',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: args.type === 'frame' ? 2 : 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    groupIds: [],
    boundElements: null,
    frameId: null,
    link: args.link ?? null,
    locked: false,
    isDeleted: false,
    updated: now,
    seed: Math.floor(Math.random() * 1_000_000),
    versionNonce: Math.floor(Math.random() * 1_000_000),
    version: 1,
    ...(args.type === 'frame' ? { name: args.frameName ?? null } : {}),
  }
}

function writeElementToDoc(
  doc: ReturnType<typeof apiGetSnapshot> extends Promise<infer T> ? T : never,
  fields: Record<string, unknown>,
): void {
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(list.length, new LoroMap())
  for (const [k, v] of Object.entries(fields)) {
    map.set(k, v as Parameters<LoroMap['set']>[1])
  }
}

// When memberIds are provided, fit the frame to the children's bounding box with
// padding. If nothing matches, fall back to the caller-supplied x/y/width/height.
function fitFrameToMembers(
  elements: Array<{ id: string; x: number; y: number; width: number; height: number; isDeleted?: boolean }>,
  memberIds: string[],
  padding: number,
): { x: number; y: number; width: number; height: number } | null {
  const members = elements.filter((e) => memberIds.includes(e.id) && !e.isDeleted)
  if (members.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of members) {
    minX = Math.min(minX, m.x)
    minY = Math.min(minY, m.y)
    maxX = Math.max(maxX, m.x + m.width)
    maxY = Math.max(maxY, m.y + m.height)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  }
}

export interface CreateFrameArgs {
  canvasId: string
  x?: number
  y?: number
  width?: number
  height?: number
  name?: string
  memberIds?: string[]
  padding?: number
}

export interface CreateFrameResult {
  elementId: string
  bounds: { x: number; y: number; width: number; height: number }
  assignedMembers: string[]
}

export function createFrameTool() {
  return {
    name: 'create_frame',
    description:
      'Create an Excalidraw frame element. A frame groups child elements visually and moves them together. Pass `memberIds` to auto-fit the frame to the bounding box of those elements (their `frameId` is set to the new frame). Without `memberIds`, an empty frame is placed at (x, y) with given width/height.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string' },
        x: { type: 'number', description: 'Left. Ignored when memberIds auto-fits.' },
        y: { type: 'number', description: 'Top. Ignored when memberIds auto-fits.' },
        width: { type: 'number', description: 'Default 600. Ignored when memberIds auto-fits.' },
        height: { type: 'number', description: 'Default 400. Ignored when memberIds auto-fits.' },
        name: { type: 'string', description: 'Optional frame label shown above the frame.' },
        memberIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional existing element ids to wrap. Frame auto-fits their bounding box and assigns frameId to each. Max 500.',
        },
        padding: { type: 'number', description: 'Padding around memberIds bounding box. Default 24.' },
      },
      required: ['canvasId'],
    },
    execute: async (args: CreateFrameArgs, client: DaemonClient): Promise<CreateFrameResult> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const memberIds = (args.memberIds ?? []).slice(0, MAX_MEMBER_IDS)
      const padding = args.padding ?? 24

      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()

      const elementsJson = doc.getMovableList('elements').toJSON() as Array<{
        id: string
        x: number
        y: number
        width: number
        height: number
        isDeleted?: boolean
      }>

      const fitted =
        memberIds.length > 0
          ? fitFrameToMembers(elementsJson, memberIds, padding)
          : null
      const bounds = fitted ?? {
        x: args.x ?? 100,
        y: args.y ?? 100,
        width: args.width ?? 600,
        height: args.height ?? 400,
      }

      const frameId = nanoid(16)
      writeElementToDoc(doc, createBaseFields({
        id: frameId,
        type: 'frame',
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frameName: args.name ?? null,
      }))

      // Reassign child frameId values with targeted LoroMap.set updates.
      const assignedMembers: string[] = []
      if (fitted !== null) {
        const list = doc.getMovableList('elements')
        for (let i = 0; i < list.length; i++) {
          const map = list.get(i) as LoroMap
          const id = map.get('id')
          if (typeof id === 'string' && memberIds.includes(id)) {
            map.set('frameId', frameId)
            assignedMembers.push(id)
          }
        }
      }

      doc.commit()
      await apiPostLoroUpdate(client, workspaceId, slug, doc.export({ mode: 'update', from: prevVV }))

      return { elementId: frameId, bounds, assignedMembers }
    },
  }
}

export interface CreateEmbedArgs {
  canvasId: string
  url: string
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface CreateEmbedResult {
  elementId: string
  url: string
}

// Excalidraw only renders allowlisted URLs as iframes. This tool just stores the
// URL in link; non-allowlisted targets show the usual validation placeholder.
export function createEmbedTool() {
  return {
    name: 'create_embed',
    description:
      'Embed a web page or media URL into the canvas as an Excalidraw embeddable element. Use for annotating live websites with arrows/text for design feedback, or referencing external resources. URL must be http(s). Size defaults to 640x400 (16:10).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string' },
        url: {
          type: 'string',
          description:
            'http(s) URL to embed. Excalidraw renders allowlist domains (YouTube, Figma, CodeSandbox, CodePen, etc.) as iframes; others show a validation prompt until user confirms.',
        },
        x: { type: 'number', description: 'Left. Default 100.' },
        y: { type: 'number', description: 'Top. Default 100.' },
        width: { type: 'number', description: 'Default 640.' },
        height: { type: 'number', description: 'Default 400.' },
      },
      required: ['canvasId', 'url'],
    },
    execute: async (args: CreateEmbedArgs, client: DaemonClient): Promise<CreateEmbedResult> => {
      if (!/^https?:\/\//.test(args.url)) {
        throw new Error(`Invalid url "${args.url}": must start with http:// or https://`)
      }
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()

      const elementId = nanoid(16)
      writeElementToDoc(doc, createBaseFields({
        id: elementId,
        type: 'embeddable',
        x: args.x ?? 100,
        y: args.y ?? 100,
        width: args.width ?? 640,
        height: args.height ?? 400,
        link: args.url,
      }))

      doc.commit()
      await apiPostLoroUpdate(client, workspaceId, slug, doc.export({ mode: 'update', from: prevVV }))

      return { elementId, url: args.url }
    },
  }
}

// Grow or shrink an existing frame by changing members' frameId values and then
// recomputing the frame bbox. Semantics: add[] assigns frameId, remove[] clears
// it, missing ids abort the whole operation, and bounds are recomputed from all
// non-deleted members currently assigned to that frame.
export interface UpdateFrameMembersArgs {
  canvasId: string
  frameId: string
  add?: string[]
  remove?: string[]
  padding?: number
}
export interface UpdateFrameMembersResult {
  frameId: string
  bounds: { x: number; y: number; width: number; height: number }
  addedMembers: string[]
  removedMembers: string[]
}

export function updateFrameMembersTool() {
  return {
    name: 'update_frame_members',
    description:
      "Add/remove elements from an existing frame without recreating it (frameId stays stable so export_png({frameId}) still targets the same group). All-or-nothing on missing ids. Recomputes frame x/y/width/height from the final member bbox plus padding.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvasId: { type: 'string' },
        frameId: { type: 'string', description: 'Existing frame element id.' },
        add: {
          type: 'array',
          items: { type: 'string' },
          description: 'Element ids to include in the frame (their frameId will point to this frame).',
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'Element ids to eject from the frame (their frameId is set to null).',
        },
        padding: {
          type: 'number',
          description: 'Padding around the recomputed bbox. Default 24.',
        },
      },
      required: ['canvasId', 'frameId'],
    },
    execute: async (args: UpdateFrameMembersArgs, client: DaemonClient): Promise<UpdateFrameMembersResult> => {
      const { workspaceId, slug } = parseCanvasId(args.canvasId)
      const padding = args.padding ?? 24
      const add = args.add ?? []
      const remove = args.remove ?? []
      const doc = await apiGetSnapshot(client, workspaceId, slug)
      const prevVV = doc.version()

      const list = doc.getMovableList('elements')
      // Pre-check that the frame and every add/remove target exist.
      const idToIdx = new Map<string, number>()
      for (let i = 0; i < list.length; i++) {
        const map = list.get(i) as LoroMap
        const id = map.get('id')
        if (typeof id === 'string') idToIdx.set(id, i)
      }
      const frameIdx = idToIdx.get(args.frameId)
      if (frameIdx === undefined) {
        throw new Error(`Frame "${args.frameId}" not found`)
      }
      const frameMap = list.get(frameIdx) as LoroMap
      if (frameMap.get('type') !== 'frame') {
        throw new Error(`Element "${args.frameId}" is not a frame`)
      }
      for (const id of [...add, ...remove]) {
        if (!idToIdx.has(id)) {
          throw new Error(`Element "${id}" not found`)
        }
      }

      // Apply add/remove operations.
      const addedMembers: string[] = []
      const removedMembers: string[] = []
      for (const id of add) {
        const map = list.get(idToIdx.get(id)!) as LoroMap
        if (map.get('frameId') !== args.frameId) {
          map.set('frameId', args.frameId)
        }
        addedMembers.push(id)
      }
      for (const id of remove) {
        const map = list.get(idToIdx.get(id)!) as LoroMap
        if (map.get('frameId') === args.frameId) {
          map.set('frameId', null)
        }
        removedMembers.push(id)
      }

      // Recompute the bbox from fresh JSON, considering only members still assigned to the target frame.
      const snap = list.toJSON() as Array<{
        id: string
        x: number
        y: number
        width: number
        height: number
        frameId?: string | null
        isDeleted?: boolean
      }>
      const members = snap.filter(
        (e) => e.frameId === args.frameId && e.isDeleted !== true && e.id !== args.frameId,
      )
      let bounds: { x: number; y: number; width: number; height: number }
      if (members.length === 0) {
        bounds = {
          x: frameMap.get('x') as number,
          y: frameMap.get('y') as number,
          width: frameMap.get('width') as number,
          height: frameMap.get('height') as number,
        }
      } else {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const m of members) {
          minX = Math.min(minX, m.x)
          minY = Math.min(minY, m.y)
          maxX = Math.max(maxX, m.x + m.width)
          maxY = Math.max(maxY, m.y + m.height)
        }
        bounds = {
          x: minX - padding,
          y: minY - padding,
          width: maxX - minX + padding * 2,
          height: maxY - minY + padding * 2,
        }
        frameMap.set('x', bounds.x)
        frameMap.set('y', bounds.y)
        frameMap.set('width', bounds.width)
        frameMap.set('height', bounds.height)
      }

      doc.commit()
      await apiPostLoroUpdate(
        client,
        workspaceId,
        slug,
        doc.export({ mode: 'update', from: prevVV }),
      )
      return { frameId: args.frameId, bounds, addedMembers, removedMembers }
    },
  }
}
