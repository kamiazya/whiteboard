#!/usr/bin/env node
// Release gate for the packaged bin entries. Runs after build and
// before publish so a regression that drops a chmod, breaks a
// shebang, or removes a `bin` map entry never reaches npm.
//
// The checker pins both halves of the contract:
//   A. The package.json `bin` map MUST be exactly the set of
//      entries listed in `REQUIRED_BIN_MAP` below (with the exact
//      target paths). A regression that deletes one of these (or
//      retargets it) is what the static `release-gates.test.ts`
//      catches at unit-test time; pinning it here too means
//      `prepublishOnly` cannot let a tarball ship without the
//      `whiteboard` bin (the unified CLI surface; `whiteboard mcp` is
//      the sole stdio MCP entrypoint).
//   B. For each required entry, the on-disk artifact MUST:
//        1. Exist as a regular file.
//        2. Start with `#!/usr/bin/env node` — Node looks at the
//           shebang when the bin is invoked directly via the symlink
//           npm installs into PATH, so a missing shebang silently
//           breaks the packaged install on POSIX.
//        3. On POSIX (`process.platform !== 'win32'`) have the
//           owner-execute bit set. Windows installs don't honour
//           the bit (`npm install` writes a `.cmd` shim instead)
//           so the smoke skips this leg there rather than emitting
//           a false-positive regression.
//
// The script exits 0 on success, prints a structured failure list
// and exits 1 otherwise. `prepublishOnly` calls it.

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '../..')
const PACKAGE_JSON_PATH = resolve(PACKAGE_ROOT, 'package.json')
const SHEBANG = '#!/usr/bin/env node'

// Required bin entries, pinned here so a regression that drops one
// from package.json fails the publish gate even before any on-disk
// artifact check runs. Keep this in sync with the static release
// gate at packages/mcp-server/src/server/release/release-gates.test.ts.
const REQUIRED_BIN_MAP = {
  whiteboard: 'dist/cli/index.js',
}

function fail(failures) {
  console.error('[check-release-artifacts] FAIL:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'))
const bin = pkg.bin
if (!bin || typeof bin !== 'object') {
  fail(['package.json `bin` field is missing or not an object'])
}

// Phase A: bin map pin. Run before phase B so a missing entry never
// reaches the on-disk file probe.
const binFailures = []
for (const [name, expectedPath] of Object.entries(REQUIRED_BIN_MAP)) {
  const actual = bin[name]
  if (actual === undefined) {
    binFailures.push(`package.json bin.${name} is missing (expected "${expectedPath}")`)
    continue
  }
  if (actual !== expectedPath) {
    binFailures.push(
      `package.json bin.${name} is "${actual}", expected "${expectedPath}"`,
    )
  }
}
if (binFailures.length > 0) {
  fail(binFailures)
}

const failures = []
const checked = []
for (const [name, relativePath] of Object.entries(bin)) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    failures.push(`bin.${name} is not a non-empty string`)
    continue
  }
  if (isAbsolute(relativePath)) {
    failures.push(`bin.${name} is absolute (${relativePath}); must be relative to package root`)
    continue
  }
  const target = resolve(PACKAGE_ROOT, relativePath)

  let stats
  try {
    stats = statSync(target)
  } catch (err) {
    failures.push(
      `bin.${name} → ${relativePath}: file not found (${err instanceof Error ? err.message : String(err)})`,
    )
    continue
  }
  if (!stats.isFile()) {
    failures.push(`bin.${name} → ${relativePath}: not a regular file`)
    continue
  }

  let head
  try {
    // 256 bytes is more than enough to capture a single shebang line
    // without reading a multi-megabyte bundle into memory.
    const fd = readFileSync(target).slice(0, 256).toString('utf-8')
    head = fd
  } catch (err) {
    failures.push(
      `bin.${name} → ${relativePath}: failed to read head: ${err instanceof Error ? err.message : String(err)}`,
    )
    continue
  }
  if (!head.startsWith(SHEBANG)) {
    failures.push(
      `bin.${name} → ${relativePath}: missing or wrong shebang. Expected "${SHEBANG}", got "${head.split('\n')[0] ?? ''}"`,
    )
    continue
  }

  if (process.platform !== 'win32') {
    // 0o100 is the owner-execute bit. npm preserves the executable
    // bit on tarball pack/unpack so a missing bit at publish time
    // breaks installs on POSIX consumers.
    if ((stats.mode & 0o100) === 0) {
      failures.push(
        `bin.${name} → ${relativePath}: not executable (mode=${(stats.mode & 0o777).toString(8)}). Run chmod +x or fix the build chmod step.`,
      )
      continue
    }
  }

  checked.push(`${name} → ${relativePath}`)
}

if (failures.length > 0) {
  fail(failures)
}

console.log(`[check-release-artifacts] OK (${checked.length} bin entries)`)
for (const entry of checked) console.log(`  ✓ ${entry}`)
