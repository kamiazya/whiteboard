//! The reference bundle a request carries (`ReferenceWire`): the graph a
//! keeper loaded, and the alias, title and extras tables over it.

use whiteboard_canvas_render::node_box::{FacetCard, FacetRow};
use whiteboard_canvas_render::references::{
    ExtraImage, LoadedReference, ReferenceExtra, ReferenceWire,
};
use whiteboard_model::Value;

use super::{flag_of, table_of};
use crate::json_canvas_wire::{Fields, Read, canvas_of, items_of, number_of, string_of};

/// A graph entry: `null` is "looked up, nothing there".
fn loaded_of(value: &Value) -> Read<LoadedReference> {
    if *value == Value::Null {
        return Some(None);
    }
    let mut f = Fields::of(value)?;
    let loaded = LoadedReference {
        document_id: f.field("documentId", string_of)?,
        name: f.field("name", string_of)?,
        body: f.field("body", string_of)?,
        canvas: f.field("canvas", canvas_of)?,
    };
    f.all_named().then_some(Some(loaded))
}

fn image_of(value: &Value) -> Option<ExtraImage> {
    let mut f = Fields::of(value)?;
    let image = ExtraImage {
        href: f.field("href", string_of)??,
        alt: f.field("alt", string_of)?,
        width: f.field("width", number_of)?,
        height: f.field("height", number_of)?,
    };
    f.all_named().then_some(image)
}

fn row_of(value: &Value) -> Option<FacetRow> {
    let mut f = Fields::of(value)?;
    let row =
        FacetRow { label: f.field("label", string_of)??, value: f.field("value", string_of)?? };
    f.all_named().then_some(row)
}

fn card_of(value: &Value) -> Option<FacetCard> {
    let mut f = Fields::of(value)?;
    let card = FacetCard {
        title: f.field("title", string_of)?,
        rows: f.field("rows", |v| items_of(v, row_of))??,
    };
    f.all_named().then_some(card)
}

fn extra_of(value: &Value) -> Option<ReferenceExtra> {
    let mut f = Fields::of(value)?;
    let extra = ReferenceExtra {
        label: f.field("label", string_of)?,
        missing: f.field("missing", flag_of)?,
        image: f.field("image", image_of)?,
        facets: f.field("facets", card_of)?,
    };
    f.all_named().then_some(extra)
}

pub(super) fn references_of(value: &Value) -> Option<ReferenceWire> {
    let mut f = Fields::of(value)?;
    let wire = ReferenceWire {
        entries: f.field("entries", |v| table_of(v, loaded_of))??,
        aliases: f.field("aliases", |v| table_of(v, string_of))??,
        titles: f.field("titles", |v| table_of(v, string_of))??,
        extras: f.field("extras", |v| table_of(v, extra_of))??,
    };
    f.all_named().then_some(wire)
}
