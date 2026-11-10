//! Compiling a contract: its definitions into nodes, every construct this
//! walk does not implement refused by name rather than dropped.

use whiteboard_model::{Map, Value};

use super::{Contracts, Def, DefId, External, Field, Host, Node, Pattern, Predicate};

/// A contract that cannot be compiled, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError {
    pub at: String,
    pub refusal: Refusal,
}

/// Why a contract cannot be compiled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// A keyword the dialect does not have: the emitters refuse it too.
    UnknownKeyword(String),
    /// A `$ref` that is not `#/$defs/<name>` of the same contract.
    BadRef(String),
    /// A definition that reaches itself through `$ref`s.
    RefCycle(String),
    UnsuppliedMatcher(String),
    UnsuppliedCheck(String),
    UnsuppliedExternal(String),
    /// A construct only the model's port implements.
    ModelOnly(&'static str),
    /// A keyword of the wrong shape, or one that needs another.
    Malformed(&'static str),
}

type Compiled<T> = Result<T, CompileError>;

const CONTRACT_KEYWORDS: &[&str] = &[
    "$schema",
    "title",
    "description",
    "x-wb-emit",
    "x-wb-checks",
    "x-wb-describe",
    "x-wb-rustSerde",
    "x-wb-readonlyTypes",
    "$defs",
];

/// Every keyword a node may carry: the parse in `crates/xtask`'s dialect has
/// these fields and no others.
const NODE_KEYWORDS: &[&str] = &[
    "description",
    "type",
    "minimum",
    "exclusiveMinimum",
    "x-wb-minUtf16",
    "pattern",
    "x-wb-matcher",
    "x-wb-message",
    "x-wb-check",
    "enum",
    "items",
    "minItems",
    "maxItems",
    "x-wb-maxItemsMessage",
    "anyOf",
    "oneOf",
    "discriminator",
    "const",
    "default",
    "propertyNames",
    "maxProperties",
    "x-wb-maxPropertiesMessage",
    "x-wb-extends",
    "x-wb-lenient",
    "x-wb-describe",
    "x-wb-external",
    "x-wb-registered",
    "$ref",
    "x-wb-any",
    "properties",
    "required",
    "x-wb-order",
    "additionalProperties",
    "x-wb-unknownKeys",
];

const DEFS_PREFIX: &str = "#/$defs/";

fn refuse<T>(at: &str, refusal: Refusal) -> Compiled<T> {
    Err(CompileError { at: at.to_owned(), refusal })
}

fn malformed<T>(at: &str, what: &'static str) -> Compiled<T> {
    refuse(at, Refusal::Malformed(what))
}

/// What an object holds under `key`; nothing of a value that is not one.
fn child<'v>(value: Option<&'v Value>, key: &str) -> Option<&'v Value> {
    match value {
        Some(Value::Map(map)) => get(map, key),
        _ => None,
    }
}

fn get<'v>(map: &'v Map, key: &str) -> Option<&'v Value> {
    map.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

fn as_map<'v>(value: &'v Value, at: &str) -> Compiled<&'v Map> {
    match value {
        Value::Map(map) => Ok(map),
        _ => malformed(at, "an object"),
    }
}

fn as_text<'v>(value: &'v Value, at: &str) -> Compiled<&'v str> {
    match value {
        Value::String(text) => Ok(text),
        _ => malformed(at, "a string"),
    }
}

fn as_list<'v>(value: &'v Value, at: &str) -> Compiled<&'v [Value]> {
    match value {
        Value::Seq(list) => Ok(list),
        _ => malformed(at, "a list"),
    }
}

/// A count: a whole, non-negative number. Kept as the `f64` the contract
/// wrote, so no integer conversion stands between the contract and the bound.
fn as_count(value: &Value, at: &str) -> Compiled<f64> {
    match value {
        Value::Number(n) if n.is_finite() && *n >= 0.0 && n.fract() == 0.0 => Ok(*n),
        _ => malformed(at, "a whole non-negative number"),
    }
}

fn as_bound(value: &Value, at: &str) -> Compiled<f64> {
    match value {
        Value::Number(n) if n.is_finite() => Ok(*n),
        _ => malformed(at, "a finite number"),
    }
}

fn texts(value: &Value, at: &str) -> Compiled<Vec<String>> {
    as_list(value, at)?.iter().map(|item| as_text(item, at).map(str::to_owned)).collect()
}

fn check_keywords(map: &Map, allowed: &[&str], at: &str) -> Compiled<()> {
    match map.iter().find(|(name, _)| !allowed.contains(&name.as_str())) {
        Some((name, _)) => refuse(at, Refusal::UnknownKeyword(name.clone())),
        None => Ok(()),
    }
}

fn supplied<T: Copy>(table: &[(&str, T)], name: &str) -> Option<T> {
    table.iter().find(|(known, _)| *known == name).map(|(_, found)| *found)
}

