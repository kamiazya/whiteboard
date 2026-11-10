//! Judging a value against a compiled definition, in the order and with the
//! flags Zod 4.6 uses: an issue that does not `continue` makes what it
//! judged "aborted", which stops the checks that follow it and decides which
//! arm of a union speaks.

use whiteboard_model::{Map, Value};

use super::issue::aborted;
use super::{Code, Contracts, DefId, Detail, Field, Issue, Node, PathStep, Pattern, Validator};

/// What judging one value left: the value as parsed, and every issue.
struct Res {
    value: Value,
    issues: Vec<Issue>,
}

impl Res {
    fn done(value: Value, issues: Vec<Issue>) -> Self {
        Self { value, issues }
    }

    fn fail(issue: Issue) -> Self {
        Self::done(Value::Null, vec![issue])
    }
}

/// A node an id of this set never names, so a lookup that misses stands for
/// the any-value rather than a panic.
static ANY: Node = Node::Any;

fn lookup<'v>(entries: &'v Map, key: &str) -> Option<&'v Value> {
    entries.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// A length as the `f64` a bound compares against; a string or list beyond
/// `u32::MAX` is past every bound a contract writes.
fn count(len: usize) -> f64 {
    f64::from(u32::try_from(len).unwrap_or(u32::MAX))
}

fn under(step: &PathStep, issues: Vec<Issue>) -> impl Iterator<Item = Issue> {
    let step = step.clone();
    issues.into_iter().map(move |issue| issue.under(step.clone()))
}

pub(super) fn validate(set: &Contracts, def: DefId, value: &Value) -> Result<Value, Vec<Issue>> {
    let Some(found) = set.defs.get(def.0) else { return Err(vec![Issue::here(Code::Custom)]) };
    let res = set.judge(found.root, Some(value));
    if res.issues.is_empty() { Ok(res.value) } else { Err(res.issues) }
}

impl Contracts {
    pub(super) fn node(&self, index: usize) -> &Node {
        self.nodes.get(index).unwrap_or(&ANY)
    }

    /// `None` is a value that is absent, which only an object's field can be.
    fn judge(&self, index: usize, input: Option<&Value>) -> Res {
        match self.node(index) {
            Node::Str { min, pattern, check } => string(*min, pattern.as_ref(), *check, input),
            Node::Num { min, above } => number(*min, *above, input),
            Node::Bool => match input {
                Some(Value::Bool(_)) => Res::done(input.cloned().unwrap_or_default(), Vec::new()),
                _ => Res::fail(Issue::here(Code::InvalidType)),
            },
            Node::Literal(only) => one_of(std::slice::from_ref(only), input),
            Node::Enum(values) => one_of(values, input),
            Node::Array { item, min, max } => self.array(*item, *min, max.as_ref(), input),
            Node::Union(arms) => self.union(arms, input),
            Node::Tagged { property, arms } => self.tagged(property, arms, input),
            Node::Any => Res::done(input.cloned().unwrap_or_default(), Vec::new()),
            Node::Ref(def) => self.judge(self.defs.get(def.0).map_or(index, |d| d.root), input),
            Node::Map { key, value, cap } => self.map(*key, *value, cap.as_ref(), input),
            Node::Object { fields, refuse } => self.object(fields, *refuse, input),
            Node::External(validator) => external(*validator, input),
        }
    }

    /// A list past its bound is refused by that bound alone, before any
    /// element is judged (Zod's size cap), and the refusal stops what follows.
    fn array(
        &self,
        item: usize,
        min: Option<f64>,
        max: Option<&(f64, Option<String>)>,
        input: Option<&Value>,
    ) -> Res {
        if let (Some(Value::Seq(items)), Some((bound, message))) = (input, max)
            && count(items.len()) > *bound
        {
            let detail = message.clone().map_or(Detail::None, Detail::Message);
            return Res::fail(Issue::here(Code::TooBig).with(detail));
        }
        let (mut issues, mut out) = (Vec::new(), Vec::new());
        if let Some(Value::Seq(items)) = input {
            for (index, element) in items.iter().enumerate() {
                let res = self.judge(item, Some(element));
                issues.extend(under(&PathStep::Index(index), res.issues));
                out.push(res.value);
            }
        } else {
            issues.push(Issue::here(Code::InvalidType));
        }
        issues.extend(length_issues(input, min, max.map(|(bound, message)| (*bound, message))));
        Res::done(Value::Seq(out), issues)
    }

