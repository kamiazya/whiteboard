//! The SVG backend: a laid-out [`whiteboard_scene::Scene`] to canonical SVG
//! text. Pure, no DOM; the same implementation runs natively and on wasm32.
//!
//! The renderers describe WHAT to emit as a tree of [`vnode::VNode`]s and
//! [`serialize`] is the only code that turns that tree into bytes, so
//! escaping, number formatting and attribute order cannot diverge per call
//! site.

mod backend;
mod defs;
mod document_href;
mod filter_budget;
mod format;
mod hoist;
mod icon;
mod keyed;
mod legend;
mod nodes;
mod paint;
mod render_edge;
mod runs;
mod serialize;
mod shapes;
mod vnode;

pub use backend::{SvgDocumentOptions, render_scene_to_svg};
pub use format::{NonFinite, format_coord, sanitize_href};
pub use keyed::{KeyedSvgGroup, KeyedSvgRender, render_scene_to_keyed_svg};
