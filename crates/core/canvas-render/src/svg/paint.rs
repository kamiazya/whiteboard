//! Presence-only paint: the attribute helpers every SVG element here shares. An
//! absent or unusable field is omitted rather than defaulted, and the shared
//! definitions (the drop shadow) are declared per referencing element and
//! hoisted into one `<defs>`, so a scene without one is unchanged.

use super::format::{NonFinite, format_coord};
use super::vnode::{Attrs, SvgDef, VNode};
use whiteboard_scene::{Appearance, BoundingBox, ScenePoint};

/// The family name every spatial-theme label run declares, and what the
/// backend emits for it: the bare name stays the identity measurers compare,
/// while the generic tail serves a viewer that holds no Roboto.
const THEME_FONT_FAMILY: &str = "Roboto";
const THEME_FONT_STACK: &str = "Roboto, system-ui, sans-serif";

/// Decorative elements (backgrounds, dividers, group wrappers) carry no
/// semantics of their own, so a screen reader does not announce them.
pub(super) const PRESENTATION: &str = "presentation";

/// The attributes of a box, in the fixed order `x y width height`.
pub(super) fn rect_attrs(bbox: &BoundingBox) -> Attrs {
    Attrs::new().num("x", bbox.x).num("y", bbox.y).num("width", bbox.w).num("height", bbox.h)
}

/// Non-finite or negative is dropped; zero is a legitimate stroke-width or font-size.
pub(super) fn non_negative_length(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v >= 0.0)
}

/// SVG treats a negative `rx` as an error and `rx="0"` is noise, so both are omitted.
pub(super) fn positive_length(value: Option<f64>) -> Option<f64> {
    non_negative_length(value).filter(|v| *v > 0.0)
}

fn non_empty(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

/// An opacity that says something: finite and not the initial value `1`.
fn opacity(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && v.to_bits() != 1.0f64.to_bits())
}

/// Presence-only presentation attributes for a shape, run or edge, in the fixed
/// order `fill stroke stroke-width font-family font-size fill-opacity
/// stroke-opacity stroke-dasharray`.
pub(super) fn appearance_attrs(appearance: Option<&Appearance>) -> Attrs {
    let Some(a) = appearance else { return Attrs::new() };
    let family = non_empty(a.font_family.as_ref())
        .map(|name| if name == THEME_FONT_FAMILY { THEME_FONT_STACK } else { name });
    Attrs::new()
        .opt_str("fill", non_empty(a.fill.as_ref()))
        .opt_str("stroke", non_empty(a.stroke.as_ref()))
        .opt_num("stroke-width", non_negative_length(a.stroke_width))
        .opt_str("font-family", family)
        .opt_num("font-size", non_negative_length(a.font_size))
        // `1` is the SVG initial value, so it is omitted to keep an
        // opacity-free scene unchanged.
        .opt_num("fill-opacity", opacity(a.fill_opacity))
        .opt_num("stroke-opacity", opacity(a.stroke_opacity))
        .opt_str("stroke-dasharray", non_empty(a.stroke_dasharray.as_ref()))
}

/// `x,y` pairs, space separated, each coordinate canonical.
pub(super) fn points_attr(points: &[ScenePoint]) -> Result<String, NonFinite> {
    let pairs: Result<Vec<String>, NonFinite> = points
        .iter()
        .map(|p| Ok(format!("{},{}", format_coord(p.x)?, format_coord(p.y)?)))
        .collect();
    Ok(pairs?.join(" "))
}

/// Content-derived id token: every character outside `[A-Za-z0-9-]` becomes `_`
/// and its hex code point, so any authored colour yields a valid, collision-free
/// XML id and the same colour always derives the same id, which is what lets
/// one definition serve every element in that colour.
pub(super) fn id_token(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_string()
            } else {
                format!("_{:x}", u32::from(c))
            }
        })
        .collect()
}

pub(super) const DROP_SHADOW_ID: &str = "wb-drop-shadow";

/// One shared soft shadow for everything that floats (the comment layer's
/// chrome). The region is widened past the default -10%..110% because the
/// blur's reach (3 deviations plus the offset, about 5.5px) exceeds 10% of a
/// small element like the 20px pin, and a clipped shadow reads as an artifact.
pub(super) fn drop_shadow_defs() -> Vec<SvgDef> {
    let filter = VNode::el(
        "filter",
        Attrs::new()
            .str("id", DROP_SHADOW_ID)
            .str("x", "-30%")
            .str("y", "-30%")
            .str("width", "160%")
            .str("height", "160%"),
        vec![
            VNode::leaf(
                "feDropShadow",
                Attrs::new()
                    .num("dx", 0.0)
                    .num("dy", 1.0)
                    .num("stdDeviation", 1.5)
                    .str("flood-color", "#000000")
                    .num("flood-opacity", 0.3),
            )
            .into(),
        ],
    );
    vec![SvgDef { id: DROP_SHADOW_ID.to_string(), node: filter }]
}

/// What a glowing element references: its filter and the definition behind it.
#[derive(Debug, Clone, Default)]
pub(super) struct Glow {
    pub filter: Option<String>,
    pub defs: Vec<SvgDef>,
}

#[cfg(test)]
mod tests {
    use super::{
        appearance_attrs, id_token, non_negative_length, points_attr, positive_length, rect_attrs,
    };
    use crate::svg::vnode::AttrValue;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use whiteboard_scene::{Appearance, BoundingBox, ScenePoint};

