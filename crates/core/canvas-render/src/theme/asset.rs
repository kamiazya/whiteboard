//! `theme-asset.ts`: a registered theme asset (the engine's token contract) turned
//! into the ONE thing a layout consumes, a [`SpatialAppearanceResolver`] for a
//! mode. The mapping is field by field, and the recorded oracle holds it equal
//! to the TypeScript's over every bundled theme and the shapes they do not reach.

use std::rc::Rc;

use whiteboard_facet_engine::engine::{
    Fill, NodeStyleTokens, PaletteTokens, PresetAccent, ThemeTokens,
};
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{Appearance, Glow};

use super::appearance::{
    RoutableElement, SpatialAppearanceResolver, SpatialCommentAppearance, SpatialNodeAppearance,
    SpatialProposalAppearance,
};
use super::markdown::MarkdownTheme;
use super::mode::SpatialThemeMode;
use super::palette::{
    SpatialCommentChrome, SpatialNodeStyle, SpatialNodeStyles, SpatialPalette, SpatialPresetAccent,
    SpatialPresets, SpatialProposalChrome, SpatialSyntaxPalette,
};
use super::spatial_theme::{SpatialTheme, create_spatial_theme};
use whiteboard_model::node_content::is_frame;

fn style_of(tokens: &NodeStyleTokens) -> SpatialNodeStyle {
    let fill = match &tokens.fill {
        Fill::HexColor(text) | Fill::NoFill(text) => text.clone(),
    };
    SpatialNodeStyle { fill, stroke: tokens.stroke.clone() }
}

fn accent_of(tokens: &PresetAccent) -> SpatialPresetAccent {
    SpatialPresetAccent { stroke: tokens.stroke.clone(), fill: tokens.fill.clone() }
}

/// `paletteFromTokens`.
#[must_use]
pub fn palette_from_tokens(tokens: &PaletteTokens) -> SpatialPalette {
    let presets = &tokens.presets;
    SpatialPalette {
        node: SpatialNodeStyles {
            text: style_of(&tokens.node.text),
            file: style_of(&tokens.node.file),
            link: style_of(&tokens.node.link),
            group: style_of(&tokens.node.group),
        },
        edge_stroke: tokens.edge_stroke.clone(),
        label_fill: tokens.label_fill.clone(),
        surface: tokens.surface.clone(),
        corner_radius_px: tokens.corner_radius_px,
        presets: SpatialPresets {
            n1: accent_of(&presets.n1),
            n2: accent_of(&presets.n2),
            n3: accent_of(&presets.n3),
            n4: accent_of(&presets.n4),
            n5: accent_of(&presets.n5),
            n6: accent_of(&presets.n6),
        },
        syntax: SpatialSyntaxPalette {
            keyword: tokens.syntax.keyword.clone(),
            string: tokens.syntax.string.clone(),
            number: tokens.syntax.number.clone(),
            comment: tokens.syntax.comment.clone(),
        },
        comment: SpatialCommentChrome {
            pin: style_of(&tokens.comment.pin),
            bubble: style_of(&tokens.comment.bubble),
        },
        proposal: SpatialProposalChrome {
            edge: tokens.proposal.edge.clone(),
            bubble_fill: tokens.proposal.bubble_fill.clone(),
        },
        markdown_chrome: tokens.markdown_chrome.clone(),
    }
}

const fn palette_of(tokens: &ThemeTokens, mode: SpatialThemeMode) -> &PaletteTokens {
    match mode {
        SpatialThemeMode::Light => &tokens.palette.light,
        SpatialThemeMode::Dark => &tokens.palette.dark,
    }
}

/// `markdownTheme`: the node theme, with the theme's own neutral where its
/// palette names one. A body is two-thirds furniture (the code panel, the
/// blockquote rail, the checkbox); without this the prose took the theme while
/// the furniture stayed the bundled slate on every board. An absent mode is
/// light.
#[must_use]
pub fn markdown_theme(
    tokens: Option<&ThemeTokens>,
    mode: Option<SpatialThemeMode>,
) -> MarkdownTheme {
    let chrome = tokens.and_then(|t| {
        palette_of(t, mode.unwrap_or(SpatialThemeMode::Light)).markdown_chrome.as_ref()
    });
    match chrome {
        None => MarkdownTheme::node(),
        Some(color) => MarkdownTheme { chrome_color: color.clone(), ..MarkdownTheme::node() },
    }
}

/// A theme asset's paint over a base theme: the line weight on node chrome and
/// edges, a frame's own dash and width, and the halo.
#[derive(Debug, Clone, PartialEq)]
pub struct ThemedAppearance {
    base: SpatialTheme,
    /// The family every label and body run DECLARES, already resolved by the
    /// caller against what its surface can measure: the family named in the SVG
    /// must be the family the coordinates were measured with.
    font_family: String,
    stroke_width: Option<f64>,
    glow: Option<Glow>,
    frame_dasharray: Option<String>,
    frame_stroke_width: Option<f64>,
}

