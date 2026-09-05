import { defineConfig } from 'tsup'

// Decision B: the private @kamiazya/whiteboard-* workspace packages are bundled
// INTO this package's dist via noExternal, so `npx @kamiazya/whiteboard-mcp`
// does not 404 on unpublished workspace deps. Everything else stays external.
//
// splitting MUST stay on. Three modules compute paths from import.meta.url and
// assume their canonical dist location:
//   - shared/data-dir-secure.ts  (WHITEBOARD_ROOT = dist/.. → package root)
//   - shared/package-version.ts  (require('../../package.json'))
//   - server/export/headless-renderer.ts (bundled-font lookup under dist/assets/fonts/Roboto)
// With splitting off, esbuild would inline them into deeper entries (e.g.
// dist/server/mcp/index.js) where the relative offsets resolve wrong and break
// widget/web-app/font resolution at runtime. Declaring them as entries + code
// splitting keeps each at its canonical path so import.meta.url stays correct.
export default defineConfig({
  entry: {
    'server/mcp/index': 'src/server/mcp/index.ts',
    'server/index': 'src/server/index.ts',
    'server/app': 'src/server/app.ts',
    'server/backup-restore': 'src/server/backup-restore.ts',
    'server/security/server-mode-auth-plan': 'src/server/security/server-mode-auth-plan.ts',
    'shared/document-backend-contract': 'src/shared/document-backend-contract.ts',
    'shared/browser-shared-index': 'src/shared/browser-shared-index.ts',
    'shared/daemon-backend': 'src/shared/daemon-backend.ts',
    'shared/sse-backend': 'src/shared/sse-backend.ts',
    'shared/sse-stream-hub': 'src/shared/sse-stream-hub.ts',
    'shared/select-document-transport': 'src/shared/select-document-transport.ts',
    'shared/api-client': 'src/shared/api-client.ts',
    'shared/api-contracts/index': 'src/shared/api-contracts/index.ts',
    'shared/api-contracts/runtime': 'src/shared/api-contracts/runtime.ts',
    'shared/data-dir-secure': 'src/shared/data-dir-secure.ts',
    'shared/package-version': 'src/shared/package-version.ts',
    'server/export/headless-renderer': 'src/server/export/headless-renderer.ts',
    'cli/index': 'src/cli/index.ts',
  },
  outDir: 'dist',
  tsconfig: 'tsconfig.server.json',
  format: 'esm',
  target: 'node22',
  platform: 'node',
  splitting: true,
  sourcemap: true,
  // A root tsconfig in the graph still declares the (now-deprecated) `baseUrl`;
  // the TS build used for .d.ts emit errors on it under TS 6+. Silence it here
  // rather than churn a shared root config.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  clean: true,
  // yaml is CJS; bundling it into ESM triggers `require("process")` failures.
  // Keep it external and list it in dependencies so npx finds it at runtime.
  external: ['yaml'],
  noExternal: [
    '@kamiazya/whiteboard-daemon-client',
    '@kamiazya/whiteboard-model',
    '@kamiazya/whiteboard-codec',
    '@kamiazya/whiteboard-canvas-render',
    '@kamiazya/whiteboard-ports',
    '@kamiazya/whiteboard-loro-adapter',
    '@kamiazya/whiteboard-server-core',
    '@kamiazya/whiteboard-workspace-index',
  ],
})
