import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '@kamiazya/whiteboard-canvas-model/internal'

/**
 * remark/mdast-util nodes carry `position`, and extension-specific nodes
 * (gfm/math) carry extra bookkeeping fields (`checked`, `data`, ...) this
 * package doesn't model. Rather than typing against `@types/mdast` (a
 * dependency this package otherwise has no need for), every remark node is
 * treated as an untyped record and narrowed by its `type` tag — the model
 * schemas (`mdastRootSchema` et al.) are the actual structural contract;
 * this converter only needs to strip the extra remark-only fields down to
 * that contract.
 */
type RemarkNode = { type: string; children?: RemarkNode[]; [key: string]: unknown }

function toPhrasing(node: RemarkNode): MdastPhrasingContent {
  switch (node.type) {
    case 'text':
      return { type: 'text', value: String(node.value ?? '') }
    case 'inlineCode':
      return { type: 'inlineCode', value: String(node.value ?? '') }
    case 'break':
      return { type: 'break' }
    case 'html':
      return { type: 'html', value: String(node.value ?? '') }
    case 'inlineMath':
      return { type: 'inlineMath', value: String(node.value ?? '') }
    case 'emphasis':
      return { type: 'emphasis', children: (node.children ?? []).map(toPhrasing) }
    case 'strong':
      return { type: 'strong', children: (node.children ?? []).map(toPhrasing) }
    case 'delete':
      return { type: 'delete', children: (node.children ?? []).map(toPhrasing) }
    case 'link':
      return {
        type: 'link',
        url: String(node.url ?? ''),
        title: (node.title as string | null | undefined) ?? undefined,
        children: (node.children ?? []).map(toPhrasing),
      }
    case 'image':
      return {
        type: 'image',
        url: String(node.url ?? ''),
        title: (node.title as string | null | undefined) ?? undefined,
        alt: (node.alt as string | null | undefined) ?? undefined,
      }
    case 'linkReference':
      return {
        type: 'linkReference',
        identifier: String(node.identifier ?? ''),
        label: (node.label as string | null | undefined) ?? undefined,
        referenceType: node.referenceType as 'shortcut' | 'collapsed' | 'full',
        children: (node.children ?? []).map(toPhrasing),
      }
    case 'imageReference':
      return {
        type: 'imageReference',
        identifier: String(node.identifier ?? ''),
        label: (node.label as string | null | undefined) ?? undefined,
        referenceType: node.referenceType as 'shortcut' | 'collapsed' | 'full',
        alt: (node.alt as string | null | undefined) ?? undefined,
      }
    default:
      // Unrecognized node kinds degrade to their textual content rather than
      // being silently dropped (data loss the round-trip property would
      // otherwise mask).
      return { type: 'text', value: String(node.value ?? '') }
  }
}

function toCellPhrasing(node: RemarkNode): MdastCellPhrasingContent {
  const phrasing = toPhrasing(node)
  return phrasing as MdastCellPhrasingContent
}

function toFlow(node: RemarkNode): MdastFlowContent {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', children: (node.children ?? []).map(toPhrasing) }
    case 'heading':
      return {
        type: 'heading',
        depth: node.depth as 1 | 2 | 3 | 4 | 5 | 6,
        children: (node.children ?? []).map(toPhrasing),
      }
    case 'blockquote':
      return { type: 'blockquote', children: (node.children ?? []).map(toFlow) }
    case 'list':
      return {
        type: 'list',
        ordered: node.ordered as boolean | undefined,
        start: node.start as number | undefined,
        spread: node.spread as boolean | undefined,
        children: (node.children ?? []).map(toListItem),
      }
    case 'code':
      return {
        type: 'code',
        value: String(node.value ?? ''),
        lang: (node.lang as string | null | undefined) ?? undefined,
        meta: (node.meta as string | null | undefined) ?? undefined,
      }
    case 'html':
      return { type: 'html', value: String(node.value ?? '') }
    case 'thematicBreak':
      return { type: 'thematicBreak' }
    case 'definition':
      return {
        type: 'definition',
        identifier: String(node.identifier ?? ''),
        label: (node.label as string | null | undefined) ?? undefined,
        url: String(node.url ?? ''),
        title: (node.title as string | null | undefined) ?? undefined,
      }
    case 'table':
      return {
        type: 'table',
        align: node.align as ('left' | 'right' | 'center' | null)[] | undefined,
        children: (node.children ?? []).map(toTableRow),
      }
    case 'math':
      return {
        type: 'math',
        value: String(node.value ?? ''),
        meta: (node.meta as string | null | undefined) ?? undefined,
      }
    default:
      return { type: 'paragraph', children: [{ type: 'text', value: String(node.value ?? '') }] }
  }
}

function toListItem(node: RemarkNode): MdastListItem {
  return {
    type: 'listItem',
    checked: node.checked as boolean | null | undefined,
    spread: node.spread as boolean | undefined,
    children: (node.children ?? []).map(toFlow),
  }
}

function toTableRow(node: RemarkNode): MdastTableRow {
  return { type: 'tableRow', children: (node.children ?? []).map(toTableCell) }
}

function toTableCell(node: RemarkNode): MdastTableCell {
  return { type: 'tableCell', children: (node.children ?? []).map(toCellPhrasing) }
}

/** Converts a raw remark/mdast-util Root into the canvas-model MdastRoot subset. */
export function fromRemarkRoot(root: RemarkNode): MdastRoot {
  return { type: 'root', children: (root.children ?? []).map(toFlow) }
}
