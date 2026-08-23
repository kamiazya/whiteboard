// The default implementation of this package's own `highlightCode` seam.
//
// Lives behind the `/highlight` subpath, not the barrel: the seam exists so a
// caller can supply any tokeniser, and the main entry must not drag a
// highlighter into a consumer that renders no code. Three surfaces need the
// same one — the editor, the read-only viewer (and through it the MCP Apps
// widget), and export — and canvas-render is the only package all three can
// see, so a shared default beats the same table written out three times.
//
// lowlight (highlight.js) rather than shiki, decided by measurement: for the
// same six languages and the same five roles, shiki's smallest viable build
// is 106 KB gzip against lowlight's 15 KB, and tokenising one 27-line block
// costs 3.3-4.2ms against 0.39ms — where laying out the ENTIRE wrapping
// corpus, 21 documents, costs 4.9ms. shiki's theme system was the reason to
// prefer it and measured worst of all: a five-role theme paints TypeScript's
// `:` and every operator as a keyword, because `keyword` prefix-matches
// `keyword.operator.*`. highlight.js emits `hljs-keyword`/`hljs-string`/…
// classes that ARE roles already, so the map below is right by inspection.
//
// The seam carries roles, never colours: the palette belongs to
// canvas-render's one appearance producer, which holds the contrast floors.

import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { createLowlight } from 'lowlight'
import type { CodeTokenLines, CodeTokenRole } from '../layout/nodes/mdast-blocks.js'

// Registered eagerly and never on demand: a fence's language is only known
// mid-layout, and layout is synchronous — an await there would either block
// it or paint the block twice.
const lowlight = createLowlight({
  bash,
  css,
  javascript,
  json,
  markdown,
  python,
  typescript,
  xml,
  yaml,
})

/** Aliases people actually write in a fence, mapped to a registered grammar. */
const ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  md: 'markdown',
  html: 'xml',
  svg: 'xml',
  yml: 'yaml',
}

/**
 * highlight.js class -> role. Everything unlisted is plain, which is the
 * point of a five-role palette: at 10-12px inside a node, finer resolution
 * is discarded on the way out.
 */
const ROLE_BY_CLASS: Readonly<Record<string, CodeTokenRole>> = {
  'hljs-comment': 'comment',
  'hljs-quote': 'comment',
  'hljs-keyword': 'keyword',
  'hljs-built_in': 'keyword',
  'hljs-type': 'keyword',
  'hljs-selector-tag': 'keyword',
  'hljs-tag': 'keyword',
  'hljs-name': 'keyword',
  'hljs-string': 'string',
  'hljs-regexp': 'string',
  'hljs-attr': 'string',
  'hljs-number': 'number',
  'hljs-literal': 'number',
  'hljs-symbol': 'number',
}

interface HastNode {
  readonly type: string
  readonly value?: string
  readonly properties?: { readonly className?: readonly string[] }
  readonly children?: readonly HastNode[]
}

function roleOf(node: HastNode): CodeTokenRole | undefined {
  for (const name of node.properties?.className ?? []) {
    const role = ROLE_BY_CLASS[name]
    if (role !== undefined) return role
  }
  return undefined
}

/**
 * Flattens hast to (text, role) pairs, then splits on newlines so the result
 * is one array per SOURCE line — the shape the seam asks for, and the shape
 * that lets canvas-render reject a tokenisation whose line count disagrees
 * with the fence it came from.
 */
function toLines(tree: HastNode): CodeTokenLines {
  const lines: { text: string; role?: CodeTokenRole }[][] = [[]]
  const push = (text: string, role: CodeTokenRole | undefined) => {
    const parts = text.split('\n')
    for (const [index, part] of parts.entries()) {
      if (index > 0) lines.push([])
      if (part === '') continue
      lines[lines.length - 1]?.push(role === undefined ? { text: part } : { text: part, role })
    }
  }
  const visit = (node: HastNode, inherited: CodeTokenRole | undefined) => {
    if (node.type === 'text') return push(node.value ?? '', inherited)
    const role = roleOf(node) ?? inherited
    for (const child of node.children ?? []) visit(child, role)
  }
  visit(tree, undefined)
  return lines
}

/**
 * canvas-render's `highlightCode` seam. Total: an unregistered language or
 * anything lowlight throws returns `undefined`, and the fence renders plain.
 */
export function highlightCode(lang: string, value: string): CodeTokenLines | undefined {
  const name = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()
  if (name === '' || !lowlight.registered(name)) return undefined
  try {
    return toLines(lowlight.highlight(name, value) as unknown as HastNode)
  } catch {
    return undefined
  }
}
