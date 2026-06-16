import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount all rendered components after each test so React's scheduler
// does not hold a pending setImmediate that fires after jsdom teardown.
// Some test files call cleanup() themselves; calling it twice is a no-op.
afterEach(() => {
  cleanup()
})
