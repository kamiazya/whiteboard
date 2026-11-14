//! A degradation as the recordings write it: its kind, the node it is about
//! (empty when none) and its detail.

use whiteboard_canvas_render::compose_node::Degradation;

pub(crate) fn event_of(event: Degradation) -> (&'static str, String, String) {
    match event {
        Degradation::BodyParseFailed { node_id } => ("body-parse-failed", node_id, String::new()),
        Degradation::UnknownNodeKind { node_id, media_type } => {
            ("unknown-node-kind", node_id, media_type)
        }
        Degradation::UnsupportedBackgroundStyle { node_id, style } => {
            ("unsupported-background-style", node_id, style.as_str().to_owned())
        }
        Degradation::UnknownTheme { theme } => ("unknown-theme", String::new(), theme),
        Degradation::FontMissing { family } => ("font-missing", String::new(), family),
    }
}
