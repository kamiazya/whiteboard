import { it } from 'vitest'

// The layer-order guard reads this tree's imports through the TypeScript AST, which only
// tools/arch-lint depends on: it is tools/arch-lint/src/web-layer-order.test.ts.
it.todo("holds apps/web's layer order in tools/arch-lint/src/web-layer-order.test.ts")
