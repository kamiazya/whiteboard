import { installSearchCore, searchCoreInstalled } from '@kamiazya/whiteboard-search'
import { installLayoutCore } from './spatial/layout-core.js'

/**
 * Settles once this realm answers search: `@kamiazya/whiteboard-search` has no
 * TypeScript behind it, so a caller that can wait awaits this before its first
 * call. It joins the load the page starts at boot (`page-layout-core.ts`), one
 * wasm instance for layout, codecs and search, so it costs nothing a realm that
 * lays out has not already paid; a realm whose core is already installed (a
 * test realm) returns at once, and a load that fails rejects.
 */
export async function searchReady(): Promise<void> {
  if (searchCoreInstalled()) return
  const core = await installLayoutCore().codecs()
  if (!searchCoreInstalled()) installSearchCore(core.search)
}
