// Under pnpm's global virtual store a package sees only the dependencies it
// DECLARES, so one that requires an undeclared module resolves it solely
// through NODE_PATH — which pnpm's `.bin` shims export and plain `node` does
// not. pnpm-workspace.yaml's `packageExtensions` declares those modules for
// it. The failure names a module and a package the caller never imported,
// and only appears outside a shim — under plain `node`, or a tool that
// spawns one.
//
// Each case resolves the module from the package's REAL location in a child
// process with NODE_PATH removed, because this test itself runs under the
// shim and an in-process resolve would consult the NODE_PATH it inherited.

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const CASES = [
  // transformers.node.mjs imports onnxruntime-common while declaring only
  // onnxruntime-node, and the daemon's search loads it.
  {
    consumer: 'packages/mcp-server',
    pkg: '@huggingface/transformers',
    module: 'onnxruntime-common',
  },
] as const

function resolveWithoutNodePath(fromDir: string, module: string) {
  const env = { ...process.env }
  delete env.NODE_PATH
  const script = `require('node:module').createRequire(process.argv[1] + '/package.json').resolve(process.argv[2])`
  return spawnSync(process.execPath, ['-e', script, fromDir, module], {
    env,
    encoding: 'utf-8',
  })
}

describe('a module a package requires without declaring it', () => {
  it.each(CASES)('resolves $module for $pkg without NODE_PATH', ({ consumer, pkg, module }) => {
    const link = join(REPO_ROOT, consumer, 'node_modules', pkg)
    expect(existsSync(link), `${pkg} is no longer installed under ${consumer}`).toBe(true)
    const result = resolveWithoutNodePath(realpathSync(link), module)
    expect(
      result.status,
      `${pkg} cannot reach ${module} outside a pnpm shim; declare it under packageExtensions in pnpm-workspace.yaml\n${result.stderr}`,
    ).toBe(0)
  })
})
