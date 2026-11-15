//! A recorded theme asset read through the core's own reader
//! (`theme::tokens`), from the JSON a recording holds.

use serde_json::Value;
use whiteboard_facet_engine::engine::ThemeTokens;

pub(crate) fn theme_tokens(value: &Value) -> Result<ThemeTokens, String> {
    let read = whiteboard_model::json::parse(&value.to_string()).map_err(|e| format!("{e:?}"))?;
    Ok(whiteboard_canvas_render::theme::tokens::theme_tokens(&read))
}
