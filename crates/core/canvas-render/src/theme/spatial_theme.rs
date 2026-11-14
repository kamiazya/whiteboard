//! `spatial-theme.ts`: the ONE [`SpatialAppearanceResolver`] producer, replacing
//! three per-surface resolvers.
//!
//! Dark mode is a PARAMETER of this theme, not a second appearance authority: a
//! scene-to-scene dark transform would still need the same role knowledge (which
//! node is which kind) for strictly more machinery. No call site reads the
//! user's ambient UI theme, so it can never change exported bytes.
//!
//! The TypeScript's per-mode frozen singletons are not here: a theme is a value
//! built where it is needed (see the module header of [`crate::theme`]).
//!
//! Not reproduced: a colour text naming a key `Object.prototype` has
//! (`constructor`, `toString`) resolves through the preset table in the
//! TypeScript to a function and paints nothing. A colour is a preset key or a
//! hex by schema, so no document carries one; here it is simply no preset.

use whiteboard_model::spatial::{CanvasColor, NodeResource, SpatialNode};
use whiteboard_scene::Appearance;

use super::appearance::{
    RoutableElement, SpatialAppearanceResolver, SpatialCommentAppearance,
    SpatialCommentChromeAppearance, SpatialNodeAppearance, SpatialProposalAppearance,
};
use super::font::SPATIAL_THEME_FONT_FAMILY;
use super::mode::SpatialThemeMode;
use super::palette::{SpatialNodeStyle, SpatialPalette, SpatialPresetAccent, SpatialSyntaxPalette};

/// Dash pattern for the comment leader line.
const COMMENT_LEADER_DASH: &str = "4 3";
/// Alpha for a RESOLVED comment shown under `showResolved`: muted enough to
/// read as settled without disappearing, over the colours the unresolved
/// chrome already uses rather than a second colour.
const COMMENT_RESOLVED_OPACITY: f64 = 0.45;
/// The pin's own amber at a wash, so a quoted passage stays readable.
const COMMENT_PASSAGE_OPACITY: f64 = 0.22;
const COMMENT_PASSAGE_RESOLVED_OPACITY: f64 = 0.1;
const DASH: &str = "6 4";

/// Wholesale replacement is the theme layer's swap point: presets, chrome and
/// the corner radius all come from the palette, so restyling is a data change.
#[derive(Debug, Clone, PartialEq)]
pub struct SpatialTheme {
    mode: SpatialThemeMode,
    palette: SpatialPalette,
}

/// `createSpatialTheme`: the bundled palette of `mode`, or `palette` when given.
#[must_use]
pub fn create_spatial_theme(
    mode: SpatialThemeMode,
    palette: Option<SpatialPalette>,
) -> SpatialTheme {
    let palette = palette.unwrap_or_else(|| match mode {
        SpatialThemeMode::Light => SpatialPalette::light(),
        SpatialThemeMode::Dark => SpatialPalette::dark(),
    });
    SpatialTheme { mode, palette }
}

/// The text a colour is written as.
fn color_text(color: &CanvasColor) -> &str {
    match color {
        CanvasColor::CanvasColorPreset(preset) => preset.as_str(),
        CanvasColor::CanvasColorHex(text) => text,
    }
}

/// A numbered preset resolved through the palette; `None` for hex or unknown.
fn preset_accent<'p>(
    color: Option<&CanvasColor>,
    palette: &'p SpatialPalette,
) -> Option<&'p SpatialPresetAccent> {
    let text = color_text(color?);
    if text.starts_with('#') { None } else { palette.presets.get(text) }
}

/// An author-supplied raw hex, passed through untouched.
fn raw_hex(color: Option<&CanvasColor>) -> Option<&str> {
    color.map(color_text).filter(|text| text.starts_with('#'))
}

/// What a node is painted as. `Unclaimed` is a resource nothing claims, which
/// the layout degrades to chrome only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaintKind {
    Text,
    Link,
    File,
    Frame,
    Unclaimed,
}

const URI_LIST: &str = "text/uri-list";

