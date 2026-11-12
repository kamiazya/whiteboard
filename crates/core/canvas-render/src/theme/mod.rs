//! The theme layer, ported from `packages/canvas-render/src/theme` (ADR-0054
//! step 7): the palettes, the one spatial theme that answers what a node, an
//! edge and a label are painted with, the markdown metrics, and the mapping of
//! a registered theme asset onto all of it. Held to the recorded `theme.jsonl`
//! (`tests/theme_oracle.rs`).
//!
//! Not ported: the layout's reads of a canvas's `visual.theme/v0` facet. They go
//! through the plugin's resolvers and the composer, neither of which is in Rust
//! yet; `markdown_theme` and `create_themed_appearance` take the tokens a caller
//! has already resolved, which is also all the TypeScript functions take.
//!
//! One difference from the TypeScript, on purpose: nothing here is a global.
//! `createSpatialTheme`'s frozen per-mode singletons and `createThemedAppearance`'s
//! `WeakMap` exist so an editor that re-renders every frame is handed the SAME
//! object; here a theme is a value, built where it is needed, and
//! [`asset::ThemedAppearanceCache`] gives a layout (or any other call site that
//! asks for the same theme more than once) the identity the weak map gave a
//! module. A cache is bound to one token bundle, so it cannot outlive it either.

pub mod appearance;
pub mod asset;
pub mod font;
pub mod geometry;
pub mod markdown;
pub mod mode;
pub mod palette;
pub mod spatial_theme;
