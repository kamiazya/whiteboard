//! The inline seams over the wire: a document's title and an embed's name from
//! the graph, a picture from the extras, and the shortcode decline.

use super::{Refused, WireHost};
use crate::typeset::{IconRange, ImageRef, InlineSeams};

/// A name between two colons, which only the plugin's tables can read.
fn may_hold_shortcode(text: &str) -> bool {
    text.matches(':').nth(1).is_some()
}

impl InlineSeams for WireHost<'_> {
    fn expand_emoji(&self, text: &str) -> String {
        if may_hold_shortcode(text) {
            self.refuse(Refused::Shortcode);
        }
        text.to_owned()
    }

    fn icon_ranges(&self, text: &str) -> Vec<IconRange> {
        if may_hold_shortcode(text) {
            self.refuse(Refused::Shortcode);
        }
        Vec::new()
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
