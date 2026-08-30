// Types for the plain list module beside this file. It stays .mjs because
// Stryker's config loads it directly from node, which does not read TypeScript
// — so the declaration lives here rather than the list being a .ts file.
export declare const MUTATED: readonly string[]
export declare const KNOWN_EQUIVALENT: Readonly<
  Record<string, { readonly [mutantKey: string]: number }>
>
