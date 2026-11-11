//! The backend's intermediate representation: plain data between the scene
//! renderers and the canonical serializer.

/// An attribute's value. An absent value is an attribute that was never added:
/// the presence-only rule (an absent field is never defaulted) as a type.
/// Numbers are formatted by the serializer, strings escaped by it, so a call
/// site never pre-formats either.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum AttrValue {
    Str(String),
    Num(f64),
}

/// A node's attributes in emission order. Setting a name already present
/// replaces its value where it stands, as writing a key of a JavaScript object
/// a second time does, so a later spread overrides without moving the key.
#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct Attrs(Vec<(String, AttrValue)>);

impl Attrs {
    #[must_use]
    pub(super) fn new() -> Self {
        Self::default()
    }

    fn put(mut self, name: &str, value: AttrValue) -> Self {
        match self.0.iter_mut().find(|(key, _)| key == name) {
            Some(slot) => slot.1 = value,
            None => self.0.push((name.to_string(), value)),
        }
        self
    }

    #[must_use]
    pub(super) fn str(self, name: &str, value: &str) -> Self {
        self.put(name, AttrValue::Str(value.to_string()))
    }

    #[must_use]
    pub(super) fn num(self, name: &str, value: f64) -> Self {
        self.put(name, AttrValue::Num(value))
    }

    /// Adds the attribute when there is a value, and does nothing otherwise.
    #[must_use]
    pub(super) fn opt_str(self, name: &str, value: Option<&str>) -> Self {
        match value {
            Some(value) => self.str(name, value),
            None => self,
        }
    }

    #[must_use]
    pub(super) fn opt_num(self, name: &str, value: Option<f64>) -> Self {
        match value {
            Some(value) => self.num(name, value),
            None => self,
        }
    }

    /// `self` with every attribute of `other` set over it, in `other`'s order.
    #[must_use]
    pub(super) fn merge(self, other: Attrs) -> Self {
        other.0.into_iter().fold(self, |attrs, (name, value)| attrs.put(&name, value))
    }

    #[must_use]
    pub(super) fn get(&self, name: &str) -> Option<&AttrValue> {
        self.0.iter().find(|(key, _)| key == name).map(|(_, value)| value)
    }

    #[must_use]
    pub(super) fn get_str(&self, name: &str) -> Option<&str> {
        match self.get(name) {
            Some(AttrValue::Str(s)) => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub(super) fn get_num(&self, name: &str) -> Option<f64> {
        match self.get(name) {
            Some(AttrValue::Num(n)) => Some(*n),
            _ => None,
        }
    }

    #[must_use]
    pub(super) fn without(&self, names: &[&str]) -> Self {
        Attrs(self.0.iter().filter(|(key, _)| !names.contains(&key.as_str())).cloned().collect())
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = (&str, &AttrValue)> {
        self.0.iter().map(|(name, value)| (name.as_str(), value))
    }
}

/// What an element holds. Nested lists are flattened in document order, so a
/// renderer that produces a fragment (several siblings, possibly none)
/// composes without wrapper elements: the empty list is the spelling of "no
/// output".
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Child {
    Node(VNode),
    /// Text, escaped on serialisation.
    Text(String),
    /// Markup emitted verbatim: a trusted, already well-formed fragment.
    Raw(String),
    List(Vec<Child>),
}

impl Child {
    /// No output at all.
    #[must_use]
    pub(super) fn none() -> Self {
        Child::List(Vec::new())
    }
}

impl From<VNode> for Child {
    fn from(node: VNode) -> Self {
        Child::Node(node)
    }
}

/// A definition shared by elements (`<mask>`, `<filter>`, `<symbol>`, ...).
/// Its id is derived from its CONTENT, never a counter or randomness: the same
/// id says the same bytes, which is what makes a repeated id across several
/// inline-injected SVGs harmless and first-occurrence-wins deduplication sound.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct SvgDef {
    pub(super) id: String,
    pub(super) node: VNode,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct VNode {
    pub(super) tag: &'static str,
    pub(super) attrs: Attrs,
    /// Absent children self-close the element (`<g/>`); present but empty
    /// keeps the open-and-close form (`<g></g>`). The distinction is load-bearing for
    /// byte-identical output.
    pub(super) children: Option<Vec<Child>>,
    /// Definitions this element depends on, hoisted into the document's single
    /// `<defs>` and emitted only when something references them.
    pub(super) defs: Vec<SvgDef>,
}

impl VNode {
    /// An element holding `children`, written open and close.
    #[must_use]
    pub(super) fn el(tag: &'static str, attrs: Attrs, children: Vec<Child>) -> Self {
        Self { tag, attrs, children: Some(children), defs: Vec::new() }
    }

    /// A self-closing element.
    #[must_use]
    pub(super) fn leaf(tag: &'static str, attrs: Attrs) -> Self {
        Self { tag, attrs, children: None, defs: Vec::new() }
    }

    #[must_use]
    pub(super) fn with_defs(mut self, defs: Vec<SvgDef>) -> Self {
        self.defs = defs;
        self
    }

    #[must_use]
    pub(super) fn with_attrs(mut self, attrs: Attrs) -> Self {
        self.attrs = attrs;
        self
    }
}
