//! The dialect's typed parse: every keyword a field under
//! `deny_unknown_fields`, so a keyword the emitters do not implement is
//! refused by name. What stands together is `dialect.rs`'s to check.

use std::collections::BTreeMap;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, SeqAccess, Visitor};

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
    /// Absent where the Zod half needs no named check: a pattern is a regex
    /// there and only its Rust matcher is hand-written.
    #[serde(default, deserialize_with = "present")]
    pub(super) zod: Option<String>,
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
    /// What Zod answers when a list is longer than `maxItems`.
    #[serde(rename = "x-wb-maxItemsMessage", default, deserialize_with = "present")]
    pub(super) max_items_message: Option<String>,
    #[serde(rename = "anyOf", default, deserialize_with = "present")]
    pub(super) any_of: Option<Vec<Node>>,
    #[serde(rename = "oneOf", default, deserialize_with = "present")]
    pub(super) one_of: Option<Vec<Node>>,
    /// The property whose constant value names the member of a `oneOf`.
    #[serde(default, deserialize_with = "present")]
    pub(super) discriminator: Option<Discriminator>,
    /// A string that is always this one value.
    #[serde(rename = "const", default, deserialize_with = "present")]
    pub(super) constant: Option<String>,
    /// What an absent array or record reads as; only `[]` and `{}` parse,
    /// since `Never` has no value to deserialize.
    #[serde(default, deserialize_with = "present")]
    pub(super) default: Option<Empty>,
    /// The definition naming what a record's keys may be.
    #[serde(rename = "propertyNames", default, deserialize_with = "present")]
    pub(super) property_names: Option<Box<Node>>,
    /// How many entries a record may hold.
    #[serde(rename = "maxProperties", default, deserialize_with = "present")]
    pub(super) max_properties: Option<u32>,
    /// What Zod answers when a record holds more than `maxProperties`, with
    /// `{count}` standing for how many it holds.
    #[serde(rename = "x-wb-maxPropertiesMessage", default, deserialize_with = "present")]
    pub(super) max_properties_message: Option<String>,
    /// The object whose properties this one adds to.
    #[serde(rename = "x-wb-extends", default, deserialize_with = "present")]
    pub(super) extends: Option<String>,
    /// A property that reads as absent when its value is malformed.
    #[serde(rename = "x-wb-lenient", default, deserialize_with = "present")]
    pub(super) lenient: Option<bool>,
    /// The text a model reads for a property, published as its `.describe()`.
    #[serde(rename = "x-wb-describe", default, deserialize_with = "present")]
    pub(super) published: Option<String>,
    /// The module whose hand-written Zod schema stands for this definition.
    #[serde(rename = "x-wb-external", default, deserialize_with = "present")]
    pub(super) external: Option<String>,
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

/// A type with no value, so a list or a map of it can only be empty.
#[derive(Debug, Deserialize)]
pub(super) enum Never {}

/// The one default the dialect takes: an empty list or an empty record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Empty {
    List,
    Record,
}

impl<'de> Deserialize<'de> for Empty {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(EmptyVisitor)
    }
}

struct EmptyVisitor;

impl<'de> Visitor<'de> for EmptyVisitor {
    type Value = Empty;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("an empty list or an empty object")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Empty, A::Error> {
        seq.next_element::<Never>()?;
        Ok(Empty::List)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Empty, A::Error> {
        map.next_key::<Never>()?;
        Ok(Empty::Record)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Discriminator {
    #[serde(rename = "propertyName")]
    pub(super) property: String,
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
    #[serde(rename = "boolean")]
    Boolean,
    #[serde(rename = "integer")]
    Integer,
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
    /// The keywords present beyond `description`, `type`, the decorations of a
    /// property (`x-wb-lenient`, `x-wb-describe`) and of a definition
    /// (`x-wb-registered`, `x-wb-external`), by name.
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
            (self.max_items_message.is_some(), "x-wb-maxItemsMessage"),
            (self.any_of.is_some(), "anyOf"),
            (self.one_of.is_some(), "oneOf"),
            (self.discriminator.is_some(), "discriminator"),
            (self.constant.is_some(), "const"),
            (self.default.is_some(), "default"),
            (self.property_names.is_some(), "propertyNames"),
            (self.max_properties.is_some(), "maxProperties"),
            (self.max_properties_message.is_some(), "x-wb-maxPropertiesMessage"),
            (self.extends.is_some(), "x-wb-extends"),
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