/// `nodeKind`, over what it reads: inline content is text, a location splits by
/// media type, and a frame shows nothing.
fn paint_kind(node: &SpatialNode) -> PaintKind {
    match &node.resource {
        None => PaintKind::Frame,
        Some(NodeResource { content: Some(_), .. }) => PaintKind::Text,
        Some(NodeResource { location: Some(_), mime_type, .. }) if mime_type == URI_LIST => {
            PaintKind::Link
        }
        Some(NodeResource { location: Some(_), .. }) => PaintKind::File,
        Some(_) => PaintKind::Unclaimed,
    }
}

fn solid(fill: &str, stroke: &str) -> Appearance {
    Appearance {
        fill: Some(fill.to_owned()),
        stroke: Some(stroke.to_owned()),
        ..Appearance::default()
    }
}

fn dashed(stroke: &str, width: f64, dash: &str) -> Appearance {
    Appearance {
        stroke: Some(stroke.to_owned()),
        stroke_width: Some(width),
        stroke_dasharray: Some(dash.to_owned()),
        ..Appearance::default()
    }
}

/// The resolved-overlay treatment, DERIVED from the base chrome so the two can
/// never disagree on colour: each present paint channel muted, and no drop
/// shadow, so a resolved comment recedes instead of floating above the plane.
fn mute_for_resolved(base: &Appearance) -> Appearance {
    Appearance {
        drop_shadow: false,
        fill_opacity: base
            .fill
            .as_ref()
            .map_or(base.fill_opacity, |_| Some(COMMENT_RESOLVED_OPACITY)),
        stroke_opacity: base
            .stroke
            .as_ref()
            .map_or(base.stroke_opacity, |_| Some(COMMENT_RESOLVED_OPACITY)),
        ..base.clone()
    }
}

fn shadowed(style: &SpatialNodeStyle) -> Appearance {
    Appearance { drop_shadow: true, ..solid(&style.fill, &style.stroke) }
}

impl SpatialTheme {
    #[must_use]
    pub const fn palette(&self) -> &SpatialPalette {
        &self.palette
    }

    fn comment_chrome(&self) -> SpatialCommentChromeAppearance {
        let comment = &self.palette.comment;
        let pin = Appearance { stroke_width: Some(2.0), ..shadowed(&comment.pin) };
        // Dashed in the bubble's stroke: the tie must read as comment chrome
        // and not as an authored edge when a dense canvas separates the two.
        let leader = dashed(&comment.bubble.stroke, 1.0, COMMENT_LEADER_DASH);
        // The digits on the pin take the BUBBLE's fill, the surface this chrome
        // already uses to sit legibly on the pin's amber.
        let pin_count = Appearance {
            fill: Some(comment.bubble.fill.clone()),
            font_family: Some(SPATIAL_THEME_FONT_FAMILY.to_owned()),
            ..Appearance::default()
        };
        SpatialCommentChromeAppearance {
            bubble: shadowed(&comment.bubble),
            pin,
            leader,
            passage: Some(Appearance {
                fill: Some(comment.pin.fill.clone()),
                fill_opacity: Some(COMMENT_PASSAGE_OPACITY),
                ..Appearance::default()
            }),
            // Dashed and unfilled: says "these" without covering them.
            region: Some(Appearance {
                fill: Some("none".to_owned()),
                ..dashed(&comment.pin.fill, 1.5, DASH)
            }),
            pin_count: Some(pin_count),
            text: None,
        }
    }

    fn resolved_overlay(
        &self,
        open: &SpatialCommentChromeAppearance,
    ) -> SpatialCommentChromeAppearance {
        let muted = &self.palette.syntax.comment;
        let bubble = Appearance { stroke: Some(muted.clone()), ..open.bubble.clone() };
        let faded =
            |base: &Option<Appearance>, edit: fn(Appearance) -> Appearance| base.clone().map(edit);
        SpatialCommentChromeAppearance {
            pin: mute_for_resolved(&open.pin),
            bubble: mute_for_resolved(&bubble),
            text: Some(Appearance {
                fill: Some(muted.clone()),
                font_family: Some(SPATIAL_THEME_FONT_FAMILY.to_owned()),
                ..Appearance::default()
            }),
            leader: mute_for_resolved(&open.leader),
            passage: faded(&open.passage, |a| Appearance {
                fill_opacity: Some(COMMENT_PASSAGE_RESOLVED_OPACITY),
                ..a
            }),
            region: faded(&open.region, |a| Appearance {
                stroke_opacity: Some(COMMENT_RESOLVED_OPACITY),
                ..a
            }),
            pin_count: faded(&open.pin_count, |a| Appearance {
                fill_opacity: Some(COMMENT_RESOLVED_OPACITY),
                ..a
            }),
        }
    }
}

