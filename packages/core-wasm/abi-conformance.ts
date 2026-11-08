// Type-only: compiled by `typecheck:abi` where the artifact is staged, never
// by the default typecheck. The generated glue must satisfy what the
// hand-written `#glue` declaration says the shim may call: an export the
// declaration names that the artifact lacks, or one it would call with a
// shape the artifact does not accept, fails to compile here.
import type * as Declared from '#glue'
import type * as Generated from './artifacts/whiteboard_wasm.js'

const conforms: typeof Declared = null as unknown as typeof Generated
void conforms
