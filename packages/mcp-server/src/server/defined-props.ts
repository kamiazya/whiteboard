export function definedProps<T extends Record<string, unknown>>(
  props: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const entries = Object.entries(props).filter(([, value]) => value !== undefined)
  return Object.fromEntries(entries) as { [K in keyof T]?: Exclude<T[K], undefined> }
}
