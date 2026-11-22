import { REFUSALS, type RefusalName, type RefusalParams } from './generated/refusals.js'

type Filter = (value: never) => string

// Each filter is the JavaScript its name says, and the Rust half
// (`crates/ops/api-contracts/src/refusal_text.rs`) is held to the same
// results by the contract's pinned examples.
const FILTERS: Readonly<Record<string, Filter>> = {
  json: (value: string) => JSON.stringify(value),
  trim: (value: string) => value.trim(),
  s: (value: number) => (value === 1 ? '' : 's'),
  list: (value: readonly string[]) => value.join(', '),
  and_list: (value: readonly string[]) => value.join(' and '),
  json_list: (value: readonly string[]) => value.map((item) => JSON.stringify(item)).join(', '),
  quoted_list: (value: readonly string[]) => value.map((item) => `"${item}"`).join(', '),
}

const PLACEHOLDER = /\{\{|\}\}|\{([A-Za-z0-9]+)(?:\|([a-z_]+))?\}/g

/** A message template with its params filled in, as `refusals.json` defines the language. */
export function renderRefusalTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (match, name?: string, filterName?: string) => {
    if (name === undefined) return match === '{{' ? '{' : '}'
    if (!Object.hasOwn(params, name))
      throw new Error(`refusal template names \`${name}\`, which was not given`)
    const value = params[name]
    if (filterName === undefined) return String(value)
    const filter = FILTERS[filterName]
    if (filter === undefined)
      throw new Error(`refusal template names an unknown filter \`${filterName}\``)
    return filter(value as never)
  })
}

type ParamsArg<N extends RefusalName> = keyof RefusalParams[N] extends never
  ? []
  : [params: RefusalParams[N]]

/**
 * The sentence a refusal is answered with. The text lives in
 * `contracts/api/refusals.json` so the Rust operations say the same words.
 */
export function refusalMessage<N extends RefusalName>(name: N, ...params: ParamsArg<N>): string {
  return renderRefusalTemplate(REFUSALS[name].message, params[0] ?? {})
}
