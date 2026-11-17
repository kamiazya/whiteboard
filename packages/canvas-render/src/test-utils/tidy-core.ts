import { type TidyNode, tidyNodes as tidyThrough } from '../tidy.js'
import { testLayoutCore } from './test-layout-core.js'

type Options = Omit<Parameters<typeof tidyThrough>[1], 'core'>

/** `tidyNodes` answered by the core a Node test loads, as the tidy suites call it. */
export function tidyNodes(
  nodes: readonly TidyNode[],
  options: Options = {},
): ReturnType<typeof tidyThrough> {
  return tidyThrough(nodes, { core: testLayoutCore(), ...options })
}
