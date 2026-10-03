// Types for the plain module beside this file. It stays .mjs because the
// vitest config that loads it is read by Stryker's own node process.
export declare function coveringTests(
  mutated?: readonly string[],
  packageDir?: string,
  depth?: number,
): string[]
