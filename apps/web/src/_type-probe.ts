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
 */

// ── shadcn ui primitives ──────────────────────────────────────────────────────
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// ── browser-contract types from the package subpath ──────────────────────────
import type {
  CanvasBackend,
  CanvasBackendHandlers,
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'

// Ensure the types are used so tsc does not elide the import.
declare function _useBackend(b: CanvasBackend): void
declare function _useHandlers(h: CanvasBackendHandlers): void
declare function _usePayload(p: VersionCreatedPayload): void
declare const _btn: typeof Button
declare const _dialog: typeof Dialog
declare const _dialogContent: typeof DialogContent
declare const _dialogHeader: typeof DialogHeader
declare const _dialogTitle: typeof DialogTitle
declare const _alertDialog: typeof AlertDialog
declare const _alertDialogContent: typeof AlertDialogContent
declare const _dropdownMenu: typeof DropdownMenu
declare const _dropdownMenuContent: typeof DropdownMenuContent
declare const _dropdownMenuItem: typeof DropdownMenuItem
declare const _input: typeof Input
declare const _scrollArea: typeof ScrollArea
declare const _separator: typeof Separator
declare const _tooltip: typeof Tooltip
declare const _tooltipContent: typeof TooltipContent
declare const _tooltipTrigger: typeof TooltipTrigger
declare const _cn: typeof cn

// Satisfy noUnusedLocals
export {
  _useBackend,
  _useHandlers,
  _usePayload,
  _btn,
  _dialog,
  _dialogContent,
  _dialogHeader,
  _dialogTitle,
  _alertDialog,
  _alertDialogContent,
  _dropdownMenu,
  _dropdownMenuContent,
  _dropdownMenuItem,
  _input,
  _scrollArea,
  _separator,
  _tooltip,
  _tooltipContent,
  _tooltipTrigger,
  _cn,
}