    fn union(&self, arms: &[usize], input: Option<&Value>) -> Res {
        let mut results: Vec<Res> = arms.iter().map(|arm| self.judge(*arm, input)).collect();
        if let Some(index) = results.iter().position(|res| res.issues.is_empty()) {
            return results.swap_remove(index);
        }
        let mut live = results.iter().enumerate().filter(|(_, res)| !aborted(&res.issues));
        if let (Some((only, _)), None) = (live.next(), live.next()) {
            return results.swap_remove(only);
        }
        let errors = results.into_iter().map(|res| res.issues).collect();
        Res::fail(Issue::here(Code::InvalidUnion).with(Detail::Arms(errors)))
    }

    /// The arm the tag names judges the value itself; a tag that names none
    /// is one issue at the tag, with no arm to blame.
    fn tagged(&self, property: &str, arms: &[(String, usize)], input: Option<&Value>) -> Res {
        let Some(Value::Map(entries)) = input else {
            return Res::fail(Issue::here(Code::InvalidType));
        };
        let named = match lookup(entries, property) {
            Some(Value::String(tag)) => arms.iter().find(|(known, _)| known == tag),
            _ => None,
        };
        match named {
            Some((_, arm)) => self.judge(*arm, input),
            None => Res::fail(
                Issue::here(Code::InvalidUnion)
                    .with(Detail::Arms(Vec::new()))
                    .under(PathStep::Key(property.to_owned())),
            ),
        }
    }

    fn map(
        &self,
        key: Option<usize>,
        value: usize,
        cap: Option<&(f64, String)>,
        input: Option<&Value>,
    ) -> Res {
        let Some(Value::Map(entries)) = input else {
            return Res::fail(Issue::here(Code::InvalidType));
        };
        if let Some((_, message)) = cap.filter(|(bound, _)| count(entries.len()) > *bound) {
            let message = message.replace("{count}", &entries.len().to_string());
            return Res::fail(Issue::soft(Code::Custom).with(Detail::Message(message)));
        }
        let (mut issues, mut out) = (Vec::new(), Vec::new());
        for (name, entry) in entries.iter().filter(|(name, _)| name != "__proto__") {
            let step = PathStep::Key(name.clone());
            let named = key.map(|node| self.judge(node, Some(&Value::String(name.clone()))));
            if let Some(refused) = named.filter(|res| !res.issues.is_empty()) {
                let issue = Issue::here(Code::InvalidKey).with(Detail::Key(refused.issues));
                issues.push(issue.under(step));
                continue;
            }
            let res = self.judge(value, Some(entry));
            issues.extend(under(&step, res.issues));
            out.push((name.clone(), res.value));
        }
        Res::done(Value::Map(out), issues)
    }

    fn object(&self, fields: &[Field], refuse: bool, input: Option<&Value>) -> Res {
        let Some(Value::Map(entries)) = input else {
            return Res::fail(Issue::here(Code::InvalidType));
        };
        let (mut issues, mut out) = (Vec::new(), Vec::new());
        for field in fields {
            self.field(field, entries, &mut issues, &mut out);
        }
        let unknown: Vec<String> = entries
            .iter()
            .filter(|(name, _)| refuse && !fields.iter().any(|field| field.name == *name))
            .map(|(name, _)| name.clone())
            .collect();
        if !unknown.is_empty() {
            issues.push(Issue::soft(Code::UnrecognizedKeys).with(Detail::Keys(unknown)));
        }
        Res::done(Value::Map(out), issues)
    }

