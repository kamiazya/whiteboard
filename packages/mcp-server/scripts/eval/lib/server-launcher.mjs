// Starts the MCP server from source, for a client that cannot resolve `tsx`
// itself: the claude CLI launches whatever `mcp-config` names from ITS
// working directory, which the eval keeps empty on purpose (a repo checkout
// there would put this repo's own instructions in the model's context and
// name the tools it is being tested on). `tsx` resolves from here, where it
// is installed, and the entry is addressed by an absolute path.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'tsx/esm/api'

register()
const here = dirname(fileURLToPath(import.meta.url))
// The entry serves only when it is the process's direct entry point, so an
// import has to start it by hand.
const { main } = await import(resolve(here, '../../../src/server/mcp/index.ts'))
await main()
