import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serverRestoreOutputSchema, serverSupportBundleOutputSchema } from '../cli/operator-json.js'
import { repoRoot } from '../shared/test-utils/repo-root.js'
import { serverBackupResultSchema } from './store/backup-pass.js'

const DOCS_ROOT = join(repoRoot(), 'docs')

// The one docs guard that parses a page through the daemon's own output
// schemas, so it cannot sit with the rest of the docs contract in
// tools/arch-lint (which imports no daemon source).
describe('docs/ contract', () => {
  // The page tells operators what to script against, and said the backup was
  // version 1 for as long as the code printed version 2: a span nobody
  // re-reads is a claim nothing checks. Every JSON it shows as a command's
  // output is parsed through the schema that command prints through, and the
  // version column is read against the same schemas.
  describe('self-host-with-docker.md output examples', () => {
    const guide = readFileSync(join(DOCS_ROOT, 'how-to/self-host-with-docker.md'), 'utf8')
    const OUTPUTS = {
      backup: serverBackupResultSchema,
      restore: serverRestoreOutputSchema,
      'support-bundle': serverSupportBundleOutputSchema,
    } as const
    const examples = [
      ...[...guide.matchAll(/stdout contains\s+`([^`]+)`/g)].map((match) => match[1] ?? ''),
      ...[...guide.matchAll(/```json\n([\s\S]*?)```/g)]
        .map((match) => match[1] ?? '')
        .filter((block) => block.includes('"operation"')),
    ]

    it('shows an example for every operator output, and each parses through its schema', () => {
      expect(
        new Set(examples.map((text) => (JSON.parse(text) as { operation: string }).operation)),
      ).toEqual(new Set(Object.keys(OUTPUTS)))
      for (const text of examples) {
        const example = JSON.parse(text) as { operation: keyof typeof OUTPUTS }
        const result = OUTPUTS[example.operation].safeParse(example)
        expect(
          result.success,
          `${text} does not parse: ${JSON.stringify(result.error?.issues)}`,
        ).toBe(true)
      }
    })

    it('states each output schemaVersion as the schema declares it', () => {
      const rows = [...guide.matchAll(/^\| `server [\w-]+` \| `([\w-]+)` \| (\d+) \|$/gm)]
      expect(rows.map((row) => row[1]).sort()).toEqual(Object.keys(OUTPUTS).sort())
      for (const [, operation, version] of rows) {
        const schema = OUTPUTS[operation as keyof typeof OUTPUTS]
        expect(Number(version), `${operation} schemaVersion`).toBe(schema.shape.schemaVersion.value)
      }
    })
  })
})
