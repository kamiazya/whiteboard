// Package version source-of-truth. Read at runtime so release-please bumps to package.json
// propagate without source edits.
//
// `createRequire` sidesteps `tsconfig.server.json` rootDir restrictions (package.json is
// outside src/) and works the same way under tsx (dev) and node (built dist).
//
// Path resolution: `../../package.json` is correct from both
//   src/shared/package-version.ts  → packages/mcp-server/package.json
//   dist/shared/package-version.js → packages/mcp-server/package.json (or
//   node_modules/@kamiazya/whiteboard-mcp/package.json after npm publish)
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

export const PACKAGE_VERSION: string = pkg.version
