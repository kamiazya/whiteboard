/**
 * Type-presence probe: tsc --noEmit fails before the copied shadcn
 * components and the browser-contract package exports exist, and passes
 * after. This file is never imported at runtime — it is a compile-time
 * regression guard only.
 *
 * Criteria covered:
 * - Copied shadcn ui primitives (Button, Dialog, etc.) resolve under @/components/ui
 * - cn from @/lib/utils resolves
 * - DocumentBackend, DocumentBackendHandlers, and ws-message payload types
 *   resolve from @kamiazya/whiteboard-daemon-client/document-backend-contract and compile
 *   against the z.infer-derived payload types.
 * - DaemonBackend resolves from the ./daemon-backend subpath and its
 *   relocated source compiles under this DOM-enabled tsconfig too.
 */

// ── daemon-backend from its own subpath ───────────────────────────────────────
export type { DaemonBackend } from '@kamiazya/whiteboard-daemon-client/daemon-backend'
// ── browser-contract types from the package subpath ──────────────────────────
// Re-exporting the types proves they resolve; the declared consumers below
// force tsc to compile against the z.infer-derived payload shapes.
export type {
  DocumentBackend,
  DocumentBackendHandlers,
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'

// ── shadcn ui primitives ──────────────────────────────────────────────────────
// Re-exporting the value imports both proves they resolve and satisfies
// noUnusedLocals without a parallel declare/export block.
export { AlertDialog, AlertDialogContent } from './components/ui/alert-dialog.js'
export { Button } from './components/ui/button.js'
export {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from './components/ui/dropdown-menu.js'
export { Input } from './components/ui/input.js'
export { ScrollArea } from './components/ui/scroll-area.js'
export { Separator } from './components/ui/separator.js'
export {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './components/ui/tooltip.js'
export { cn } from './lib/utils.js'

import type {
  DocumentBackend,
  DocumentBackendHandlers,
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'

export declare function _useBackend(b: DocumentBackend): void
export declare function _useHandlers(h: DocumentBackendHandlers): void
export declare function _usePayload(p: VersionCreatedPayload): void

// ── api-client from its own subpath ───────────────────────────────────────────
import type { RuntimeConfig } from '@kamiazya/whiteboard-daemon-client/api-client'

export { apiFetch } from '@kamiazya/whiteboard-daemon-client/api-client'
export declare function _useRuntimeConfig(c: RuntimeConfig): void

// ── api-contracts barrel: proves the branches + canvas Zod schemas resolve
// and z.infer-derived types compile under this DOM-enabled tsconfig too ─────
export {
  branchMetaSchema,
  createDocumentRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'

import type {
  branchMetaSchema,
  createDocumentRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { z } from 'zod'
export declare function _useBranchMeta(b: z.infer<typeof branchMetaSchema>): void
export declare function _useCreateDocumentRequest(
  r: z.infer<typeof createDocumentRequestSchema>,
): void
