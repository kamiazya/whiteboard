//! A tree as one line, for tests that assert what was read.

/// A tree as one line: kinds only, children in parentheses, text values quoted.
pub(crate) fn shape(node: &whiteboard_markdown::mdast::Node) -> String {
    use whiteboard_markdown::mdast::Node;
    let (name, extra) = match node {
        Node::Root(_) => ("root", String::new()),
        Node::Paragraph(_) => ("p", String::new()),
        Node::Heading(heading) => ("h", heading.depth.to_string()),
        Node::ThematicBreak(_) => ("hr", String::new()),
        Node::Blockquote(_) => ("quote", String::new()),
        Node::List(list) => (if list.ordered { "ol" } else { "ul" }, String::new()),
        Node::ListItem(_) => ("li", String::new()),
        Node::Code(code) => ("code", format!("{:?}", code.value)),
        Node::Text(text) => ("text", format!("{:?}", text.value)),
        Node::Emphasis(_) => ("em", String::new()),
        Node::Strong(_) => ("strong", String::new()),
        Node::Delete(_) => ("del", String::new()),
        Node::Link(link) => ("link", link.url.clone()),
        Node::InlineCode(code) => ("icode", format!("{:?}", code.value)),
        Node::Html(html) => ("html", format!("{:?}", html.value)),
        Node::Definition(definition) => ("def", definition.url.clone()),
        Node::Table(_) => ("table", String::new()),
        Node::TableRow(_) => ("row", String::new()),
        Node::TableCell(_) => ("cell", String::new()),
        other => ("other", format!("{other:?}")),
    };
    let children = match node.children() {
        Some(children) if !children.is_empty() => {
            let inner: Vec<String> = children.iter().map(shape).collect();
            format!("({})", inner.join(" "))
        }
        _ => String::new(),
    };
    if extra.is_empty() {
        format!("{name}{children}")
    } else {
        format!("{name}[{extra}]{children}")
    }
}
