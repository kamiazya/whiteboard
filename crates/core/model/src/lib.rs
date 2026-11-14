//! The document model's types (ADR-0054). Today it holds the value tree a
//! frontmatter is read into and written from, and the JSON reader that
//! produces the same tree; the types generated from
//! `contracts/model` join it as the model track ports them.

// Core is total: an out-of-bounds index or an overflowing integer is a
// panic, and a panic poisons the wasm instance. A justified exception is an
// `#[expect(..., reason = "...")]` on the one expression, never a blanket
// allow. Test builds are exempt; clippy's non-test pass still checks every
// line of production code.
#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::arithmetic_side_effects))]

pub mod annotation;
pub mod checks;
pub mod frames;
pub mod json;
pub mod mdast;
#[path = "generated/okf.rs"]
pub mod okf;
#[path = "generated/spatial.rs"]
pub mod spatial;
pub mod tags;
pub mod text_anchor;

/// A frontmatter value: what `yaml`'s core schema makes of a document, as
/// `toJS()` hands it to the TypeScript.
///
/// A mapping keeps its keys in written order; a JavaScript object enumerates
/// integer-like keys first, which is a property of that host and is applied
/// where a host needs it ([`enumeration_order`]), not here.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    /// A double. An integer written within +-2^53 lands here.
    Number(f64),
    /// An integer written past 2^53 whose digits the double cannot hold, as
    /// the signed decimal digits it was written as. The TypeScript reads it
    /// as a `bigint`, which `yamlSafeValueSchema` refuses by name.
    BigInt(String),
    String(String),
    Seq(Vec<Value>),
    Map(Map),
}

/// A mapping's entries, in order.
pub type Map = Vec<(String, Value)>;

/// The index JavaScript gives an array-index key, or `None`.
pub fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// `value` with every mapping's keys in the order JavaScript enumerates them:
/// array indices ascending, then the rest as written.
pub fn enumeration_order(value: Value) -> Value {
    match value {
        Value::Seq(items) => Value::Seq(items.into_iter().map(enumeration_order).collect()),
        Value::Map(entries) => {
            let (mut indexed, rest): (Vec<_>, Vec<_>) =
                entries.into_iter().partition(|(key, _)| array_index(key).is_some());
            indexed.sort_by_key(|(key, _)| array_index(key));
            Value::Map(
                indexed
                    .into_iter()
                    .chain(rest)
                    .map(|(key, item)| (key, enumeration_order(item)))
                    .collect(),
            )
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::{Value, array_index, enumeration_order};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn a_generated_enum_names_its_wire_values_both_ways_and_defaults_to_the_first() {
        use super::spatial::{
            Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, EdgeRoutingStyle, EdgeSide,
            LineEnd, LineEndNode, LineJumps,
        };
        macro_rules! round_trip {
            ($enum:ident: $($wire:literal),+) => {
                $(assert_eq!($enum::from_wire($wire).map($enum::as_str), Some($wire));)+
                assert_eq!($enum::from_wire("Top"), None);
                assert_eq!($enum::from_wire(""), None);
                assert_eq!($enum::default().as_str(), [$($wire),+][0]);
            };
        }
        round_trip!(Arrowhead: "none", "arrow");
        round_trip!(BackgroundStyle: "cover", "ratio", "repeat");
        round_trip!(CanvasColorPreset: "1", "2", "3", "4", "5", "6");
        round_trip!(EdgeRoutingStyle: "straight", "orthogonal", "curved");
        round_trip!(EdgeSide: "top", "right", "bottom", "left");
        round_trip!(LineJumps: "none", "arc");
        assert_eq!(CanvasColor::default(), CanvasColor::CanvasColorPreset(CanvasColorPreset::V1));
        assert_eq!(LineEnd::default(), LineEnd::LineEndNode(LineEndNode::default()));
        assert_eq!(LineEndNode::KIND, "node");
        assert_eq!(super::spatial::LineEndPoint::KIND, "point");
    }

    #[test]
    fn an_array_index_is_a_canonical_decimal_below_two_to_the_thirty_two_minus_one() {
        assert_eq!(array_index("0"), Some(0));
        assert_eq!(array_index("42"), Some(42));
        assert_eq!(array_index("4294967294"), Some(4_294_967_294));
        for key in ["", "01", "-1", "1.0", " 1", "4294967295", "4294967296", "a"] {
            assert_eq!(array_index(key), None, "{key:?}");
        }
    }

    #[test]
    fn enumeration_puts_indices_first_ascending_then_the_rest_as_written_at_every_depth() {
        let map = |entries: &[(&str, Value)]| {
            Value::Map(entries.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect())
        };
        let inner = map(&[("b", Value::Null), ("10", Value::Null), ("2", Value::Null)]);
        let written = map(&[
            ("z", Value::Seq(vec![inner.clone()])),
            ("1", Value::Bool(true)),
            ("a", Value::Number(1.0)),
            ("0", Value::String("x".into())),
        ]);
        let inner_ordered = map(&[("2", Value::Null), ("10", Value::Null), ("b", Value::Null)]);
        assert_eq!(
            enumeration_order(written),
            map(&[
                ("0", Value::String("x".into())),
                ("1", Value::Bool(true)),
                ("z", Value::Seq(vec![inner_ordered])),
                ("a", Value::Number(1.0)),
            ])
        );
    }
}
