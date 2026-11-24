//! A definition as `z.toJSONSchema` (Zod 4.6.7, its defaults: draft 2020-12,
//! the output side) writes the schema `cargo xtask codegen` generates from it,
//! so a model reads the same bytes from either server (owner decision q136).
//!
//! The rules, each what Zod writes for what the generator emits:
//!
//! - every answer opens with `$schema`, and a definition the generator
//!   registers (`x-wb-registered`) is written once under `$defs` at its end,
//!   in the order first met, and named by `$ref` wherever it is used;
//!   registering replaces a description, so a registered one has none;
//! - any other reference is the definition it names, inlined;
//! - a string is `type`, `minLength`, `pattern`; a constant or an enum is
//!   `type` then `const` or `enum`; a number `type` then its bound; a named
//!   check writes nothing;
//! - an array writes its length bounds BEFORE `type` and `items`;
//! - a record is `type`, `propertyNames` (a bare string without one) and
//!   `additionalProperties`, then `required` naming every key when its keys
//!   are a closed set (an enum, a constant, or a union of those); a bound on
//!   its count writes nothing, but makes the record a `pipe`, which a
//!   description wraps like an optional;
//! - an object is `type`, `properties` in `x-wb-order`, `required` when any
//!   property is (a defaulted one is: the output always holds it), and
//!   `additionalProperties`, `false` whether unknown keys are refused or
//!   stripped;
//! - a description the generator writes with `.describe()` follows the
//!   schema it describes, replacing one already there, except on a property
//!   that is optional, defaulted or a reference to a registered definition:
//!   that one is written first, after the `default`, and drops the inner one.
//!
//! The generator describes with the contract's `description` when the
//! contract sets `x-wb-describe`, and otherwise with a definition's or a
//! property's own `x-wb-describe` text; a capped record is never described.

use whiteboard_model::{Map, Value};

/// One contract's definitions as written, how the generator describes them,
/// and the definitions it leaves to another contract, by the scope holding
/// that contract.
pub(super) struct Scope {
    pub(super) defs: Map,
    pub(super) describe: bool,
    pub(super) externals: Vec<(String, usize)>,
}

impl Scope {
    /// A contract's scope; `contract` is its whole text as a value.
    pub(super) fn of(contract: &Value) -> Self {
        let defs = match get(contract, "$defs") {
            Some(Value::Map(defs)) => defs.clone(),
            _ => Map::new(),
        };
        let describe = get(contract, "x-wb-describe") == Some(&Value::Bool(true));
        Self { defs, describe, externals: Vec::new() }
    }
}

const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";

fn get<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    match value {
        Value::Map(map) => map.iter().find(|(name, _)| name == key).map(|(_, held)| held),
        _ => None,
    }
}

fn text<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    match get(value, key) {
        Some(Value::String(held)) => Some(held),
        _ => None,
    }
}

fn member(key: &str, value: Value) -> (String, Value) {
    (key.to_owned(), value)
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

/// `members` with `description` set to `text`: replaced where it stands, or
/// appended.
fn described(mut members: Map, text: &str) -> Map {
    match members.iter_mut().find(|(key, _)| key == "description") {
        Some((_, held)) => *held = string(text),
        None => members.push(member("description", string(text))),
    }
    members
}

fn members_of(value: Value) -> Map {
    match value {
        Value::Map(members) => members,
        _ => Map::new(),
    }
}

/// The definition `name` of the scope `scope` as Zod's JSON Schema, or `None`
/// for a name the scope does not hold.
pub(super) fn publish(scopes: &[Scope], scope: usize, name: &str) -> Option<Value> {
    let mut writer = Writer { scopes, registered: Vec::new() };
    let root = writer.definition(scope, name)?;
    let mut out = vec![member("$schema", string(DIALECT))];
    out.extend(members_of(root));
    if !writer.registered.is_empty() {
        out.push(member("$defs", Value::Map(writer.registered)));
    }
    Some(Value::Map(out))
}

struct Writer<'s> {
    scopes: &'s [Scope],
    registered: Map,
}

