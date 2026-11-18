/**
 * Answers the document id a `[[target]]` names, or `null` when it names none.
 * The target is an ALIAS — a workspace path — since display names are retired
 * from resolution; an id is written as itself and needs no resolver.
 */
export type AliasResolver = (alias: string) => string | null
