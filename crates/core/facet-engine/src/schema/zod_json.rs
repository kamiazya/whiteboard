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
//! - any other reference is the definition it names, inlined, but for one
//!   back into a definition being written (an external one is not compiled,
//!   so nothing refuses its cycle at load): that is a recursion, written as
//!   Zod writes one, `#` when it names the root and otherwise
//!   `#/$defs/__schema<n>`, the definition moved under `$defs` by that name;
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
    /// The scope of a contract whose definitions are `defs`, `contract` being
    /// its whole text as a value.
    pub(super) fn of(defs: &Map, contract: &Value) -> Self {
        let describe = get(contract, "x-wb-describe") == Some(&Value::Bool(true));
        Self { defs: defs.clone(), describe, externals: Vec::new() }
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

/// The definition `name` of the scope `scope` as Zod's JSON Schema.
pub(super) fn publish(scopes: &[Scope], scope: usize, name: &str) -> Value {
    let mut writer =
        Writer { scopes, registered: Vec::new(), open: Vec::new(), cyclic: Vec::new() };
    let root = writer.definition(scope, name).unwrap_or_default();
    let mut out = vec![member("$schema", string(DIALECT))];
    out.extend(root);
    if !writer.registered.is_empty() {
        out.push(member("$defs", Value::Map(writer.registered)));
    }
    Value::Map(out)
}

struct Writer<'s> {
    scopes: &'s [Scope],
    registered: Map,
    /// The definitions being inlined: an external one is not compiled, so a
    /// reference back into one is not refused at load.
    open: Vec<(usize, String)>,
    /// Each definition met again inside itself, and the pointer its uses
    /// are written as.
    cyclic: Vec<((usize, String), String)>,
}

impl<'s> Writer<'s> {
    /// Where `name` is written: its own scope, or the contract it is left to.
    fn resolve(&self, scope: usize, name: &str) -> Option<(usize, &'s Value)> {
        let scopes = self.scopes;
        let owner = scopes
            .get(scope)
            .and_then(|held| held.externals.iter().find(|(external, _)| external == name))
            .map_or(scope, |(_, other)| *other);
        let defs = scopes.get(owner).map_or(&[][..], |held| &held.defs);
        defs.iter().find(|(key, _)| key == name).map(|(_, written)| (owner, written))
    }

    fn definition(&mut self, scope: usize, name: &str) -> Option<Map> {
        let (scope, written) = self.resolve(scope, name)?;
        let reference = vec![member("$ref", string(&format!("#/$defs/{name}")))];
        if get(written, "x-wb-registered") == Some(&Value::Bool(true)) {
            if !self.registered.iter().any(|(key, _)| key == name) {
                // Held before its body is written, so it is first met here.
                self.registered.push(member(name, Value::Null));
                let mut body = Some(Value::Map(self.node(scope, written)));
                for (_, slot) in self.registered.iter_mut().filter(|(key, _)| key == name) {
                    *slot = body.take().unwrap_or_default();
                }
            }
            return Some(reference);
        }
        let key = (scope, name.to_owned());
        if self.open.contains(&key) {
            return Some(self.recursion(key));
        }
        self.open.push(key.clone());
        let body = self.node(scope, written);
        self.open.pop();
        let capped = get(written, "maxProperties").is_some();
        let body = match self.description(scope, written) {
            Some(text) if !capped => described(body, text),
            _ => body,
        };
        match self.cyclic.iter().find(|(held, _)| *held == key) {
            Some((_, pointer)) if pointer != "#" => {
                let pointer = pointer.clone();
                let id = pointer.trim_start_matches("#/$defs/").to_owned();
                self.registered.push(member(&id, Value::Map(body)));
                Some(vec![member("$ref", Value::String(pointer))])
            }
            _ => Some(body),
        }
    }

    /// A reference back into a definition being written, as Zod writes a
    /// recursion: `#` for the root, and otherwise the next `__schema<n>`
    /// under `$defs`, where the definition is moved once written.
    fn recursion(&mut self, key: (usize, String)) -> Map {
        if let Some((_, pointer)) = self.cyclic.iter().find(|(held, _)| *held == key) {
            return vec![member("$ref", Value::String(pointer.clone()))];
        }
        let root = self.open.first() == Some(&key);
        let extracted = self.cyclic.iter().filter(|(_, p)| p != "#").count();
        let pointer = if root { "#".to_owned() } else { format!("#/$defs/__schema{extracted}") };
        self.cyclic.push((key, pointer.clone()));
        vec![member("$ref", Value::String(pointer))]
    }