impl<'s> Writer<'s> {
    /// Where `name` is written: its own scope, or the contract it is left to.
    fn resolve(&self, scope: usize, name: &str) -> Option<(usize, &'s Value)> {
        let scopes = self.scopes;
        let held = scopes.get(scope)?;
        let owner = held.externals.iter().find(|(external, _)| external == name);
        let scope = owner.map_or(scope, |(_, other)| *other);
        let defs = &scopes.get(scope)?.defs;
        defs.iter().find(|(key, _)| key == name).map(|(_, written)| (scope, written))
    }

    fn definition(&mut self, scope: usize, name: &str) -> Option<Value> {
        let (scope, written) = self.resolve(scope, name)?;
        if get(written, "x-wb-registered") == Some(&Value::Bool(true)) {
            if !self.registered.iter().any(|(key, _)| key == name) {
                // Held before its body is written, so it is first met here.
                self.registered.push(member(name, Value::Null));
                let body = self.node(scope, written);
                if let Some((_, slot)) = self.registered.iter_mut().find(|(key, _)| key == name) {
                    *slot = body;
                }
            }
            return Some(Value::Map(vec![member("$ref", string(&format!("#/$defs/{name}")))]));
        }
        let body = self.node(scope, written);
        let capped = get(written, "maxProperties").is_some();
        match self.description(scope, written) {
            Some(text) if !capped => Some(Value::Map(described(members_of(body), text))),
            _ => Some(body),
        }
    }