    /// One declared property: what is there is judged, and what is absent is
    /// its default, nothing if optional, and otherwise whatever the schema
    /// says of an absent value (and an invalid type if it says nothing).
    fn field(&self, field: &Field, entries: &Map, issues: &mut Vec<Issue>, out: &mut Map) {
        let step = PathStep::Key(field.name.clone());
        let found = lookup(entries, &field.name);
        match (found, &field.default, field.optional) {
            (Some(entry), _, _) => {
                let res = self.judge(field.node, Some(entry));
                issues.extend(under(&step, res.issues));
                out.push((field.name.clone(), res.value));
            }
            (None, Some(default), _) => out.push((field.name.clone(), default.clone())),
            (None, None, true) => {}
            (None, None, false) => {
                let res = self.judge(field.node, None);
                let silent = res.issues.is_empty();
                issues.extend(under(&step, res.issues));
                if silent {
                    issues.push(Issue::here(Code::InvalidType).under(step));
                }
            }
        }
    }
}

fn string(
    min: Option<f64>,
    pattern: Option<&Pattern>,
    check: Option<super::Predicate>,
    input: Option<&Value>,
) -> Res {
    let mut issues = Vec::new();
    let Some(Value::String(text)) = input else {
        issues.push(Issue::here(Code::InvalidType));
        issues.extend(length_issues(input, min, None));
        return Res::done(Value::Null, issues);
    };
    issues.extend(length_issues(input, min, None));
    if let Some(pattern) = pattern.filter(|p| !(p.matcher)(text)) {
        let detail = pattern.message.clone().map_or(Detail::None, Detail::Message);
        issues.push(Issue::soft(Code::InvalidFormat).with(detail));
    }
    if check.is_some_and(|accepts| !accepts(text)) {
        issues.push(Issue::soft(Code::Custom));
    }
    Res::done(Value::String(text.clone()), issues)
}

/// What Zod's length checks measure: they run on any value with a `length`,
/// including one whose type check just refused it (a list given to a string
/// schema, a string given to a list schema, an object that has a numeric
/// `length`). A string's length is its code points, which is what Zod's
/// UTF-16 shortcut always agrees with.
fn measure(input: Option<&Value>) -> Option<f64> {
    match input {
        Some(Value::String(text)) => Some(count(text.chars().count())),
        Some(Value::Seq(items)) => Some(count(items.len())),
        Some(Value::Map(entries)) => match lookup(entries, "length") {
            Some(Value::Number(length)) => Some(*length),
            _ => None,
        },
        _ => None,
    }
}

fn length_issues(
    input: Option<&Value>,
    min: Option<f64>,
    max: Option<(f64, &Option<String>)>,
) -> Vec<Issue> {
    let mut issues = Vec::new();
    let Some(length) = measure(input) else { return issues };
    if min.is_some_and(|bound| length < bound) {
        issues.push(Issue::soft(Code::TooSmall));
    }
    if let Some((_, message)) = max.filter(|(bound, _)| length > *bound) {
        let detail = message.clone().map_or(Detail::None, Detail::Message);
        issues.push(Issue::soft(Code::TooBig).with(detail));
    }
    issues
}

fn number(min: Option<f64>, above: Option<f64>, input: Option<&Value>) -> Res {
    let Some(Value::Number(n)) = input.filter(|v| matches!(v, Value::Number(n) if n.is_finite()))
    else {
        return Res::fail(Issue::here(Code::InvalidType));
    };
    let mut issues = Vec::new();
    if min.is_some_and(|bound| *n < bound) || above.is_some_and(|bound| *n <= bound) {
        issues.push(Issue::soft(Code::TooSmall));
    }
    Res::done(Value::Number(*n), issues)
}

/// A constant or one of an enum's values; Zod refuses a stranger as an
/// invalid value, which stops what follows.
fn one_of(values: &[String], input: Option<&Value>) -> Res {
    match input {
        Some(Value::String(text)) if values.contains(text) => {
            Res::done(Value::String(text.clone()), Vec::new())
        }
        _ => Res::fail(Issue::here(Code::InvalidValue)),
    }
}

/// A host's validator judges only what is there: an absent value is no
/// value for it to judge.
fn external(validator: Validator, input: Option<&Value>) -> Res {
    let Some(value) = input else { return Res::fail(Issue::here(Code::InvalidType)) };
    match validator(value) {
        Ok(parsed) => Res::done(parsed, Vec::new()),
        Err(issues) => Res::done(Value::Null, issues),
    }
}
