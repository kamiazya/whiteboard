import type { LayoutCore } from '../layout-core.js'

const unasked = (entry: string) => () => {
  throw new Error(`the core's ${entry} is not asked here`)
}

/**
 * A `LayoutCore` answering through `parts`, every entry it leaves out
 * throwing when asked: a test hands the core only what it means to be asked.
 */
export function fakeLayoutCore(parts: Partial<LayoutCore>): LayoutCore {
  return {
    routing: parts.routing ?? { routeLayout: unasked('routing') },
    layout: parts.layout ?? { layoutSpatialCanvas: unasked('layout') },
    markdown: parts.markdown ?? { layoutMarkdown: unasked('markdown') },
    query: parts.query ?? { layoutQuery: unasked('query') },
  }
}

/**
 * What a fake core draws for a request: nothing when the request asks no
 * picture, else `content` inside a document root, in the form the request
 * asked — the plain document, or the keyed projection with `content` as its
 * one group. A real core draws the scene it laid out; a fake one only has to
 * answer in the shape the asking side reads.
 */
export function fakePicture(
  request: { readonly svg?: { readonly form?: 'keyed' } },
  content: string,
):
  | Record<never, never>
  | { readonly svg: string }
  | {
      readonly keyed: {
        readonly svg: string
        readonly rootOpen: string
        readonly rootAttrs: Readonly<Record<string, string>>
        readonly groups: readonly { readonly key: string; readonly svg: string }[]
      }
    } {
  if (request.svg === undefined) return {}
  const rootOpen = '<svg xmlns="http://www.w3.org/2000/svg">'
  const svg = `${rootOpen}${content}</svg>`
  if (request.svg.form !== 'keyed') return { svg }
  return {
    keyed: {
      svg,
      rootOpen,
      rootAttrs: { xmlns: 'http://www.w3.org/2000/svg' },
      groups: [{ key: 'fake', svg: content }],
    },
  }
}
