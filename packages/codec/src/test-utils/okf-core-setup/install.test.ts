import { afterEach, describe, expect, it } from 'vitest'
import { installOkfCore } from '../../okf/okf-core.js'
import { installOkfCoreForTests } from './install.js'

describe('installOkfCoreForTests', () => {
  afterEach(() => installOkfCore(undefined))

  it('installs nothing when the switch is unset or ts', async () => {
    const missing = '/nonexistent/whiteboard_wasm_bg.wasm'
    await expect(
      installOkfCoreForTests({ okf: undefined, mismatch: 'throw' }, missing),
    ).resolves.toBeUndefined()
    await expect(
      installOkfCoreForTests({ okf: 'ts', mismatch: 'throw' }, missing),
    ).resolves.toBeUndefined()
  })

  it('fails loudly when the switch asks for the core and the artifact is missing', async () => {
    const missing = '/nonexistent/whiteboard_wasm_bg.wasm'
    await expect(
      installOkfCoreForTests({ okf: 'differential', mismatch: 'throw' }, missing),
    ).rejects.toThrow(/artifact is missing/)
  })

  it('refuses a switch value it does not know', async () => {
    await expect(installOkfCoreForTests({ okf: 'rustt', mismatch: undefined })).rejects.toThrow(
      /not ts/,
    )
  })
})