impl SpatialAppearanceResolver for SpatialTheme {
    fn mode(&self) -> Option<SpatialThemeMode> {
        Some(self.mode)
    }

    fn resolve_node(&self, node: &SpatialNode) -> SpatialNodeAppearance {
        let styles = &self.palette.node;
        // A node nothing claims takes the text style, as the layout degrades it
        // to chrome only.
        let style = match paint_kind(node) {
            PaintKind::Link => &styles.link,
            PaintKind::File => &styles.file,
            PaintKind::Frame => &styles.group,
            PaintKind::Text | PaintKind::Unclaimed => &styles.text,
        };
        // A preset: accent STROKE and tint FILL. A raw hex: the author's exact
        // fill, unchanged.
        let color = node.color.as_ref();
        let appearance = match preset_accent(color, &self.palette) {
            Some(accent) => solid(&accent.fill, &accent.stroke),
            None => solid(raw_hex(color).unwrap_or(&style.fill), &style.stroke),
        };
        SpatialNodeAppearance {
            appearance: Some(appearance),
            radius: Some(self.palette.corner_radius_px),
        }
    }

    fn resolve_edge(&self, edge: RoutableElement<'_>) -> Option<Appearance> {
        let color = edge.color();
        let stroke = preset_accent(color, &self.palette)
            .map(|accent| accent.stroke.as_str())
            .or_else(|| raw_hex(color))
            .unwrap_or(&self.palette.edge_stroke);
        Some(Appearance { stroke: Some(stroke.to_owned()), ..Appearance::default() })
    }

    fn resolve_label(&self) -> Appearance {
        Appearance {
            fill: Some(self.palette.label_fill.clone()),
            font_family: Some(SPATIAL_THEME_FONT_FAMILY.to_owned()),
            halo: Some(self.palette.surface.clone()),
            ..Appearance::default()
        }
    }

    fn resolve_syntax(&self) -> Option<SpatialSyntaxPalette> {
        Some(self.palette.syntax.clone())
    }

    /// Floating chrome, not content: shadow, neutral card and surface-ringed pin
    /// are what separate a comment from an authored amber node.
    fn resolve_comment(&self) -> Option<SpatialCommentAppearance> {
        let chrome = self.comment_chrome();
        let resolved_overlay = self.resolved_overlay(&chrome);
        Some(SpatialCommentAppearance { chrome, resolved_overlay })
    }

    /// The comment layer's grammar in indigo: one dashed outline for every arm,
    /// a card, and a dotted leader. The dash is what says "not yet".
    fn resolve_proposal(&self) -> Option<SpatialProposalAppearance> {
        let edge = &self.palette.proposal.edge;
        Some(SpatialProposalAppearance {
            outline: Appearance { fill: Some("none".to_owned()), ..dashed(edge, 2.0, DASH) },
            bubble: Appearance {
                drop_shadow: true,
                ..solid(&self.palette.proposal.bubble_fill, edge)
            },
            leader: dashed(edge, 1.0, COMMENT_LEADER_DASH),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_theme_exposes_the_palette_it_was_built_over_and_the_mode_it_paints_for() {
        let custom = SpatialPalette { surface: "#123456".to_owned(), ..SpatialPalette::dark() };
        let theme = create_spatial_theme(SpatialThemeMode::Light, Some(custom.clone()));
        assert_eq!(theme.palette(), &custom);
        assert_eq!(theme.mode(), Some(SpatialThemeMode::Light));
        let bundled = create_spatial_theme(SpatialThemeMode::Dark, None);
        assert_eq!(bundled.palette(), &SpatialPalette::dark());
    }
}
