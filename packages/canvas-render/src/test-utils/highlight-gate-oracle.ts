import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { highlightCode } from '../highlight/lowlight.js'
import type { TokenizerBudget } from '../highlight/tokenizer-budget.js'

/**
 * Inputs and answers of `highlightCode`'s gate: whether the default
 * highlighter colours a fence, and what it spent of a layout's tokenizer
 * account doing so. The core decides which fences to ask the host for by
 * this gate, so it is held to the TypeScript's answer here, tokens aside.
 *
 * A value is written as pieces, each a text and how often it repeats, so a
 * fence at a budget's edge stays a short line in the recording.
 */
export interface HighlightGateRecord {
  readonly id: string
  readonly lang: string
  readonly value: readonly (readonly [string, number])[]
  /** The account before the call; null calls without one. */
  readonly budget: Account | null
  readonly colours: boolean
  readonly after: Account | null
}

interface Account {
  readonly word: number
  readonly line: number
  readonly refused: number
}

type Input = Omit<HighlightGateRecord, 'colours' | 'after'>

const GRAMMARS = { bash, css, javascript, json, markdown, python, typescript, xml, yaml }

/** Every name a fence can reach a grammar by: its own, and the aliases the grammar declares. */
function grammarNames(): string[] {
  return Object.entries(GRAMMARS).flatMap(([name, grammar]) => [
    name,
    ...(grammar(hljs).aliases ?? []),
  ])
}

/** The aliases `lowlight.ts` adds, the grammars' own, case variants, and names that are none. */
function langs(): string[] {
  const own = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'sh', 'shell', 'zsh', 'py', 'md', 'html', 'svg']
  const names = [...grammarNames(), ...own, 'yml']
  return [
    ...names,
    ...names.map((name) => name.toUpperCase()),
    'Shell',
    'YmL',
    // KELVIN SIGN lower-cases to an ASCII k.
    'marKdown',
    // DOTTED CAPITAL I lower-cases to two code points.
    'İ',
    '',
    ' js',
    'js ',
    'text',
    'rust',
    'mermaid',
    'c++',
    'constructor',
    '__proto__',
    'hasOwnProperty',
    'toString',
  ]
}

const word = (n: number): [string, number] => ['a', n]

/** Values around each price: a word run, several, a yaml line, units past the BMP, breakers. */
function values(): (readonly [string, number])[][] {
  return [
    [['let x = 1', 1]],
    [],
    [word(4095)],
    [word(4096)],
    [word(4097)],
    [
      ['_$9', 1365],
      ['Z', 1],
    ],
    [['_$9', 1366]],
    [word(2896), [' ', 1], word(2896)],
    [word(2897), [' ', 1], word(2897)],
    [word(4096), ['é', 1], word(1)],
    [word(3000), ['-', 1], word(3000)],
    [
      ['ab ', 2730],
      ['ab', 1],
    ],
    [['ab ', 2731]],
    [
      ['ab ', 2730],
      ['ab', 1],
      ['\n', 1],
      ['ab ', 2731],
    ],
    [
      ['ab ', 2730],
      ['😀', 1],
    ],
    [
      ['ab ', 2730],
      ['😀', 1],
      ['a', 1],
    ],
    [
      ['ab ', 2730],
      ['\r', 2],
      ['a', 1],
    ],
    [['x: 1\n', 3000]],
  ]
}

const fresh = (): Account => ({ word: 4 * 4096 * 4096, line: 4 * 8192 * 8192, refused: 0 })

/** The accounts a call is made against: none, a fresh one, and ones a fence nearly or fully spent. */
const ACCOUNTS: readonly (Account | null)[] = [
  null,
  fresh(),
  { word: 4096 * 4096, line: 8192 * 8192, refused: 2 },
  { word: 4096 * 4096 - 1, line: 8192 * 8192, refused: 0 },
  { word: 4096 * 4096, line: 8192 * 8192 - 1, refused: 1 },
  { word: 8, line: 1, refused: 0 },
  { word: 0, line: 0, refused: 5 },
]

export function highlightGateInputs(): Input[] {
  const inputs: Input[] = []
  for (const lang of langs()) {
    inputs.push({
      id: `lang ${JSON.stringify(lang)}`,
      lang,
      value: [['let x = 1', 1]],
      budget: null,
    })
  }
  for (const lang of ['js', 'yaml', 'YML', 'json', 'css', 'nope']) {
    for (const [v, value] of values().entries()) {
      for (const [a, budget] of ACCOUNTS.entries()) {
        inputs.push({ id: `${lang} value ${v} account ${a}`, lang, value, budget })
      }
    }
  }
  return inputs
}

const textOf = (value: Input['value']): string =>
  value.map(([piece, repeat]) => piece.repeat(repeat)).join('')

/** What the TypeScript answers for one input. A throw is a fence drawn plain, as the layout draws it. */
export function highlightGateAnswer(input: Input): HighlightGateRecord {
  const budget: TokenizerBudget | undefined =
    input.budget === null
      ? undefined
      : {
          wordRunsRemaining: input.budget.word,
          lineRunsRemaining: input.budget.line,
          refused: input.budget.refused,
        }
  let colours: boolean
  try {
    colours = highlightCode(input.lang, textOf(input.value), budget) !== undefined
  } catch {
    colours = false
  }
  const after =
    budget === undefined
      ? null
      : { word: budget.wordRunsRemaining, line: budget.lineRunsRemaining, refused: budget.refused }
  return {
    id: input.id,
    lang: input.lang,
    value: input.value,
    budget: input.budget,
    colours,
    after,
  }
}
