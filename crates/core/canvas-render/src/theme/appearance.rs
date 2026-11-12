//! `spatial-appearance.ts`: the appearance seam of the layout. The layout never
//! invents a fill, stroke or font; a resolver assigns them, and
//! [`crate::theme::spatial_theme::SpatialTheme`] is the one producer.
//!
//! APPEARANCE ONLY: padding, label size and minimum content width are geometry
//! ([`crate::theme::geometry`]) and must not vary with the resolver a surface
//! happens to use.

use whiteboard_model::spatial::{CanvasColor, CanvasEdge, CanvasLine, SpatialNode};
use whiteboard_scene::Appearance;

use super::mode::SpatialThemeMode;
use super::palette::SpatialSyntaxPalette;

/// An element a route is drawn for: a relation or a piece of ink. Both carry a
/// colour and nothing else a resolver reads.
#[derive(Debug, Clone, Copy)]
pub enum RoutableElement<'a> {
    Edge(&'a CanvasEdge),
    Line(&'a CanvasLine),
}

impl RoutableElement<'_> {
    #[must_use]
    pub const fn color(&self) -> Option<&CanvasColor> {
        match self {
            Self::Edge(edge) => edge.color.as_ref(),
            Self::Line(line) => line.color.as_ref(),
        }
    }
}

/// What a resolver decided for one spatial node's chrome.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SpatialNodeAppearance {
    pub appearance: Option<Appearance>,
    /// Uniform corner radius for the chrome shape; `None` means no radius.
    pub radius: Option<f64>,
}

/// What a proposal draws: the annotation layer's grammar in a different hue,
/// one `outline` for every arm because what a change MEANS is said by the
/// bubble, in words.
#[derive(Debug, Clone, PartialEq)]
pub struct SpatialProposalAppearance {
    /// Around the box a change concerns, or along the route of an edge one.
    pub outline: Appearance,
    /// The card counting what the proposal would do.
    pub bubble: Appearance,
    /// The dotted line tying the card to the change it is about.
    pub leader: Appearance,
}

/// The shapes a comment composes, whichever treatment is assigned: the
/// unresolved default, or the resolved overlay.
#[derive(Debug, Clone, PartialEq)]
pub struct SpatialCommentChromeAppearance {
    pub pin: Appearance,
    pub bubble: Appearance,
    /// The dashed line tying pin to bubble.
    pub leader: Appearance,
    /// The wash behind the words a thread quotes inside a text node.
    pub passage: Option<Appearance>,
    /// The digits painted ON the pin, which need the pin's contrast rather than
    /// its fill.
    pub pin_count: Option<Appearance>,
    /// The outline around the box a node set or a region stands for.
    pub region: Option<Appearance>,
    /// The words of a settled bubble and its "Resolved" label; only the
    /// resolved overlay reads it.
    pub text: Option<Appearance>,
}

/// What a resolver decided for the comment layer's chrome.
#[derive(Debug, Clone, PartialEq)]
pub struct SpatialCommentAppearance {
    pub chrome: SpatialCommentChromeAppearance,
    /// The muted treatment under `showResolved`: required, because a resolver
    /// that implements comments at all must say what a resolved one looks like
    /// rather than leave the composer to invent it.
    pub resolved_overlay: SpatialCommentChromeAppearance,
}

/// The functions a layout asks, as a trait: appearance keys off the node's kind
/// and an authored colour, so it is a function of the node and not a table.
/// The three optional layers default to answering nothing, which assigns no
/// appearance rather than inventing one.
pub trait SpatialAppearanceResolver {
    /// Which surface this resolver paints for; a layout that resolves a
    /// document theme reads it to pick the matching palette, treating absence
    /// as light.
    fn mode(&self) -> Option<SpatialThemeMode> {
        None
    }

    fn resolve_node(&self, node: &SpatialNode) -> SpatialNodeAppearance;

    fn resolve_edge(&self, edge: RoutableElement<'_>) -> Option<Appearance>;

    /// A `file`/`link`/`group` label run or a degraded body fallback run.
    fn resolve_label(&self) -> Appearance;

    /// Fills for syntax-highlighted code runs; absent renders code plain.
    fn resolve_syntax(&self) -> Option<SpatialSyntaxPalette> {
        None
    }

    fn resolve_comment(&self) -> Option<SpatialCommentAppearance> {
        None
    }

    fn resolve_proposal(&self) -> Option<SpatialProposalAppearance> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use whiteboard_model::spatial::CanvasColorPreset;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// A resolver written by hand answers only the three required functions.
    struct Bare;

    impl SpatialAppearanceResolver for Bare {
        fn resolve_node(&self, _node: &SpatialNode) -> SpatialNodeAppearance {
            SpatialNodeAppearance::default()
        }

        fn resolve_edge(&self, _edge: RoutableElement<'_>) -> Option<Appearance> {
            None
        }

        fn resolve_label(&self) -> Appearance {
            Appearance::default()
        }
    }

    #[test]
    fn a_resolver_that_predates_a_layer_answers_nothing_for_it_rather_than_inventing_one() {
        let bare = Bare;
        assert_eq!(bare.mode(), None);
        assert_eq!(bare.resolve_node(&SpatialNode::default()), SpatialNodeAppearance::default());
        assert_eq!(bare.resolve_edge(RoutableElement::Edge(&CanvasEdge::default())), None);
        assert_eq!(bare.resolve_label(), Appearance::default());
        assert_eq!(bare.resolve_syntax(), None);
        assert_eq!(bare.resolve_comment(), None);
        assert_eq!(bare.resolve_proposal(), None);
    }

    #[test]
    fn a_routable_element_answers_the_colour_of_whichever_it_is() {
        let color = Some(CanvasColor::CanvasColorPreset(CanvasColorPreset::V3));
        let edge = CanvasEdge { color: color.clone(), ..CanvasEdge::default() };
        let line = CanvasLine { color: color.clone(), ..CanvasLine::default() };
        assert_eq!(RoutableElement::Edge(&edge).color(), color.as_ref());
        assert_eq!(RoutableElement::Line(&line).color(), color.as_ref());
        assert_eq!(RoutableElement::Edge(&CanvasEdge::default()).color(), None);
    }
}
