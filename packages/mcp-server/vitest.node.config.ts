import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineProject, mergeConfig } from 'vitest/config'
import sharedConfig from './vitest.shared.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Where this project's tests are allowed to keep state.
 *
 * `getDataDir()` falls back to `~/.whiteboard` when `WHITEBOARD_DATA_DIR` is
 * unset, and enough of this suite boots the server to run migrations against
 * whatever lives there — the developer's REAL database, shared with anything
 * on the machine that uses the default. `.mcp.json` registers the PUBLISHED
 * `@kamiazya/whiteboard-mcp@latest`, which does exactly that with the
 * migration set of its own release, so this checkout then finds a migration
 * history it does not recognise and the whole run dies with unhandled
 * `IncompatibleDatabaseError` rejections while every test passes.
 *
 * The repo's own dev daemons already avoid this: `with-dev-data-dir` points
 * them at a per-worktree `<repoRoot>/.dev-data` so parallel lanes cannot
 * corrupt each other. This mirrors that for tests — inside the checkout
 * rather than an OS temp dir, so two worktrees can run their suites at the
 * same time without sharing a database. `globalSetup` empties it before every
 * run so a database migrated by an older branch never outlives a branch
 * switch.
 */
export const MCP_NODE_DATA_DIR = resolve(__dirname, 'tmp/test-data-dir')

export default mergeConfig(
  sharedConfig,
  defineProject({
    test: {
      name: 'mcp-node',
      include: [
        'src/daemon/**/*.test.ts',
        'src/di/**/*.test.ts',
        'src/server/**/*.test.ts',
        'src/shared/**/*.test.ts',
        'src/cli/**/*.test.ts',
        // Local dev-tooling tests colocated with the scripts they cover
        // (e.g. the ensure-http-dev-daemon SessionStart hook helper).
        'scripts/**/*.test.ts',
        // Guards this project's own data-dir isolation.
        'vitest-data-dir.test.ts',
      ],
      exclude: ['src/**/*.smoke.test.ts', 'src/**/*.distribution.test.ts'],
      environment: 'node',
      // Several mcp-node tests stand up a full createApp + MCP client + JSON-RPC
      // roundtrip in one case, which on slower CI runners flirts with vitest's
      // 5s default. 10s leaves slack for cold-start migrations + handler dispatch
      // without masking real hangs.
      testTimeout: 10_000,
      hookTimeout: 10_000,
      env: { WHITEBOARD_DATA_DIR: MCP_NODE_DATA_DIR },
      globalSetup: ['./vitest.data-dir-setup.ts'],
    },
  }),
)
