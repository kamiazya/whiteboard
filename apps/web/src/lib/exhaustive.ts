/**
 * A compile error at the place that has to DECIDE, when a union grows.
 *
 * The shape this exists to retire: `kind === 'markdown' ? … : <the other one>`.
 * It reads as a complete decision and is a default — a document kind added
 * later is silently routed as whichever branch the `else` happens to be, and
 * nothing anywhere goes red. Measured on this codebase by adding a third
 * `DocumentKind` and typechecking: `render-surfaces.ts` failed three times
 * (its `Record<DocumentKind, …>` is exhaustive), while every kind-routing
 * branch in the render pipeline compiled clean and would have drawn the new
 * kind with the wrong pipeline, or asked an owner that does not hold it.
 *
 * Passing the value as `never` is what makes the compiler object: once a case
 * is unhandled, the narrowed type at the default is no longer `never` and the
 * call stops typechecking. The throw is only for a value that reached here at
 * runtime past the type system — a parsed payload, a cast.
 */
export function unhandledKind(value: never, context: string): never {
  throw new Error(`${context}: unhandled ${JSON.stringify(value)}`)
}
