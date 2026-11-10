//! The dialect's typed parse: every keyword a field under
//! `deny_unknown_fields`, so a keyword the emitters do not implement is
//! refused by name. What stands together is `dialect.rs`'s to check.

use std::collections::BTreeMap;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};

fn yes() -> bool {
    true
}

/// A keyword read as present or absent: a key holding `null` is refused
/// rather than read as absent.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Contract {
    #[serde(rename = "$schema")]
    pub(super) schema: String,
    pub(super) title: String,
    pub(super) description: String,
    #[serde(rename = "x-wb-emit")]
    pub(super) emit: Emit,
    /// The hand-written modules beside the outputs that hold every named check.
    #[serde(rename = "x-wb-checks", default, deserialize_with = "present")]
    pub(super) checks: Option<CheckModules>,
    /// Whether the Zod half carries `.describe()`: it does where a description
    /// is published to a model, and does not where the hand-written schemas
    /// never did.
    #[serde(rename = "x-wb-describe", default = "yes")]
    pub(super) describe: bool,
    /// Whether the Rust half derives serde. A crate that may take no
    /// third-party dependency emits plain data types instead.
    #[serde(rename = "x-wb-rustSerde", default = "yes")]
    pub(super) rust_serde: bool,
    /// Whether an exported TypeScript type is `Readonly<z.infer<..>>`.
    #[serde(rename = "x-wb-readonlyTypes", default = "yes")]
    pub(super) readonly_types: bool,
    #[serde(rename = "$defs")]
    pub(super) defs: UniqueMap<Node>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Emit {
    pub(super) zod: String,
    pub(super) rust: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CheckModules {
    pub(super) zod: String,
    pub(super) rust: String,
}

/// One schema, as a definition or as a property of one. Which keywords may
/// stand together depends on its form, and `lower` states that.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Node {
    #[serde(default, deserialize_with = "present")]
    pub(super) description: Option<String>,
    #[serde(rename = "type", default, deserialize_with = "present")]
    pub(super) kind: Option<Kind>,
    #[serde(default, deserialize_with = "present")]
    pub(super) minimum: Option<f64>,
    #[serde(rename = "x-wb-minUtf16", default, deserialize_with = "present")]
    pub(super) min_utf16: Option<u32>,
    #[serde(default, deserialize_with = "present")]
    pub(super) pattern: Option<String>,
    #[serde(rename = "x-wb-matcher", default, deserialize_with = "present")]
    pub(super) matcher: Option<String>,
    #[serde(rename = "x-wb-message", default, deserialize_with = "present")]
    pub(super) message: Option<String>,
    #[serde(rename = "x-wb-check", default, deserialize_with = "present")]
    pub(super) check: Option<String>,
    #[serde(rename = "enum", default, deserialize_with = "present")]
    pub(super) values: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    pub(super) items: Option<Box<Node>>,
    #[serde(rename = "minItems", default, deserialize_with = "present")]
    pub(super) min_items: Option<u32>,
    #[serde(rename = "maxItems", default, deserialize_with = "present")]
    pub(super) max_items: Option<u32>,
    #[serde(rename = "anyOf", default, deserialize_with = "present")]
    pub(super) any_of: Option<Vec<Node>>,
    /// Whether the Zod half registers the definition under its own name in
    /// Zod's global registry, which is where a tool schema's `$ref` takes it from.
    #[serde(rename = "x-wb-registered", default, deserialize_with = "present")]
    pub(super) registered: Option<bool>,
    #[serde(rename = "$ref", default, deserialize_with = "present")]
    pub(super) reference: Option<String>,
    #[serde(rename = "x-wb-any", default, deserialize_with = "present")]
    pub(super) any: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub(super) properties: Option<UniqueMap<Node>>,
    #[serde(default, deserialize_with = "present")]
    pub(super) required: Option<Vec<String>>,
    #[serde(rename = "x-wb-order", default, deserialize_with = "present")]
    pub(super) order: Option<Vec<String>>,
    #[serde(rename = "additionalProperties", default, deserialize_with = "present")]
    pub(super) additional: Option<Additional>,
    #[serde(rename = "x-wb-unknownKeys", default, deserialize_with = "present")]
    pub(super) unknown_keys: Option<Unknown>,
}

#[derive(Debug, Deserialize)]
pub(super) enum Kind {
    #[serde(rename = "number")]
    Number,
    #[serde(rename = "string")]
    String,
    #[serde(rename = "array")]
    Array,
    #[serde(rename = "object")]
    Object,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum Additional {
    Flag(bool),
    Schema(Box<Node>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(super) enum Unknown {
    #[serde(rename = "refuse")]
    Refuse,
    #[serde(rename = "strip")]
    Strip,
    #[serde(rename = "keep")]
    Keep,
}

pub(crate) fn parse(text: &str) -> Result<Contract, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

impl Node {
    /// The keywords present beyond `description`, `type` and `x-wb-registered`
    /// (which belongs to a definition whatever its form), by name.
    pub(super) fn keywords(&self) -> Vec<&'static str> {
        [
            (self.minimum.is_some(), "minimum"),
            (self.min_utf16.is_some(), "x-wb-minUtf16"),
            (self.pattern.is_some(), "pattern"),
            (self.matcher.is_some(), "x-wb-matcher"),
            (self.message.is_some(), "x-wb-message"),
            (self.check.is_some(), "x-wb-check"),
            (self.values.is_some(), "enum"),
            (self.items.is_some(), "items"),
            (self.min_items.is_some(), "minItems"),
            (self.max_items.is_some(), "maxItems"),
            (self.any_of.is_some(), "anyOf"),
            (self.reference.is_some(), "$ref"),
            (self.any.is_some(), "x-wb-any"),
            (self.properties.is_some(), "properties"),
            (self.required.is_some(), "required"),
            (self.order.is_some(), "x-wb-order"),
            (self.additional.is_some(), "additionalProperties"),
            (self.unknown_keys.is_some(), "x-wb-unknownKeys"),
        ]
        .into_iter()
        .filter_map(|(there, name)| there.then_some(name))
        .collect()
    }
}

/// A JSON object read into a map that refuses a repeated key, where a plain
/// map keeps the last one silently.
#[derive(Debug)]
pub(super) struct UniqueMap<V>(pub(super) BTreeMap<String, V>);

impl<'de, V: Deserialize<'de>> Deserialize<'de> for UniqueMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(UniqueVisitor(PhantomData))
    }
}

struct UniqueVisitor<V>(PhantomData<V>);

impl<'de, V: Deserialize<'de>> Visitor<'de> for UniqueVisitor<V> {
    type Value = UniqueMap<V>;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut out = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, V>()? {
            if out.contains_key(&key) {
                return Err(serde::de::Error::custom(format!("duplicate key `{key}`")));
            }
            out.insert(key, value);
        }
        Ok(UniqueMap(out))
    }
}
