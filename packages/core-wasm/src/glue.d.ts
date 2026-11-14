/**
 * The wasm-bindgen glue (`artifacts/whiteboard_wasm.js`, staged from
 * `pnpm rust:build:wasm`) as the shim calls it, declared by hand so that
 * `tsc` needs no built artifact: the TypeScript jobs and the pre-push hook
 * have no Rust toolchain. Three things keep it honest: `loadCore` checks
 * `abi_version()` at init, `abi-conformance.ts` beside src holds this declaration to
 * the generated one where the artifact exists (`typecheck:abi`, the rust
 * job), and core-wasm-rust compares the export names.
 */
declare module '#glue' {
  export function initSync(init: { module: BufferSource | WebAssembly.Module }): unknown
  export function abi_version(): string
  export function edge_route_layout(input: Float64Array): Float64Array
  export function okf_parse(text: string, mark: number): string
  export function okf_serialize(frontmatter: string): string
  export function json_canvas_parse(text: string): string
  export function json_canvas_serialize(canvas: string, strict: boolean): string
  export function facet_bucket_check(target: string, bucket: string, library: string): string
  export function layout_spatial_canvas(request: string, fonts: Uint8Array): string
}
