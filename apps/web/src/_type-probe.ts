/**
 * Type-presence probe: tsc --noEmit fails before the copied shadcn
 * components and the browser-contract package exports exist, and passes
 * after. This file is never imported at runtime — it is a compile-time
 * regression guard only.
 *
 * Criteria covered:
 * - Copied shadcn ui primitives (Button, Dialog, etc.) resolve under @/components/ui
 * - cn from @/lib/utils resolves
 * - CanvasBackend, CanvasBackendHandlers, and ws-message payload types
 *   resolve from @kamiazya/whiteboard-mcp/browser-contract and compile
 *   against the z.infer-derived payload types.
 * - DaemonBackend resolves from the ./daemon-backend subpath and its
 *   relocated source compiles under this DOM-enabled tsconfig too.
 */

// ── browser-contract types from the package subpath ──────────────────────────
// Re-exporting the types proves they resolve; the declared consumers below
// force tsc to compile against the z.infer-derived payload shapes.
export type {
  CanvasBackend,
  CanvasBackendHandlers,
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'

// ── daemon-backend from its own subpath ───────────────────────────────────────
export type { DaemonBackend } from '@kamiazya/whiteboard-mcp/daemon-backend'

// ── shadcn ui primitives ──────────────────────────────────────────────────────
// Re-exporting the value imports both proves they resolve and satisfies
// noUnusedLocals without a parallel declare/export block.
export { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog'
export { Button } from '@/components/ui/button'
export {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
export { Input } from '@/components/ui/input'
export { ScrollArea } from '@/components/ui/scroll-area'
export { Separator } from '@/components/ui/separator'
export {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
export { cn } from '@/lib/utils'

import type {
  CanvasBackend,
  CanvasBackendHandlers,
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'

export declare function _useBackend(b: CanvasBackend): void
export declare function _useHandlers(h: CanvasBackendHandlers): void
export declare function _usePayload(p: VersionCreatedPayload): void

// ── api-client from its own subpath ───────────────────────────────────────────
import type { RuntimeConfig } from '@kamiazya/whiteboard-mcp/api-client'

export { apiFetch } from '@kamiazya/whiteboard-mcp/api-client'
export declare function _useRuntimeConfig(c: RuntimeConfig): void

// ── api-contracts barrel: proves the branches + canvas Zod schemas resolve
// and z.infer-derived types compile under this DOM-enabled tsconfig too ─────
export { branchMetaSchema, createCanvasRequestSchema } from '@kamiazya/whiteboard-mcp/api-contracts'

import type {
  branchMetaSchema,
  createCanvasRequestSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import type { z } from 'zod'
export declare function _useBranchMeta(b: z.infer<typeof branchMetaSchema>): void
export declare function _useCreateDocumentRequest(
  r: z.infer<typeof createCanvasRequestSchema>,
): void
