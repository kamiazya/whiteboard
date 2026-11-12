//! `font-family.ts`, `theme-font.ts` and `text-halo.ts`: the names and numbers
//! several surfaces must agree on.

/// The single family name every spatial-theme label run declares. A
/// composition root's measurer vendors a face under a constant of its own that
/// must name this exact string: the family the SVG names has to be the family
/// the coordinates were measured with.
pub const SPATIAL_THEME_FONT_FAMILY: &str = "Roboto";

/// What the SVG backend EMITS for that family. The bare name stays the
/// identity measurers compare; the generic tail is for a viewer that holds no
/// Roboto and would otherwise draw a serif face.
pub const SPATIAL_THEME_FONT_STACK: &str = "Roboto, system-ui, sans-serif";

/// Breathing room the halo pill adds around a text run's box, in px. The
/// overhang is paint, so the scene bounds add it to the run's reach.
pub const TEXT_HALO_PAD_PX: f64 = 2.0;

/// A theme's family and where its bytes live: a URL rather than the bytes,
/// because the families a theme can name run to several megabytes each and
/// this rides a tool result through a model's context on every view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeFont {
    family: String,
    url: String,
}

impl ThemeFont {
    /// The font, or `None` when either half is empty (`themeFontSchema`'s
    /// `min(1)`; its `strict()` has no analogue in a struct).
    #[must_use]
    pub fn new(family: &str, url: &str) -> Option<Self> {
        (!family.is_empty() && !url.is_empty())
            .then(|| Self { family: family.to_owned(), url: url.to_owned() })
    }

    #[must_use]
    pub fn family(&self) -> &str {
        &self.family
    }

    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn the_stack_leads_with_the_family_it_names() {
        assert!(SPATIAL_THEME_FONT_STACK.starts_with(SPATIAL_THEME_FONT_FAMILY));
        assert_eq!(
            SPATIAL_THEME_FONT_STACK,
            format!("{SPATIAL_THEME_FONT_FAMILY}, system-ui, sans-serif")
        );
    }

    #[test]
    fn a_theme_font_needs_both_a_family_and_a_url() {
        let font = ThemeFont::new("Yomogi", "/fonts/y.woff2");
        assert_eq!(font.as_ref().map(ThemeFont::family), Some("Yomogi"));
        assert_eq!(font.as_ref().map(ThemeFont::url), Some("/fonts/y.woff2"));
        assert_eq!(ThemeFont::new("", "/fonts/y.woff2"), None);
        assert_eq!(ThemeFont::new("Yomogi", ""), None);
    }
}