/// `createThemedAppearance`, unmemoised; see [`ThemedAppearanceCache`].
#[must_use]
pub fn create_themed_appearance(
    tokens: &ThemeTokens,
    mode: SpatialThemeMode,
    font_family: &str,
) -> ThemedAppearance {
    let palette = palette_from_tokens(palette_of(tokens, mode));
    let frame = tokens.defaults.group_frame.as_ref();
    ThemedAppearance {
        base: create_spatial_theme(mode, Some(palette)),
        font_family: font_family.to_owned(),
        stroke_width: tokens.stroke_width_px,
        glow: tokens.glow.as_ref().map(|glow| Glow { radius_px: glow.radius_px }),
        frame_dasharray: frame.and_then(|f| f.stroke_dasharray.clone()),
        frame_stroke_width: frame.and_then(|f| f.stroke_width),
    }
}

impl SpatialAppearanceResolver for ThemedAppearance {
    fn mode(&self) -> Option<SpatialThemeMode> {
        self.base.mode()
    }

    /// The theme's line weight reaches node chrome, and a frame's own width and
    /// dash win over it. The halo rides node chrome in the element's own paint:
    /// not a group frame, the largest and least informative thing on the board
    /// to bloom.
    fn resolve_node(&self, node: &SpatialNode) -> SpatialNodeAppearance {
        let resolved = self.base.resolve_node(node);
        let mut appearance = resolved.appearance.unwrap_or_default();
        if self.stroke_width.is_some() {
            appearance.stroke_width = self.stroke_width;
        }
        if is_frame(node) {
            if self.frame_dasharray.is_some() {
                appearance.stroke_dasharray.clone_from(&self.frame_dasharray);
            }
            if self.frame_stroke_width.is_some() {
                appearance.stroke_width = self.frame_stroke_width;
            }
        } else if self.glow.is_some() {
            appearance.glow = self.glow;
        }
        SpatialNodeAppearance { appearance: Some(appearance), radius: resolved.radius }
    }

    /// Weight and glow reach edges, never a label: a 12px glyph blurred at three
    /// deviations thickens into a smudge, and a label already sits on its halo.
    fn resolve_edge(&self, edge: RoutableElement<'_>) -> Option<Appearance> {
        let resolved = self.base.resolve_edge(edge)?;
        Some(Appearance {
            stroke_width: self.stroke_width.or(resolved.stroke_width),
            glow: self.glow.or(resolved.glow),
            ..resolved
        })
    }

    fn resolve_label(&self) -> Appearance {
        Appearance { font_family: Some(self.font_family.clone()), ..self.base.resolve_label() }
    }

    fn resolve_syntax(&self) -> Option<SpatialSyntaxPalette> {
        self.base.resolve_syntax()
    }

    fn resolve_comment(&self) -> Option<SpatialCommentAppearance> {
        self.base.resolve_comment()
    }

    fn resolve_proposal(&self) -> Option<SpatialProposalAppearance> {
        self.base.resolve_proposal()
    }
}

/// `createThemedAppearance`'s memo, per call site. The TypeScript keeps a
/// module-level `WeakMap` keyed on the tokens object so an editor that resolves
/// the same theme every frame is handed the SAME resolver; this is that identity
/// without a global: a cache is bound to one token bundle, lives as long as the
/// layout (or editor) that owns it, and answers the same [`Rc`] for the same
/// (mode, family). Two caches over the same tokens do not share, where two
/// callers of the TypeScript do.
#[derive(Debug)]
pub struct ThemedAppearanceCache<'t> {
    tokens: &'t ThemeTokens,
    // ponytail: a linear scan; the keys are two modes times the few families one surface declares.
    entries: Vec<(SpatialThemeMode, String, Rc<ThemedAppearance>)>,
}

impl<'t> ThemedAppearanceCache<'t> {
    #[must_use]
    pub const fn new(tokens: &'t ThemeTokens) -> Self {
        Self { tokens, entries: Vec::new() }
    }

    pub fn get(&mut self, mode: SpatialThemeMode, font_family: &str) -> Rc<ThemedAppearance> {
        if let Some((_, _, hit)) =
            self.entries.iter().find(|(m, family, _)| *m == mode && family == font_family)
        {
            return Rc::clone(hit);
        }
        let built = Rc::new(create_themed_appearance(self.tokens, mode, font_family));
        self.entries.push((mode, font_family.to_owned(), Rc::clone(&built)));
        built
    }
}
