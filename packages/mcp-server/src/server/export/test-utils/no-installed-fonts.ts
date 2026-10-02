import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fonts directory that holds nothing, so only the vendored faces are in play. */
export const NO_INSTALLED_FONTS = join(tmpdir(), 'whiteboard-test-no-installed-fonts')