    /// What the generator describes `written` with, if anything.
    fn description<'v>(&self, scope: usize, written: &'v Value) -> Option<&'v str> {
        let describe = self.scopes.get(scope).is_some_and(|held| held.describe);
        if describe { text(written, "description") } else { text(written, "x-wb-describe") }
    }

    fn node(&mut self, scope: usize, written: &Value) -> Value {
        if let Some(target) = text(written, "$ref") {
            let name = target.strip_prefix("#/$defs/").unwrap_or(target);
            return self.definition(scope, name).unwrap_or(Value::Map(Map::new()));
        }
        for union in ["anyOf", "oneOf"] {
            if let Some(Value::Seq(arms)) = get(written, union) {
                let arms = arms.iter().map(|arm| self.node(scope, arm)).collect();
                return Value::Map(vec![member(union, Value::Seq(arms))]);
            }
        }
        match text(written, "type") {
            Some("array") => self.array(scope, written),
            Some("object") if get(written, "properties").is_some() => self.object(scope, written),
            Some("object") => self.record(scope, written),
            Some(kind) => Value::Map(scalar(kind, written)),
            // `x-wb-any`: Zod's `unknown()` constrains nothing.
            None => Value::Map(Map::new()),
        }
    }

    fn array(&mut self, scope: usize, written: &Value) -> Value {
        let mut out: Map = ["minItems", "maxItems"]
            .into_iter()
            .filter_map(|key| get(written, key).map(|bound| member(key, bound.clone())))
            .collect();
        out.push(member("type", string("array")));
        let items = get(written, "items").map_or(Value::Map(Map::new()), |i| self.node(scope, i));
        out.push(member("items", items));
        Value::Map(out)
    }

    fn record(&mut self, scope: usize, written: &Value) -> Value {
        let keys = get(written, "propertyNames").map_or_else(
            || Value::Map(vec![member("type", string("string"))]),
            |names| self.node(scope, names),
        );
        let values = get(written, "additionalProperties")
            .map_or(Value::Map(Map::new()), |value| self.node(scope, value));
        let mut out = vec![
            member("type", string("object")),
            member("propertyNames", keys),
            member("additionalProperties", values),
        ];
        let closed = get(written, "propertyNames").and_then(|names| self.values(scope, names));
        if let Some(names) = closed.filter(|names| !names.is_empty()) {
            out.push(member("required", Value::Seq(names)));
        }
        Value::Map(out)
    }

    /// The closed set of strings `written` admits, as Zod's `_zod.values`
    /// knows it, or `None` for an open one.
    fn values(&self, scope: usize, written: &Value) -> Option<Vec<Value>> {
        if let Some(target) = text(written, "$ref") {
            let (scope, target) = self.resolve(scope, target.strip_prefix("#/$defs/")?)?;
            return self.values(scope, target);
        }
        if let Some(Value::Seq(arms)) = get(written, "anyOf") {
            let arms: Option<Vec<Vec<Value>>> =
                arms.iter().map(|arm| self.values(scope, arm)).collect();
            return arms.map(|arms| arms.into_iter().flatten().collect());
        }
        match (get(written, "const"), get(written, "enum")) {
            (Some(constant), _) => Some(vec![constant.clone()]),
            (None, Some(Value::Seq(values))) => Some(values.clone()),
            _ => None,
        }
    }

    /// Whether `written` names a record bounded in count, which the
    /// generator writes as a `pipe`.
    fn capped(&self, scope: usize, written: &Value) -> bool {
        let target = text(written, "$ref").and_then(|t| t.strip_prefix("#/$defs/"));
        let def = target.and_then(|name| self.resolve(scope, name));
        def.is_some_and(|(_, def)| get(def, "maxProperties").is_some())
    }

    fn object(&mut self, scope: usize, written: &Value) -> Value {
        let required: Vec<&Value> = match get(written, "required") {
            Some(Value::Seq(names)) => names.iter().collect(),
            _ => Vec::new(),
        };
        let order = match get(written, "x-wb-order") {
            Some(Value::Seq(names)) => names.as_slice(),
            _ => &[],
        };
        let (mut properties, mut held) = (Map::new(), Vec::new());
        for name in order.iter().filter_map(|name| match name {
            Value::String(name) => Some(name.as_str()),
            _ => None,
        }) {
            let Some(property) = get(written, "properties").and_then(|all| get(all, name)) else {
                continue;
            };
            let optional = !required.contains(&&string(name));
            if !optional || get(property, "default").is_some() {
                held.push(string(name));
            }
            properties.push(member(name, self.property(scope, property, optional)));
        }
        let mut out =
            vec![member("type", string("object")), member("properties", Value::Map(properties))];
        if !held.is_empty() {
            out.push(member("required", Value::Seq(held)));
        }
        let keep = text(written, "x-wb-unknownKeys") == Some("keep");
        let unknown = if keep { Value::Map(Map::new()) } else { Value::Bool(false) };
        out.push(member("additionalProperties", unknown));
        Value::Map(out)
    }

    /// A property: its schema inside the wrapper `optional()`, `default()` or
    /// a registered definition's reference puts it in, described.
    fn property(&mut self, scope: usize, written: &Value, optional: bool) -> Value {
        let inner = members_of(self.node(scope, written));
        let text = self.description(scope, written);
        let default = get(written, "default");
        let reference = inner.iter().any(|(key, _)| key == "$ref") || self.capped(scope, written);
        if !(optional || default.is_some() || reference) {
            return Value::Map(match text {
                Some(text) => described(inner, text),
                None => inner,
            });
        }
        let mut out: Map =
            default.map(|value| member("default", value.clone())).into_iter().collect();
        if let Some(text) = text {
            out.push(member("description", string(text)));
        }
        let dropped = text.is_some();
        out.extend(inner.into_iter().filter(|(key, _)| !(dropped && key == "description")));
        Value::Map(out)
    }
}

/// A string, number or boolean.
fn scalar(kind: &str, written: &Value) -> Map {
    let mut out = vec![member("type", string(kind))];
    let bounds: &[(&str, &str)] = match kind {
        "string" => &[
            ("const", "const"),
            ("enum", "enum"),
            ("x-wb-minUtf16", "minLength"),
            ("pattern", "pattern"),
        ],
        // `.min()` wins over `.gt()` where a contract writes both.
        "number" if get(written, "minimum").is_some() => &[("minimum", "minimum")],
        "number" => &[("exclusiveMinimum", "exclusiveMinimum")],
        _ => &[],
    };
    out.extend(
        bounds
            .iter()
            .filter_map(|(from, to)| get(written, from).map(|value| member(to, value.clone()))),
    );
    out
}
