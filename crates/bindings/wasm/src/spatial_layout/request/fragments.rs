//! The rendered math blocks and fences a request carries (`fragments`): the
//! caller's table of `[key, {svg, width?, height?}]` rows, keyed as
//! canvas-render's `fragmentAskKey` keys them.

use whiteboard_canvas_render::typeset::Rendered;
use whiteboard_model::Value;

use super::table_of;
use crate::json_canvas_wire::{Fields, number_of, string_of};

fn fragment_of(value: &Value) -> Option<Rendered> {
    let mut f = Fields::of(value)?;
    let fragment = Rendered::Fragment {
        svg: f.field("svg", string_of)??,
        width: f.field("width", number_of)?,
        height: f.field("height", number_of)?,
    };
    f.all_named().then_some(fragment)
}

pub(super) fn fragments_of(value: &Value) -> Option<Vec<(String, Rendered)>> {
    table_of(value, fragment_of)
}
