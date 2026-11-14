//! What ONE canvas settles before anything is drawn (`withCanvasTheme` and
//! `canvasTheme`): the theme it is drawn in, the appearance that theme paints
//! with, the face its text is declared in, and the silhouette each node takes.
//! Settled from the canvas being laid out, never handed down as an option, so
//! an outer document's setting cannot win over the canvas's own.

use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_plugin_visual::read;

use super::{LayoutOptions, RenderStyle};
use crate::compose_node::{ComposeOptions, Degradation};
use crate::node_box::{NodeBoxOptions, NodeOutlines, resolve_node_outlines};
use crate::theme::appearance::SpatialAppearanceResolver;
use crate::theme::asset::{ThemedAppearance, create_themed_appearance};
use crate::theme::font::SPATIAL_THEME_FONT_FAMILY;
use crate::theme::geometry::{SPATIAL_THEME_GEOMETRY, SpatialGeometry};
use crate::theme::mode::SpatialThemeMode;
use crate::typeset::NestedLayoutBudget;

fn non_negative_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value >= 0.0 { value } else { fallback }
}

fn positive_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 { value } else { fallback }
}

/// The geometry a layout uses (`resolveGeometry`): each field of an override
/// that is not finite and in range falls back to the shared default on its own,
/// so a bad override never puts a NaN or a negative size into the layout.
#[must_use]
pub fn resolve_geometry(geometry: Option<SpatialGeometry>) -> SpatialGeometry {
    let Some(geometry) = geometry else { return SPATIAL_THEME_GEOMETRY };
    let default = SPATIAL_THEME_GEOMETRY;
    SpatialGeometry {
        padding_px: non_negative_or(geometry.padding_px, default.padding_px),
        label_font_size_px: positive_or(geometry.label_font_size_px, default.label_font_size_px),
        min_content_width_px: non_negative_or(
            geometry.min_content_width_px,
            default.min_content_width_px,
        ),
    }
}

/// The theme one canvas is drawn in, as the style decides: none under `Clean`,
/// under `Document` the canvas's own, else the one the canvas it is embedded in
/// is drawn in, and the named one otherwise. A theme the table does not hold is
/// reported, and the canvas drawn clean.
fn canvas_theme<'a>(
    canvas: &SpatialCanvas,
    options: &LayoutOptions<'a>,
    inherited: Option<&str>,
) -> Option<(&'a str, &'a ThemeTokens)> {
    let id = match options.style {
        RenderStyle::Clean => return None,
        RenderStyle::Document => read::canvas_theme(canvas.facets.as_ref(), options.registry)
            .or_else(|| inherited.map(str::to_owned))?,
        RenderStyle::Theme(id) => id.to_owned(),
    };
    let found = options.themes.iter().find(|(name, _)| *name == id);
    if found.is_none() {
        options.host.degrade(Degradation::UnknownTheme { theme: id });
    }
    found.map(|(name, tokens)| (name.as_str(), tokens))
}

/// The family a theme's text is declared in (`themeFace`): the one it names
/// where this surface holds that face, else the bundled one, reporting the face
/// it replaced. The declared family must be the measured one.
fn theme_face(wanted: Option<&str>, options: &LayoutOptions<'_>) -> String {
    let Some(wanted) = wanted else { return SPATIAL_THEME_FONT_FAMILY.to_owned() };
    let available =
        options.font_available.map_or(wanted == SPATIAL_THEME_FONT_FAMILY, |held| held(wanted));
    if available {
        return wanted.to_owned();
    }
    options.host.degrade(Degradation::FontMissing { family: wanted.to_owned() });
    SPATIAL_THEME_FONT_FAMILY.to_owned()
}

/// Where a canvas is laid out: the account its embeds spend from, the documents
/// around it, whether its content is cut to its boxes, and whether the comment
/// layer reaches it.
#[derive(Clone, Copy)]
pub(super) struct Place<'l> {
    pub(super) budget: &'l NestedLayoutBudget,
    pub(super) embed_path: &'l [String],
    pub(super) fit_to_box: bool,
    pub(super) annotated: bool,
}

/// One canvas's settled theme, appearance and silhouettes.
pub(super) struct Level<'a> {
    theme: Option<(&'a str, &'a ThemeTokens)>,
    themed: Option<ThemedAppearance>,
    outlines: NodeOutlines,
    geometry: SpatialGeometry,
}

impl<'a> Level<'a> {
    pub(super) fn of(
        canvas: &SpatialCanvas,
        options: &LayoutOptions<'a>,
        inherited: Option<&str>,
    ) -> Self {
        let theme = canvas_theme(canvas, options, inherited);
        let themed = theme.map(|(_, tokens)| {
            let mode = options.appearance.mode().unwrap_or(SpatialThemeMode::Light);
            create_themed_appearance(
                tokens,
                mode,
                &theme_face(tokens.font_family.as_deref(), options),
            )
        });
        let default_shape = theme.and_then(|(_, tokens)| tokens.defaults.node_shape.as_deref());
        Self {
            theme,
            themed,
            outlines: resolve_node_outlines(&canvas.nodes, options.registry, default_shape),
            geometry: resolve_geometry(options.geometry),
        }
    }

    pub(super) fn node_box<'l>(
        &'l self,
        options: &'l LayoutOptions<'_>,
        fit_to_box: bool,
    ) -> NodeBoxOptions<'l> {
        let appearance: &dyn SpatialAppearanceResolver = match &self.themed {
            Some(themed) => themed,
            None => options.appearance,
        };
        NodeBoxOptions {
            measure: options.measure,
            appearance,
            geometry: self.geometry,
            fit_to_box,
            theme: self.theme.map(|(_, tokens)| tokens),
            outlines: &self.outlines,
            registry: options.registry,
        }
    }

    /// What each node of this canvas is composed with.
    pub(super) fn compose<'l>(
        &'l self,
        options: &'l LayoutOptions<'l>,
        place: Place<'l>,
        empty_frames: &'l [String],
    ) -> ComposeOptions<'l> {
        ComposeOptions {
            node_box: self.node_box(options, place.fit_to_box),
            theme_id: self.theme.map(|(id, _)| id),
            layout: options,
            budget: place.budget,
            embed_path: place.embed_path,
            embed_depth: place.embed_path.len(),
            empty_frames,
            annotated: place.annotated,
        }
    }
}
