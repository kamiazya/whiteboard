//! The first segment of a series nobody holds.

use crate::document_path::is_workspace_segment;

/// `base` when it is free, else the first `base-2`, `base-3`, ... that is.
/// `None` once a suffixed candidate leaves the segment grammar or the series
/// passes its bound (a thousand), where the workspace is addressed by its
/// canonical id instead.
#[must_use]
pub fn first_free_segment(base: &str, is_taken: impl Fn(&str) -> bool) -> Option<String> {
    if !is_taken(base) {
        return Some(base.to_owned());
    }
    for n in 2..1000_u32 {
        let candidate = format!("{base}-{n}");
        if !is_workspace_segment(&candidate) {
            return None;
        }
        if !is_taken(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn the_series_starts_at_two() {
        assert_eq!(first_free_segment("plan", |s| s == "plan").as_deref(), Some("plan-2"));
        assert_eq!(first_free_segment("plan", |_| false).as_deref(), Some("plan"));
    }

    #[test]
    fn the_series_ends_at_the_bound() {
        assert_eq!(first_free_segment("plan", |_| true), None);
        let free_999 = first_free_segment("plan", |s| s != "plan-999");
        assert_eq!(free_999.as_deref(), Some("plan-999"));
    }
}
