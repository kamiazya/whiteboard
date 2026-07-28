// Prepend the Node shebang to the built CLI entry.
//
// tsup's `banner` is applied to every output file of a build, which would
// corrupt the shared library entries and split chunks. The CLI is the only
// entry that needs `#!/usr/bin/env node`, so we add it here as a post-build
// step (before chmod +x) instead.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHEBANG = '#!/usr/bin/env node\n'
const here = dirname(fileURLToPath(import.meta.url))
const cliEntry = resolve(here, '..', 'dist', 'cli', 'index.js')

const source = await readFile(cliEntry, 'utf8')
if (!source.startsWith('#!')) {
  await writeFile(cliEntry, SHEBANG + source)
}
