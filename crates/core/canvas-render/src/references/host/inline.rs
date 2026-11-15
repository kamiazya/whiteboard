//! The inline seams over the wire: the visual plugin's shortcode tables, a
//! document's title and an embed's name from the graph, a picture from the
//! extras.

use whiteboard_plugin_visual::shortcode::{expand_emoji_shortcodes, icon_shortcode_ranges};

use super::WireHost;
use crate::typeset::{IconRange, ImageRef, InlineSeams};

impl InlineSeams for WireHost<'_> {
    fn expand_emoji(&self, text: &str) -> String {
        expand_emoji_shortcodes(text)
    }

    fn icon_ranges(&self, text: &str) -> Vec<IconRange> {
        icon_shortcode_ranges(text)
            .into_iter()
            .map(|range| IconRange { from: range.from, to: range.to, name: range.name })
            .collect()
    }

    fn document_title(&self, document_id: &str) -> Option<String> {
        self.by_id(document_id)
            .and_then(|entry| entry.name.clone())
            .or_else(|| self.title(document_id))
    }

    fn embed_name(&self, document_id: &str) -> Option<String> {
        self.embedded(document_id)?.0
    }

    fn embed_pending(&self, _: &str) -> bool {
        false
    }

    fn image_reference(&self, url: &str) -> Option<ImageRef> {
        let extra = self.wire.extras.iter().rev().find(|(key, _)| key == url)?;
        let image = extra.1.image.as_ref()?;
        Some(ImageRef { href: image.href.clone(), width: image.width, height: image.height })
    }
}
