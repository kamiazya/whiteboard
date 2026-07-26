import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type {
  CoreFacets,
  coreFacetsSchema,
  ExtensionFacets,
  extensionFacetsSchema,
  FacetsRaw,
  facetsRawSchema,
} from './facets.js'
import type { CanvasId, canvasIdSchema, NodeId, nodeIdSchema } from './ids.js'
import type { MarkdownCanvas, markdownCanvasSchema } from './markdown.js'
import type { MdastNode } from './mdast/index.js'
import { mdastNodeSchema } from './mdast/index.js'
import type { CanvasMeta, canvasMetaSchema } from './meta.js'
import type {
  CanvasColor,
  CanvasEdge,
  canvasColorSchema,
  canvasEdgeSchema,
  SpatialCanvas,
  SpatialNode,
  spatialCanvasSchema,
  spatialNodeSchema,
  XWhiteboard,
  xWhiteboardSchema,
} from './spatial.js'
import type {
  WorkspaceMeta,
  WorkspaceTreeNodeData,
  workspaceMetaSchema,
  workspaceTreeNodeDataSchema,
} from './workspace-tree.js'

// Compile-time only: this file asserts every exported type is exactly
// z.infer<typeof schema> for its schema, catching a hand-written type that
// has drifted from its schema (the create_frame assignedMembers bug's
// shape) without needing a runtime check.
it('type-source invariant: exported types equal z.infer of their schema', () => {
  expectTypeOf<CanvasMeta>().toEqualTypeOf<z.infer<typeof canvasMetaSchema>>()
  expectTypeOf<CoreFacets>().toEqualTypeOf<z.infer<typeof coreFacetsSchema>>()
  expectTypeOf<ExtensionFacets>().toEqualTypeOf<z.infer<typeof extensionFacetsSchema>>()
  expectTypeOf<FacetsRaw>().toEqualTypeOf<z.infer<typeof facetsRawSchema>>()
  expectTypeOf<CanvasId>().toEqualTypeOf<z.infer<typeof canvasIdSchema>>()
  expectTypeOf<NodeId>().toEqualTypeOf<z.infer<typeof nodeIdSchema>>()
  expectTypeOf<CanvasColor>().toEqualTypeOf<z.infer<typeof canvasColorSchema>>()
  expectTypeOf<SpatialNode>().toEqualTypeOf<z.infer<typeof spatialNodeSchema>>()
  expectTypeOf<CanvasEdge>().toEqualTypeOf<z.infer<typeof canvasEdgeSchema>>()
  expectTypeOf<SpatialCanvas>().toEqualTypeOf<z.infer<typeof spatialCanvasSchema>>()
  expectTypeOf<XWhiteboard>().toEqualTypeOf<z.infer<typeof xWhiteboardSchema>>()
  expectTypeOf<MarkdownCanvas>().toEqualTypeOf<z.infer<typeof markdownCanvasSchema>>()
  expectTypeOf<WorkspaceTreeNodeData>().toEqualTypeOf<z.infer<typeof workspaceTreeNodeDataSchema>>()
  expectTypeOf<WorkspaceMeta>().toEqualTypeOf<z.infer<typeof workspaceMetaSchema>>()
})

it('mdast: the lazy recursive schema stays typed as MdastNode, not any', () => {
  expectTypeOf(mdastNodeSchema).toEqualTypeOf<z.ZodType<MdastNode>>()
  expectTypeOf<z.infer<typeof mdastNodeSchema>>().not.toBeAny()
})