struct Compiler<'a> {
    host: &'a Host<'a>,
    nodes: Vec<Node>,
    defs: Vec<Def>,
    edges: Vec<(DefId, DefId)>,
}

/// What a contract's definitions are called, with where each is written.
struct Scope<'v> {
    names: Vec<(&'v str, DefId)>,
    written: &'v Map,
}

pub(super) fn load(contracts: &[(&str, &Value)], host: &Host<'_>) -> Compiled<Contracts> {
    let mut compiler = Compiler { host, nodes: Vec::new(), defs: Vec::new(), edges: Vec::new() };
    for (index, (path, contract)) in contracts.iter().enumerate() {
        if contracts.iter().take(index).any(|(earlier, _)| earlier == path) {
            return malformed(path, "a contract is loaded twice");
        }
        compiler.contract(path, contract)?;
    }
    compiler.refuse_cycles()?;
    Ok(Contracts { nodes: compiler.nodes, defs: compiler.defs })
}

impl Compiler<'_> {
    fn push(&mut self, node: Node) -> usize {
        self.nodes.push(node);
        self.nodes.len().saturating_sub(1)
    }

    fn contract(&mut self, path: &str, contract: &Value) -> Compiled<()> {
        let map = as_map(contract, path)?;
        check_keywords(map, CONTRACT_KEYWORDS, path)?;
        let Some(defs) = get(map, "$defs") else { return malformed(path, "no $defs") };
        let written = as_map(defs, &format!("{path}#/$defs"))?;
        let first = self.defs.len();
        let names = written
            .iter()
            .enumerate()
            .map(|(offset, (name, _))| (name.as_str(), DefId(first.saturating_add(offset))))
            .collect();
        let scope = Scope { names, written };
        let mut roots = Vec::new();
        for (offset, (name, node)) in written.iter().enumerate() {
            let id = DefId(first.saturating_add(offset));
            roots.push(self.definition(
                &scope,
                id,
                name,
                node,
                &format!("{path}#/$defs/{name}"),
            )?);
        }
        // A definition's id is its place in this list, which is how the
        // references compiled above name it.
        let contract = path.to_owned();
        self.defs.extend(written.iter().zip(roots).map(|((name, _), root)| Def {
            contract: contract.clone(),
            name: name.clone(),
            root,
        }));
        Ok(())
    }

    /// A definition: its node, or the host's validator where the contract
    /// leaves it to one.
    fn definition(
        &mut self,
        scope: &Scope<'_>,
        id: DefId,
        name: &str,
        node: &Value,
        at: &str,
    ) -> Compiled<usize> {
        let written = as_map(node, at)?;
        if get(written, "x-wb-external").is_some() {
            match supplied(self.host.externals, name) {
                None => return refuse(at, Refusal::UnsuppliedExternal(name.to_owned())),
                Some(External::Validator(validator)) => {
                    return Ok(self.push(Node::External(validator)));
                }
                Some(External::AsWritten) => {}
            }
        }
        self.node(scope, id, node, at)
    }

    fn node(
        &mut self,
        scope: &Scope<'_>,
        owner: DefId,
        value: &Value,
        at: &str,
    ) -> Compiled<usize> {
        let map = as_map(value, at)?;
        check_keywords(map, NODE_KEYWORDS, at)?;
        if get(map, "x-wb-lenient").is_some() {
            return refuse(at, Refusal::ModelOnly("x-wb-lenient"));
        }
        if get(map, "x-wb-extends").is_some() {
            return refuse(at, Refusal::ModelOnly("x-wb-extends"));
        }
        if let Some(target) = get(map, "$ref") {
            let target = self.reference(scope, owner, target, at)?;
            return Ok(self.push(Node::Ref(target)));
        }
        if let Some(arms) = get(map, "oneOf") {
            return self.tagged(scope, owner, map, arms, at);
        }
        if let Some(arms) = get(map, "anyOf") {
            let arms = as_list(arms, at)?;
            let mut compiled = Vec::new();
            for (index, arm) in arms.iter().enumerate() {
                compiled.push(self.node(scope, owner, arm, &format!("{at}.anyOf[{index}]"))?);
            }
            return Ok(self.push(Node::Union(compiled)));
        }
        if get(map, "x-wb-any").is_some() {
            return Ok(self.push(Node::Any));
        }
        self.typed(scope, owner, map, at)
    }

    fn reference(
        &mut self,
        scope: &Scope<'_>,
        owner: DefId,
        target: &Value,
        at: &str,
    ) -> Compiled<DefId> {
        let text = as_text(target, at)?;
        let found = text
            .strip_prefix(DEFS_PREFIX)
            .and_then(|name| scope.names.iter().find(|(known, _)| *known == name))
            .map(|(_, id)| *id);
        let Some(found) = found else { return refuse(at, Refusal::BadRef(text.to_owned())) };
        self.edges.push((owner, found));
        Ok(found)
    }

    fn tagged(
        &mut self,
        scope: &Scope<'_>,
        owner: DefId,
        map: &Map,
        arms: &Value,
        at: &str,
    ) -> Compiled<usize> {
        let Some(discriminator) = get(map, "discriminator") else {
            return malformed(at, "a oneOf needs its discriminator");
        };
        let Some(property) = get(as_map(discriminator, at)?, "propertyName") else {
            return malformed(at, "a discriminator needs its propertyName");
        };
        let property = as_text(property, at)?.to_owned();
        let mut compiled = Vec::new();
        for (index, arm) in as_list(arms, at)?.iter().enumerate() {
            let arm_at = format!("{at}.oneOf[{index}]");
            let tag = Self::tag_of(scope, as_map(arm, &arm_at)?, &property, &arm_at)?;
            compiled.push((tag, self.node(scope, owner, arm, &arm_at)?));
        }
        Ok(self.push(Node::Tagged { property, arms: compiled }))
    }

    /// The constant an arm's discriminating property holds.
    fn tag_of(scope: &Scope<'_>, arm: &Map, property: &str, at: &str) -> Compiled<String> {
        let target = match get(arm, "$ref") {
            Some(Value::String(text)) => text.strip_prefix(DEFS_PREFIX),
            _ => None,
        };
        let member = target.and_then(|name| get(scope.written, name));
        let Some(member) = member else {
            return malformed(at, "a union arm is a $ref to a definition");
        };
        let properties = child(get(as_map(member, at)?, "properties"), property);
        let tag = child(properties, "const");
        match tag {
            Some(Value::String(text)) => Ok(text.clone()),
            _ => malformed(at, "a union arm names its tag as a const"),
        }
    }

    fn typed(&mut self, scope: &Scope<'_>, owner: DefId, map: &Map, at: &str) -> Compiled<usize> {
        let Some(kind) = get(map, "type") else {
            return malformed(at, "no type, $ref, anyOf, oneOf or x-wb-any");
        };
        match as_text(kind, at)? {
            "string" => self.string(map, at),
            "number" => self.number(map, at),
            "boolean" => Ok(self.push(Node::Bool)),
            "array" => self.array(scope, owner, map, at),
            "object" if get(map, "properties").is_some() => self.object(scope, owner, map, at),
            "object" => self.record(scope, owner, map, at),
            "integer" => refuse(at, Refusal::ModelOnly("integer")),
            _ => malformed(at, "an unknown type"),
        }
    }

    fn string(&mut self, map: &Map, at: &str) -> Compiled<usize> {
        if let Some(constant) = get(map, "const") {
            let constant = as_text(constant, at)?.to_owned();
            return Ok(self.push(Node::Literal(constant)));
        }
        if let Some(values) = get(map, "enum") {
            return Ok(self.push(Node::Enum(texts(values, at)?)));
        }
        let min = get(map, "x-wb-minUtf16").map(|n| as_count(n, at)).transpose()?;
        let pattern = self.pattern(map, at)?;
        let check =
            match get(map, "x-wb-check") {
                None => None,
                Some(name) => {
                    let name = as_text(name, at)?;
                    let found = supplied(self.host.checks, name);
                    Some(found.map_or_else(
                        || refuse(at, Refusal::UnsuppliedCheck(name.to_owned())),
                        Ok,
                    )?)
                }
            };
        Ok(self.push(Node::Str { min, pattern, check }))
    }

    /// A pattern is judged by its named matcher, never by the regex the Zod
    /// half compiles: a pattern with no matcher would be no check at all.
    fn pattern(&self, map: &Map, at: &str) -> Compiled<Option<Pattern>> {
        let Some(matcher) = get(map, "x-wb-matcher") else {
            return match get(map, "pattern") {
                None => Ok(None),
                Some(_) => malformed(at, "a pattern has no x-wb-matcher"),
            };
        };
        let name = as_text(matcher, at)?;
        let Some(matcher): Option<Predicate> = supplied(self.host.matchers, name) else {
            return refuse(at, Refusal::UnsuppliedMatcher(name.to_owned()));
        };
        let message = get(map, "x-wb-message")
            .map(|text| as_text(text, at).map(str::to_owned))
            .transpose()?;
        Ok(Some(Pattern { matcher, message }))
    }

    fn number(&mut self, map: &Map, at: &str) -> Compiled<usize> {
        let min = get(map, "minimum").map(|n| as_bound(n, at)).transpose()?;
        let above = get(map, "exclusiveMinimum").map(|n| as_bound(n, at)).transpose()?;
        Ok(self.push(Node::Num { min, above }))
    }

    fn array(&mut self, scope: &Scope<'_>, owner: DefId, map: &Map, at: &str) -> Compiled<usize> {
        let Some(items) = get(map, "items") else { return malformed(at, "an array has no items") };
        let item = self.node(scope, owner, items, &format!("{at}.items"))?;
        let min = get(map, "minItems").map(|n| as_count(n, at)).transpose()?;
        let max = match get(map, "maxItems") {
            None => None,
            Some(n) => {
                let message = get(map, "x-wb-maxItemsMessage")
                    .map(|text| as_text(text, at).map(str::to_owned))
                    .transpose()?;
                Some((as_count(n, at)?, message))
            }
        };
        Ok(self.push(Node::Array { item, min, max }))
    }

    fn record(&mut self, scope: &Scope<'_>, owner: DefId, map: &Map, at: &str) -> Compiled<usize> {
        if get(map, "x-wb-check").is_some() {
            return refuse(at, Refusal::ModelOnly("x-wb-check on a record"));
        }
        let Some(value) = get(map, "additionalProperties") else {
            return malformed(at, "a record has no additionalProperties");
        };
        let value = self.node(scope, owner, value, &format!("{at}.additionalProperties"))?;
        let key = match get(map, "propertyNames") {
            None => None,
            Some(names) => Some(self.node(scope, owner, names, &format!("{at}.propertyNames"))?),
        };
        let cap = match (get(map, "maxProperties"), get(map, "x-wb-maxPropertiesMessage")) {
            (None, None) => None,
            (Some(max), Some(message)) => {
                Some((as_count(max, at)?, as_text(message, at)?.to_owned()))
            }
            _ => return malformed(at, "maxProperties and its message need each other"),
        };
        Ok(self.push(Node::Map { key, value, cap }))
    }

    fn object(&mut self, scope: &Scope<'_>, owner: DefId, map: &Map, at: &str) -> Compiled<usize> {
        let refuse_unknown =
            match get(map, "x-wb-unknownKeys").map(|k| as_text(k, at)).transpose()? {
                Some("refuse") => true,
                Some("strip") => false,
                Some("keep") => return refuse(at, Refusal::ModelOnly("x-wb-unknownKeys keep")),
                _ => return malformed(at, "x-wb-unknownKeys is refuse or strip"),
            };
        if get(map, "x-wb-check").is_some() {
            return refuse(at, Refusal::ModelOnly("x-wb-check on an object"));
        }
        let (Some(properties), Some(order)) = (get(map, "properties"), get(map, "x-wb-order"))
        else {
            return malformed(at, "an object has properties and x-wb-order");
        };
        let properties = as_map(properties, at)?;
        let required = match get(map, "required") {
            Some(list) => texts(list, at)?,
            None => Vec::new(),
        };
        let mut fields = Vec::new();
        for name in texts(order, at)? {
            let field_at = format!("{at}.{name}");
            let Some(property) = get(properties, &name) else {
                return malformed(&field_at, "x-wb-order names a property that is not declared");
            };
            let default = default_of(property, &field_at)?;
            let node = self.node(scope, owner, property, &field_at)?;
            let optional = !required.contains(&name);
            fields.push(Field { name, node, optional, default });
        }
        Ok(self.push(Node::Object { fields, refuse: refuse_unknown }))
    }

    /// Definitions that reach themselves are refused: removing, again and
    /// again, the definitions that reach nothing still standing leaves
    /// exactly the ones on a cycle and the ones that lead only to it.
    fn refuse_cycles(&self) -> Compiled<()> {
        let mut standing: Vec<bool> = self.defs.iter().map(|_| true).collect();
        // Each round removes one definition or none, so as many rounds as
        // there are definitions settle it.
        for _ in &self.defs {
            let removable = standing.iter().enumerate().position(|(index, here)| {
                *here
                    && self.edges.iter().all(|(from, to)| {
                        from.0 != index || !standing.get(to.0).copied().unwrap_or(false)
                    })
            });
            if let Some(here) = removable.and_then(|index| standing.get_mut(index)) {
                *here = false;
            }
        }
        match standing.iter().position(|here| *here).and_then(|index| self.defs.get(index)) {
            Some(def) => refuse(
                &format!("{}#/$defs/{}", def.contract, def.name),
                Refusal::RefCycle(def.name.clone()),
            ),
            None => Ok(()),
        }
    }
}

/// What an absent property reads as: an empty list or an empty record, the
/// only defaults the dialect has.
fn default_of(property: &Value, at: &str) -> Compiled<Option<Value>> {
    let Some(default) = get(as_map(property, at)?, "default") else { return Ok(None) };
    match default {
        Value::Seq(list) if list.is_empty() => Ok(Some(Value::Seq(Vec::new()))),
        Value::Map(entries) if entries.is_empty() => Ok(Some(Value::Map(Vec::new()))),
        _ => malformed(at, "a default is an empty list or an empty object"),
    }
}
