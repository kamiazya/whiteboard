//! What a layout asks about the documents a canvas points at, answered from
//! the reference bundle as DATA (`references/wire.ts`'s `ReferenceWire`, and
//! `referenceSeams` over it): the graph a keeper loaded, keyed by the
//! reference as written, and the alias, title and extras tables over it.
//!
//! [`WireHost`] is the composer's host over that wire, and the rule of
//! `referenceSeams` is applied here as it is there: a record with a body is a
//! markdown document whatever else it carries; only a bodiless record offers
//! its canvas; a file node draws an empty canvas as its card.
//!
//! Where an answer would need something the core does not hold (the visual
//! plugin's emoji and icon shortcode tables) or a body is past the parser's
//! bounds, the host answers as if it had none and notes a [`Refused`]: the
//! layout it was asked for is then refused whole, and the caller's TypeScript
//! draws it (owner decision q72, option c), so no scene differs from the
//! TypeScript's for a reason the core cannot see.
//!
//! A fence's tokens are the one answer that arrives as data AFTER the core has
//! asked for it (owner decision q75): the host colours a fence the
//! highlighter's gate passes from the [`FenceTokens`] the caller sent, and
//! collects each one it finds missing, which the caller tokenises before
//! asking again.

mod host;

use whiteboard_model::spatial::SpatialCanvas;

use crate::node_box::FacetCard;
use crate::typeset::CodeTokenLines;

pub use host::WireHost;

/// One referenced document as a keeper loaded it (`LoadedReference`): every
/// field optional and independent.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LoadedReference {
    /// The canonical id the reference resolved to, when the keeper knows it.
    pub document_id: Option<String>,
    /// The document's display name.
    pub name: Option<String>,
    /// A markdown document's raw body.
    pub body: Option<String>,
    /// A spatial document's canvas.
    pub canvas: Option<SpatialCanvas>,
}

/// A picture a surface attached to a reference, with its natural size when
/// the surface decoded it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExtraImage {
    pub href: String,
    pub alt: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// What a surface adds beside a reference's loaded content (`ReferenceExtra`):
/// the fields that are data. A body or a canvas a surface attaches is not
/// carried; the caller answers such a layout from the TypeScript.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReferenceExtra {
    pub label: Option<String>,
    pub missing: Option<bool>,
    pub image: Option<ExtraImage>,
    pub facets: Option<FacetCard>,
}

/// The reference bundle as data (`ReferenceWire`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ReferenceWire {
    /// The graph: a reference as written, and what loaded for it (`None`: looked
    /// up, nothing there).
    pub entries: Vec<(String, Option<LoadedReference>)>,
    /// A written target, and the id the caller's table resolved it to.
    pub aliases: Vec<(String, String)>,
    /// A document id, and its display name.
    pub titles: Vec<(String, String)>,
    pub extras: Vec<(String, ReferenceExtra)>,
}

/// One fence's tokens as the host's highlighter answered them, keyed by the
/// language and the source as the fence holds them; `None` when it answered
/// nothing, and the fence is drawn plain.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FenceTokens {
    pub lang: String,
    pub value: String,
    pub lines: Option<CodeTokenLines>,
}

/// Why the host could not answer as the TypeScript would, so the layout it
/// served is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// A body past the markdown parser's bounds.
    Body,
    /// A text that may hold an emoji or icon shortcode.
    Shortcode,
}

impl Refused {
    /// The class a refusal names it by.
    #[must_use]
    pub const fn class(self) -> &'static str {
        match self {
            Self::Body => "body",
            Self::Shortcode => "shortcode",
        }
    }
}

#[cfg(test)]
mod tests;
