import type { MdastFlowContent, MdastPhrasingContent } from '@kamiazya/whiteboard-model/mdast'

/** The small builders the hand-written corpora are written with. */
export type Block = MdastFlowContent
type Textual = Extract<MdastFlowContent, { type: 'paragraph' | 'heading' }>
export const t = (value: string): MdastPhrasingContent => ({ type: 'text', value })
export const p = (...children: MdastPhrasingContent[]): Textual => ({ type: 'paragraph', children })
export const h = (depth: 1 | 2 | 3 | 4 | 5 | 6, ...children: MdastPhrasingContent[]): Textual => ({
  type: 'heading',
  depth,
  children,
})
export const em = (...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'emphasis',
  children,
})
export const strong = (...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'strong',
  children,
})
export const del = (...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'delete',
  children,
})
export const code = (value: string): MdastPhrasingContent => ({ type: 'inlineCode', value })
export const link = (url: string, ...children: MdastPhrasingContent[]): MdastPhrasingContent => ({
  type: 'link',
  url,
  children,
})

export const ID = '01HZX3Q8K9V2M4N5P6R7S8T9WA'
export const ID2 = '01HZX3Q8K9V2M4N5P6R7S8T9WB'
export const ID3 = '01HZX3Q8K9V2M4N5P6R7S8T9WC'
export const ID4 = '01HZX3Q8K9V2M4N5P6R7S8T9WD'

export const JA =
  'これは日本語の長い文章です。ノードの幅を超えても折り返されるべきですが、実際にどうなるかを測ります。'
export const LONG_EN =
  'This is a fairly long English sentence that should wrap across several lines when the box is narrow.'

/** One block per case, aimed at one rule each. */
export const fence = (value: string, lang?: string): Block => ({
  type: 'code',
  value,
  ...(lang === undefined ? {} : { lang }),
})