    /// What the generator describes `written` with, if anything.
    fn description<'v>(&self, scope: usize, written: &'v Value) -> Option<&'v str> {
        let describe = self.scopes.get(scope).is_some_and(|held| held.describe);
        if describe { text(written, "description") } else { text(written, "x-wb-describe") }
    }

    /// A schema as Zod writes it; a reference nothing answers to, like
    /// `x-wb-any`'s `unknown()`, constrains nothing.
    fn node(&mut self, scope: usize, written: &Value) -> Map {
        if let Some(target) = text(written, "$ref") {
            let name = target.strip_prefix("#/$defs/").unwrap_or(target);
            return self.definition(scope, name).unwrap_or_default();
        }
        for union in ["anyOf", "oneOf"] {
            if let Some(Value::Seq(arms)) = get(written, union) {
                let arms = arms.iter().map(|arm| Value::Map(self.node(scope, arm))).collect();
                return vec![member(union, Value::Seq(arms))];
            }
        }
        match text(written, "type") {
            Some("array") => self.array(scope, written),
            Some("object") if get(written, "properties").is_some() => self.object(scope, written),
            Some("object") => self.record(scope, written),
            Some(kind) => scalar(kind, written),
            None => Map::new(),
        }
    }

    /// A schema a member holds.
    fn inner(&mut self, scope: usize, written: Option<&Value>) -> Value {
        Value::Map(written.map(|written| self.node(scope, written)).unwrap_or_default())
    }

    fn array(&mut self, scope: usize, written: &Value) -> Map {
        let mut out: Map = ["minItems", "maxItems"]
            .into_iter()
            .filter_map(|key| get(written, key).map(|bound| member(key, bound.clone())))
            .collect();
        out.push(member("type", string("array")));
        let items = self.inner(scope, get(written, "items"));
        out.push(member("items", items));
        out
    }

    fn record(&mut self, scope: usize, written: &Value) -> Map {
        let keys = get(written, "propertyNames").map_or_else(
            || Value::Map(vec![member("type", string("string"))]),
            |names| Value::Map(self.node(scope, names)),
        );
        let values = self.inner(scope, get(written, "additionalProperties"));
        let mut out = vec![
            member("type", string("object")),
            member("propertyNames", keys),
            member("additionalProperties", values),
        ];
        let closed = get(written, "propertyNames")
            .and_then(|names| self.values(scope, names, &mut Vec::new()));
        if let Some(names) = closed.filter(|names| !names.is_empty()) {
            out.push(member("required", Value::Seq(names)));
        }
        out
    }

    /// The closed set of strings `written` admits, as Zod's `_zod.values`
    /// knows it, or `None` for an open one. `path` holds the definitions
    /// being walked: one met again inside itself (an external definition is
    /// not compiled, so nothing refuses its cycle at load) admits no closed
    /// set, as Zod answers none for a union that names itself.
    fn values(
        &self,
        scope: usize,
        written: &Value,
        path: &mut Vec<(usize, String)>,
    ) -> Option<Vec<Value>> {
        if let Some(target) = text(written, "$ref") {
            let name = target.strip_prefix("#/$defs/")?;
            let (scope, target) = self.resolve(scope, name)?;
            let key = (scope, name.to_owned());
            if path.contains(&key) {
                return None;
            }
            path.push(key);
            let found = self.values(scope, target, path);
            path.pop();
            return found;
        }
        if let Some(Value::Seq(arms)) = get(written, "anyOf") {
            let arms: Option<Vec<Vec<Value>>> =
                arms.iter().map(|arm| self.values(scope, arm, path)).collect();
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

    fn object(&mut self, scope: usize, written: &Value) -> Map {
        let required: Vec<&Value> = match get(written, "required") {
            Some(Value::Seq(names)) => names.iter().collect(),
            _ => Vec::new(),
        };
        let declared = match get(written, "properties") {
            Some(Value::Map(declared)) => declared.as_slice(),
            _ => &[],
        };
        // An external definition is not compiled, so it may leave its order
        // unwritten: its properties are then taken as written.
        let order: Vec<&str> = match get(written, "x-wb-order") {
            Some(Value::Seq(names)) => names
                .iter()
                .filter_map(|name| match name {
                    Value::String(name) => Some(name.as_str()),
                    _ => None,
                })
                .collect(),
            _ => declared.iter().map(|(name, _)| name.as_str()).collect(),
        };
        let (mut properties, mut held) = (Map::new(), Vec::new());
        for name in order {
            let found = declared.iter().find(|(key, _)| key == name);
            let Some((_, property)) = found else { continue };
            let optional = !required.contains(&&string(name));
            if !optional || get(property, "default").is_some() {
                held.push(string(name));
            }
            properties.push(member(name, Value::Map(self.property(scope, property, optional))));
        }
        let mut out =
            vec![member("type", string("object")), member("properties", Value::Map(properties))];
        if !held.is_empty() {
            out.push(member("required", Value::Seq(held)));
        }
        let keep = text(written, "x-wb-unknownKeys") == Some("keep");
        let unknown = if keep { Value::Map(Map::new()) } else { Value::Bool(false) };
        out.push(member("additionalProperties", unknown));
        out
    }

    /// A property: its schema inside the wrapper `optional()`, `default()` or
    /// a registered definition's reference puts it in, described.
    fn property(&mut self, scope: usize, written: &Value, optional: bool) -> Map {
        let inner = self.node(scope, written);
        let text = self.description(scope, written);
        let default = get(written, "default");
        let reference = inner.iter().any(|(key, _)| key == "$ref") || self.capped(scope, written);
        if !(optional || default.is_some() || reference) {
            return match text {
                Some(text) => described(inner, text),
                None => inner,
            };
        }
        let mut out: Map =
            default.map(|value| member("default", value.clone())).into_iter().collect();
        if let Some(text) = text {
            out.push(member("description", string(text)));
        }
        let dropped = text.is_some();
        out.extend(inner.into_iter().filter(|(key, _)| !(dropped && key == "description")));
        out
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
