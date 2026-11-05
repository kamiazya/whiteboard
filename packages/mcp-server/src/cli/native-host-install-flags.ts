import type { FlagTable } from './flag-table.js'

/** What `native-host install` accepts; `whiteboard --help` is held to it by `dispatcher-usage.test.ts`. */
export const INSTALL_FLAGS: FlagTable<'dataDir' | 'manifestDir' | 'firefoxManifestDir'> = {
  booleans: ['--json', '--development'],
  values: {
    '--data-dir': 'dataDir',
    '--manifest-dir': 'manifestDir',
    '--firefox-manifest-dir': 'firefoxManifestDir',
  },
}
