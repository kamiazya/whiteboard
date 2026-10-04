import { expectTypeOf, it } from 'vitest'
import type { ServerModeRunning, StartServerModeHttpOptions } from '../server/server-mode-http.js'
import type { StartServerFn } from './server-run.js'

// Compile-time only (erased at runtime; it fails under `pnpm typecheck`). The
// injection seam must be the real server's own contract: a field the server
// gains and the seam does not hear about is the drift a test double hides.

it('the injected server factory answers with exactly what the real one does', () => {
  expectTypeOf<Awaited<ReturnType<StartServerFn>>>().toEqualTypeOf<ServerModeRunning>()
})

it('the injected server factory takes the real options, less the wiring-test seams', () => {
  expectTypeOf<Parameters<StartServerFn>[0]>().toEqualTypeOf<
    Omit<StartServerModeHttpOptions, 'fileGcSweeperFactory' | 'workspaceTailFactory'>
  >()
})
