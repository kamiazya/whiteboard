import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('old Excalidraw tool removal', () => {
  test('tools/ directory no longer exists', () => {
    expect(existsSync(resolve(__dirname, 'tools'))).toBe(false)
  })

  test('tool-registration.ts no longer exists', () => {
    expect(existsSync(resolve(__dirname, 'tool-registration.ts'))).toBe(false)
  })
})
