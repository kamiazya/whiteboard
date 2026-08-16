/**
 * Public test-only surface for consumers that need to generate valid
 * model values (e.g. codec's round-trip properties) without
 * duplicating arbitraries per package. Not part of the runtime `.` export —
 * only ever imported from test files.
 */
export * from './arbitraries.js'
export * from './fast-check.js'
