// A BuildKit cache mount's contents are never exported by a layer-cache
// backend, and never restored with a cached layer. So a step that READS what
// an earlier step wrote into one is correct exactly while the earlier step
// keeps running — and breaks the first time the layer cache works.
//
// Measured here, on the first build after the gha cache backend was given
// credentials:
//
//   #12 [fetched 3/3] RUN --mount=type=cache,id=pnpm … pnpm fetch     CACHED
//   #14 [build 2/5]   RUN --mount=type=cache,id=pnpm … pnpm install --offline
//   #14 ERROR: … did not complete successfully: exit code: 1
//
// `pnpm fetch` was restored from cache, so it did not run, so the mount was
// empty, so the offline install had no store to read. The `fetched` stage's
// own comment called it "populate the pnpm store from the lockfile
// (cache-friendly)" while the mount guaranteed nothing of it survived into
// the layer.
//
// On CI the mount had never helped at all: every job gets a fresh builder, so
// it starts empty on every run. It could only ever cost.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile.server'), 'utf-8')

describe('Dockerfile.server and the layer cache', () => {
  it('has no cache mount for a later stage to depend on', () => {
    // Blunt on purpose: "does any step depend on a mount's contents" is not
    // decidable from the text, and the one mount this image had did. A future
    // mount that genuinely nothing reads across a layer boundary can amend
    // this test and say why.
    // Instruction lines only: the comment explaining why there is no mount
    // names the thing it is explaining, and tripped this on its first run.
    const mounts = DOCKERFILE.split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => line.includes('--mount=type=cache'))
    expect(mounts).toEqual([])
  })

  it('still fetches the store into the layer the install reads from', () => {
    // The replacement for the mount is the layer itself, which is what makes
    // the `fetched` stage cacheable in the first place.
    expect(DOCKERFILE).toMatch(/RUN pnpm fetch --store-dir \/pnpm\/store/)
    expect(DOCKERFILE).toMatch(/pnpm install --offline --frozen-lockfile/)
  })
})
