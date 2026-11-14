//! Colour BY INTENT (`tags/declared-colours.ts`, ADR-0040 decision 5's declared
//! layer): a box or an edge carrying a tag whose value the workspace's library
//! colours, and with no colour of its own, is drawn in the declared colour.
//!
//! Applied to the CANVAS before layout rather than in the appearance resolver,
//! so the facet score, the appearance and the legend read one intent. An own
//! colour always wins, the library being a default and never an override; a
//! thing whose tags declare two different colours gets neither, since a
//! first-wins rule would paint a choice nobody made. Lines carry no tags.

use std::borrow::Cow;

use whiteboard_model::spatial::{CanvasColor, CanvasColorPreset, SpatialCanvas};
use whiteboard_model::tags::parse_scoped_tag;
use whiteboard_plugin_visual::tag_library::declared_colour_of;
use whiteboard_plugin_visual::visual::TagLibrary;

/// The one colour the library declares for these tags; none when it declares
/// none, or two that differ.
fn intended_colour<'l>(tags: Option<&[String]>, library: &'l TagLibrary) -> Option<&'l str> {
    let mut found: Option<&str> = None;
    for tag in tags.unwrap_or_default() {
        let Some((key, value)) = parse_scoped_tag(tag) else { continue };
        let Some(colour) = declared_colour_of(library, key, value) else { continue };
        if found.is_some_and(|earlier| earlier != colour) {
            return None;
        }
        found = Some(colour);
    }
    found
}

/// A library's colour, which its schema has checked is a preset or a hex colour.
fn canvas_color_of(text: &str) -> CanvasColor {
    CanvasColorPreset::from_wire(text).map_or_else(
        || CanvasColor::CanvasColorHex(text.to_owned()),
        CanvasColor::CanvasColorPreset,
    )
}

fn colour(color: &mut Option<CanvasColor>, tags: Option<&[String]>, library: &TagLibrary) {
    if color.is_none() {
        *color = intended_colour(tags, library).map(canvas_color_of);
    }
}

/// `canvas` with every uncoloured node and edge coloured by what `library`
/// declares for its tags; the canvas as it is when there is no library.
#[must_use]
pub fn with_declared_colours<'c>(
    canvas: &'c SpatialCanvas,
    library: Option<&TagLibrary>,
) -> Cow<'c, SpatialCanvas> {
    let Some(library) = library else { return Cow::Borrowed(canvas) };
    let mut coloured = canvas.clone();
    for node in &mut coloured.nodes {
        colour(&mut node.color, node.tags.as_deref(), library);
    }
    for edge in &mut coloured.edges {
        colour(&mut edge.color, edge.tags.as_deref(), library);
    }
    Cow::Owned(coloured)
}
