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
import type { CodeTokenLines, CodeTokenRole } from './code-token.js'
import { spendTokenizer, type TokenizerBudget } from './tokenizer-budget.js'

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
 * highlight.js re-scans a run its grammar cannot settle from each of its
 * positions, so tokenising costs the SQUARE of that run's length, summed over
 * runs. In javascript, typescript and bash the run is an identifier-like
 * `[A-Za-z0-9_]` stretch (`$`, punctuation, whitespace and non-ASCII letters
 * all end it); in yaml it is a whole line, spaces included. On one machine a
 * 32 Ki-character identifier cost 2.9s (javascript), 6.1s (typescript) and
 * 1.1s (bash), and a 32 Ki-character yaml line of words 0.7-0.9s — inside
 * synchronous layout, while ordinary code of 256 Ki characters costs ~200ms.
 *
 * So the fence is priced first, in one linear pass, and one over budget
 * renders plain — the path an unregistered language already takes. `$` is
 * counted although it measured as a breaker: over-counting can only render
 * a pathological fence plain, never a slow one highlighted.
 */
const WORD_RUN = /[A-Za-z0-9_$]+/g
const LINE_RUN = /[^\n]+/g

/**
 * 4096^2 squared characters: one 4096-character identifier, about 95ms in
 * typescript (the most expensive grammar) and 50ms in javascript. No real
 * identifier comes near it, so ordinary code of any length stays coloured.
 */
const WORD_RUN_BUDGET = 4096 * 4096

/**
 * yaml's per-squared-character cost measured ~7x below typescript's, so
 * 8192^2 holds a yaml fence near 60ms while a 256 Ki body of 256-character
 * lines still highlights.
 */
const LINE_RUN_BUDGET = 8192 * 8192

/** Grammars whose cost is quadratic in a whole LINE, not just in a word. */
const LINE_PRICED = new Set(['yaml'])

/**
 * The summed squared length of `value`'s runs, stopping as soon as it passes
 * `cap` — so a pathological fence is priced in the time it takes to find it
 * over budget, not in the time it takes to count all of it.
 */
function runCost(value: string, run: RegExp, cap: number): number {
  let total = 0
  for (const match of value.matchAll(run)) {
    total += match[0].length ** 2
    if (total > cap) return total
  }
  return total
}

/**
 * canvas-render's `highlightCode` seam. Total: an unregistered language, a
 * fence over the tokeniser's cost budget, a fence the layout's `budget`
 * cannot cover, or anything lowlight throws returns `undefined`, and the
 * fence renders plain.
 */
export function highlightCode(
  lang: string,
  value: string,
  budget?: TokenizerBudget,
): CodeTokenLines | undefined {
  const name = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()
  if (name === '' || !lowlight.registered(name)) return undefined
  const words = runCost(value, WORD_RUN, WORD_RUN_BUDGET)
  if (words > WORD_RUN_BUDGET) return undefined
  const lines = LINE_PRICED.has(name) ? runCost(value, LINE_RUN, LINE_RUN_BUDGET) : 0
  if (lines > LINE_RUN_BUDGET) return undefined
  if (budget !== undefined && !spendTokenizer(budget, words, lines)) return undefined
  try {
    return toLines(lowlight.highlight(name, value) as unknown as HastNode)
  } catch {
    return undefined
  }
}
