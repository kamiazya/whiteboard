import { defineConfig } from 'tsdown'

// rolldown + the tsgo dts generator, which is what lets this package's
// published .d.ts be emitted under TypeScript 7 at all — tsup vendors a
// rollup-plugin-dts that needs the JS compiler API TS7 removed.
export default defineConfig({
  entry: {
    'server/mcp/index': 'src/server/mcp/index.ts',
    'server/mcp/stdio': 'src/server/mcp/stdio.ts',
    'server/index': 'src/server/index.ts',
    'server/daemon-entry': 'src/server/daemon-entry.ts',
    'server/app': 'src/server/app.ts',
    'server/backup-restore': 'src/server/backup-restore.ts',
    // The server-mode variant of the entry above. It was reachable only as a
    // hashed chunk inside cli/index.js, so `dist/server/server-mode-backup-restore.js`
    // — the path packaged-server-mode-backup-restore-smoke.mjs imports — did
    // not exist after any build, and that smoke could not pass on any machine.
    // It runs only on the release path, so its precondition check had never
    // been reached.
    'server/server-mode-backup-restore': 'src/server/server-mode-backup-restore.ts',
    'server/security/server-mode-auth-plan': 'src/server/security/server-mode-auth-plan.ts',
    'shared/data-dir-secure': 'src/shared/data-dir-secure.ts',
    'shared/package-version': 'src/shared/package-version.ts',
    'server/export/headless-renderer': 'src/server/export/headless-renderer.ts',
    'cli/index': 'src/cli/index.ts',
  },
  outDir: 'dist',
  // Deliberately NOT tsconfig.server.json. rolldown-plugin-dts passes
  // `--rootDir path.dirname(tsconfig)` to tsgo, so the tsconfig has to sit
  // above every source the types are rolled up from — and `noExternal` below
  // pulls eleven sibling workspace packages into this dist. From mcp-server's own
  // directory their files are outside rootDir and tsgo refuses to emit for them.
  tsconfig: '../tsconfig.mcp-dts.json',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  dts: true,
  clean: true,
  // package.json's exports, the bin, and the packaged smokes all name `.js`.
  // tsdown defaults ESM to `.mjs`; this package is `"type": "module"`, so `.js`
  // already means ESM and the default would rename every published path.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  external: ['yaml'],
  noExternal: [
    '@kamiazya/whiteboard-daemon-client',
    '@kamiazya/whiteboard-history',
    '@kamiazya/whiteboard-model',
    '@kamiazya/whiteboard-codec',
    '@kamiazya/whiteboard-canvas-render',
    '@kamiazya/whiteboard-ports',
    '@kamiazya/whiteboard-loro-adapter',
    '@kamiazya/whiteboard-server-core',
    // Composing a plugin set is this root's job (ADR-0013 decision 3), so
    // the engine and the bundled plugin are its own imports now rather than
    // only server-core's transitive ones.
    '@kamiazya/whiteboard-facet-engine',
    '@kamiazya/whiteboard-plugin-visual',
    '@kamiazya/whiteboard-workspace-index',
  ],
})