    fn names(appearance: &Appearance) -> Vec<String> {
        appearance_attrs(Some(appearance)).iter().map(|(n, _)| n.to_string()).collect()
    }

    fn full() -> Appearance {
        Appearance {
            fill: Some("#111".into()),
            stroke: Some("#222".into()),
            stroke_width: Some(0.0),
            font_family: Some("Georgia".into()),
            font_size: Some(14.0),
            fill_opacity: Some(0.5),
            stroke_opacity: Some(0.25),
            stroke_dasharray: Some("4 3".into()),
            ..Appearance::default()
        }
    }

    #[test]
    fn every_field_is_emitted_in_the_fixed_order_and_zero_is_a_legitimate_length() {
        let attrs = appearance_attrs(Some(&full()));
        let order: Vec<&str> = attrs.iter().map(|(n, _)| n).collect();
        assert_eq!(
            order,
            [
                "fill",
                "stroke",
                "stroke-width",
                "font-family",
                "font-size",
                "fill-opacity",
                "stroke-opacity",
                "stroke-dasharray"
            ]
        );
        assert_eq!(attrs.get_num("stroke-width"), Some(0.0));
        assert_eq!(attrs.get_str("font-family"), Some("Georgia"));
        assert_eq!(attrs.get_str("stroke-dasharray"), Some("4 3"));
        assert!(appearance_attrs(None).iter().next().is_none());
    }

    #[test]
    fn an_empty_string_an_unusable_length_or_an_initial_opacity_is_omitted() {
        let unusable = Appearance {
            fill: Some(String::new()),
            stroke: Some(String::new()),
            stroke_width: Some(-1.0),
            font_family: Some(String::new()),
            font_size: Some(f64::NAN),
            fill_opacity: Some(1.0),
            stroke_opacity: Some(f64::INFINITY),
            stroke_dasharray: Some(String::new()),
            ..Appearance::default()
        };
        assert!(names(&unusable).is_empty());
        let infinite = Appearance {
            stroke_width: Some(f64::INFINITY),
            font_size: Some(-0.5),
            ..Appearance::default()
        };
        assert!(names(&infinite).is_empty());
        let nan_opacity = Appearance { fill_opacity: Some(f64::NAN), ..Appearance::default() };
        assert!(names(&nan_opacity).is_empty());
    }

    #[test]
    fn the_theme_family_is_emitted_as_its_stack_and_any_other_family_as_written() {
        let themed = Appearance { font_family: Some("Roboto".into()), ..Appearance::default() };
        assert_eq!(
            appearance_attrs(Some(&themed)).get("font-family"),
            Some(&AttrValue::Str("Roboto, system-ui, sans-serif".into()))
        );
        let other = Appearance { font_family: Some("Roboto Mono".into()), ..Appearance::default() };
        assert_eq!(appearance_attrs(Some(&other)).get_str("font-family"), Some("Roboto Mono"));
    }

    #[test]
    fn a_length_is_usable_when_finite_and_not_negative_and_positive_when_above_zero() {
        assert_eq!(non_negative_length(Some(0.0)), Some(0.0));
        assert_eq!(non_negative_length(Some(2.0)), Some(2.0));
        for bad in [None, Some(-0.1), Some(f64::NAN), Some(f64::INFINITY)] {
            assert_eq!(non_negative_length(bad), None);
        }
        assert_eq!(positive_length(Some(0.5)), Some(0.5));
        for bad in [None, Some(0.0), Some(-1.0), Some(f64::NAN)] {
            assert_eq!(positive_length(bad), None);
        }
    }

    #[test]
    fn a_box_is_x_y_width_height() {
        let attrs = rect_attrs(&BoundingBox { x: 1.0, y: 2.0, w: 3.0, h: 4.0 });
        let got: Vec<(String, f64)> = attrs
            .iter()
            .map(|(n, v)| (n.to_string(), if let AttrValue::Num(x) = v { *x } else { f64::NAN }))
            .collect();
        assert_eq!(
            got,
            [("x".into(), 1.0), ("y".into(), 2.0), ("width".into(), 3.0), ("height".into(), 4.0)]
        );
    }

    #[test]
    fn points_are_canonical_pairs_joined_by_a_space_and_a_bad_one_refuses() {
        let at = |x, y| ScenePoint { x, y };
        assert_eq!(points_attr(&[at(1.0, 2.5), at(-0.0, 3.0004)]).as_deref(), Ok("1,2.5 0,3"));
        assert_eq!(points_attr(&[]).as_deref(), Ok(""));
        assert!(points_attr(&[at(1.0, f64::NAN)]).is_err());
    }

    #[test]
    fn an_id_token_keeps_letters_digits_and_hyphens_and_hex_encodes_the_rest() {
        assert_eq!(id_token("abcXYZ019-"), "abcXYZ019-");
        assert_eq!(id_token("#ff0000"), "_23ff0000");
        assert_eq!(id_token("rgb(1, 2)"), "rgb_281_2c_202_29");
        assert_eq!(id_token("é"), "_e9");
        assert_eq!(id_token("😀"), "_1f600");
        assert_eq!(id_token("_"), "_5f");
        assert_eq!(id_token(""), "");
    }
}
