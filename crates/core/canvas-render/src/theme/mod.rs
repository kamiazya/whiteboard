//! The theme layer, ported from `packages/canvas-render/src/theme` (ADR-0054
//! step 7): the palettes, the one spatial theme that answers what a node, an
//! edge and a label are painted with, the markdown metrics, and the mapping of
//! a registered theme asset onto all of it. Held to the recorded `theme.jsonl`
//! (`tests/theme_oracle.rs`).
//!
//! `tokens` reads a plugin's theme assets into the table a layout resolves a
//! theme id against.
//!
//! One difference from the TypeScript, on purpose: nothing here is a global.
//! `createSpatialTheme`'s frozen per-mode singletons and the themed resolver's
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
pub mod tokens;
