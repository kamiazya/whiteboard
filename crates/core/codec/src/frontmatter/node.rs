//! The tree the reader builds before it decides what a document means.

/// How a scalar was written, which decides whether it is resolved by the
/// core schema (plain only) or is a string whatever it spells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Style {
    Plain,
    Quoted,
    Block,
}

/// The properties written before a node.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Props {
    pub(super) anchored: bool,
    pub(super) tagged: bool,
}

/// A construct the subset refuses, read past so that the refusal comes where
/// the TypeScript visit raises it: after any syntax error, and in tree order
/// beside the anchors, tags and depth it also refuses.
pub(super) type Outside = Option<&'static str>;

/// A key, its value, and the construct outside the subset the pair is written with.
#[derive(Debug, Clone)]
pub(super) struct Pair {
    pub(super) key: Node,
    pub(super) value: Node,
    pub(super) outside: Outside,
}

#[derive(Debug, Clone)]
pub(super) enum Node {
    Scalar {
        text: String,
        style: Style,
        props: Props,
    },
    /// A sequence; `outside` marks a flow sequence holding a pair.
    Seq {
        items: Vec<Node>,
        props: Props,
        outside: Outside,
    },
    Map {
        pairs: Vec<Pair>,
        props: Props,
    },
    Alias,
}

impl Node {
    /// An empty plain scalar: how a missing value reads.
    pub(super) fn null() -> Node {
        Node::scalar(String::new(), Style::Plain)
    }

    pub(super) fn scalar(text: String, style: Style) -> Node {
        Node::Scalar { text, style, props: Props::default() }
    }

    /// The node with `more` properties added to its own.
    pub(super) fn with_props(mut self, more: Props) -> Node {
        if let Node::Scalar { props, .. } | Node::Seq { props, .. } | Node::Map { props, .. } =
            &mut self
        {
            props.anchored |= more.anchored;
            props.tagged |= more.tagged;
        }
        self
    }
}
