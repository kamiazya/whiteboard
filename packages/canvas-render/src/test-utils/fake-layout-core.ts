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
