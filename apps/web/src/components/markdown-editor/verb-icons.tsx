import {
  Bold,
  Code,
  Heading,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquare,
  Minus,
  Sigma,
  SquareCheck,
  SquareCode,
  Strikethrough,
  Table,
  TextQuote,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { MarkdownVerbId } from './editor-verbs.js'

/**
 * Every verb's glyph, keyed by verb so adding a verb also has to answer
 * "what does it look like?" — `satisfies Record<MarkdownVerbId, …>` fails
 * the build otherwise. Shared by the editing catalog and the touch bar,
 * and kept out of `editor-verbs.ts` on purpose: that file stays React-free
 * so a node test can import the table and drive every verb without a
 * renderer.
 */
export const VERB_ICONS = {
  heading: <Heading aria-hidden className="size-4" />,
  quote: <TextQuote aria-hidden className="size-4" />,
  'code-block': <SquareCode aria-hidden className="size-4" />,
  table: <Table aria-hidden className="size-4" />,
  rule: <Minus aria-hidden className="size-4" />,
  bold: <Bold aria-hidden className="size-4" />,
  italic: <Italic aria-hidden className="size-4" />,
  strikethrough: <Strikethrough aria-hidden className="size-4" />,
  code: <Code aria-hidden className="size-4" />,
  link: <Link2 aria-hidden className="size-4" />,
  comment: <MessageSquare aria-hidden className="size-4" />,
  math: <Sigma aria-hidden className="size-4" />,
  'bullet-list': <List aria-hidden className="size-4" />,
  outdent: <IndentDecrease aria-hidden className="size-4" />,
  indent: <IndentIncrease aria-hidden className="size-4" />,
  'ordered-list': <ListOrdered aria-hidden className="size-4" />,
  'toggle-task': <SquareCheck aria-hidden className="size-4" />,
} satisfies Record<MarkdownVerbId, ReactNode>
