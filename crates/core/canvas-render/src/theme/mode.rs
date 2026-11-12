//! `spatial-theme-mode.ts`: the two surfaces a theme paints for.

/// Which surface a theme paints for. A request or a cache key that names a
/// mode parses it with [`SpatialThemeMode::from_wire`], so a mode added here
/// is one a caller can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpatialThemeMode {
    Light,
    Dark,
}

impl SpatialThemeMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    #[must_use]
    pub fn from_wire(text: &str) -> Option<Self> {
        match text {
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_mode_round_trips_through_its_written_form_and_nothing_else_parses() {
        for mode in [SpatialThemeMode::Light, SpatialThemeMode::Dark] {
            assert_eq!(SpatialThemeMode::from_wire(mode.as_str()), Some(mode));
        }
        assert_eq!(SpatialThemeMode::from_wire("Light"), None);
        assert_eq!(SpatialThemeMode::from_wire(""), None);
    }
}
