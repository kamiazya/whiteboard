#!/usr/bin/env node
// The stdio MCP server from SOURCE, for development — `pnpm mcp` and the
// stdio Inspector. Run under `node --import tsx/esm`.
//
// It opens a store like the daemon does, so it gets the same data dir as
// `pnpm mcp:http:dev`: the checkout's `.dev-data`, never the real
// `~/.whiteboard`, where an unreleased migration would leave the installed
// release refusing to start. An explicit WHITEBOARD_DATA_DIR still wins.
//
// The entry starts unconditionally on import (stdio.ts says why), so the
// variable is set in this process before the import rather than handed to a
// child — one process, and nothing between the client and the server's stdio.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureDevDataDirSecured,
  resolveDevDataDirEnv,
  resolveRepoRootFromGit,
} from './with-dev-data-dir-lib.mjs'

const hadExplicitDataDirOverride = Boolean(process.env.WHITEBOARD_DATA_DIR)
const repoRoot = resolveRepoRootFromGit(dirname(fileURLToPath(import.meta.url)))
const { WHITEBOARD_DATA_DIR } = resolveDevDataDirEnv(process.env, repoRoot)
if (!hadExplicitDataDirOverride) ensureDevDataDirSecured(WHITEBOARD_DATA_DIR)
process.env.WHITEBOARD_DATA_DIR = WHITEBOARD_DATA_DIR

await import('../../src/server/mcp/stdio.ts')
