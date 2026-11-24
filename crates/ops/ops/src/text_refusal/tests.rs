use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const REFUSALS: &str = include_str!("../../../../../contracts/api/refusals.json");

fn breach(shape: BreachShape, fields: Vec<(&'static str, Value)>) -> TextBreach {
    TextBreach { shape, fields }
}

fn number(n: f64) -> Value {
    Value::Number(n)
}

fn string(text: &str) -> Value {
    Value::String(text.to_owned())
}

/// The `limit` the contract's example gives the refusal `name`.
fn example_limit(name: &str) -> String {
    let contract: serde_json::Value = serde_json::from_str(REFUSALS).expect("JSON");
    let entry = contract["refusals"]
        .as_array()
        .expect("refusals")
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap_or_else(|| panic!("{name} is in the contract"));
    entry["example"]["limit"].as_str().unwrap_or_else(|| panic!("{name} has a limit")).to_owned()
}

#[test]
fn every_phrase_is_the_one_the_contract_gives_its_refusal() {
    let pairs = [
        ("MarkdownBodyDocument", phrase::MARKDOWN),
        ("NodeTextTooLargeDocument", phrase::NODE_TEXT),
        ("NodeLocationTooLargeDocument", phrase::NODE_LOCATION),
        ("LabelTooLargeDocument", phrase::LABEL),
        ("CommentMessageTooLargeDocument", phrase::COMMENT_MESSAGE),
        ("ContainerNameTooLongDocument", phrase::CONTAINER_NAME),
        ("CommentAnchorTooLargeDocument", phrase::ANCHOR_NODES),
        ("AnchorQuoteTooLongDocument", phrase::TEXT_ANCHOR_QUOTE),
        ("TooManyOpenThreadsDocument", phrase::OPEN_THREADS),
        ("TooManyOpenChangesDocument", phrase::OPEN_CHANGES),
        ("TooManyThreadMessagesDocument", phrase::THREAD_MESSAGES),
        ("TagsCountBoardDocument", phrase::TAG_COUNT),
        ("TagsLengthBoardDocument", phrase::TAG_LENGTH),
        ("CanvasTooLargeNodesDocument", phrase::CANVAS_NODES),
        ("CanvasTooLargeEdgesAndLinesDocument", phrase::CANVAS_EDGES_AND_LINES),
    ];
    for (name, phrase) in pairs {
        assert_eq!(example_limit(name), phrase, "{name}");
    }
}

/// The body.
fn body_cases() -> Vec<(TextBreach, Refusal)> {
    vec![
        (
            breach(
                BreachShape::Body,
                vec![("chars", number(300_000.0)), ("container", string("c"))],
            ),
            Refusal::MarkdownBodyDocument {
                chars: 300_000,
                limit: phrase::MARKDOWN.to_owned(),
                path: "p".to_owned(),
            },
        ),
        (
            breach(BreachShape::Run, vec![("chars", number(300_000.0))]),
            Refusal::MarkdownRunDocument { chars: 300_000, max_chars: 262_144, path: "p".into() },
        ),
        (
            breach(BreachShape::Runs, vec![("chars", number(9.0)), ("runs", number(3.0))]),
            Refusal::MarkdownRunsDocument {
                chars: 9,
                max_chars: 262_144,
                path: "p".into(),
                runs: 3,
            },
        ),
    ]
}

/// The texts a node, an edge or a message carries.
fn value_cases() -> Vec<(TextBreach, Refusal)> {
    vec![
        (
            breach(BreachShape::NodeText, vec![("chars", number(9000.0)), ("nodeId", string("n"))]),
            Refusal::NodeTextTooLargeDocument {
                chars: 9000,
                limit: phrase::NODE_TEXT.into(),
                node_id: "n".into(),
                path: "p".into(),
            },
        ),
        (
            breach(
                BreachShape::NodeLocation,
                vec![("chars", number(9.0)), ("nodeId", string("n"))],
            ),
            Refusal::NodeLocationTooLargeDocument {
                chars: 9,
                limit: phrase::NODE_LOCATION.into(),
                node_id: "n".into(),
                path: "p".into(),
            },
        ),
        (
            breach(BreachShape::Label, vec![("chars", number(2.0)), ("elementId", string("e"))]),
            Refusal::LabelTooLargeDocument {
                chars: 2,
                element_id: "e".into(),
                limit: phrase::LABEL.into(),
                path: "p".into(),
            },
        ),
        (
            breach(
                BreachShape::CommentMessage,
                vec![("chars", number(5.0)), ("messageId", string("m"))],
            ),
            Refusal::CommentMessageTooLargeDocument {
                chars: 5,
                limit: phrase::COMMENT_MESSAGE.into(),
                message_id: "m".into(),
                path: "p".into(),
            },
        ),
    ]
}

/// A container's name, and an anchor.
fn anchor_cases() -> Vec<(TextBreach, Refusal)> {
    vec![
        (
            breach(BreachShape::ContainerName, vec![("chars", number(2000.0))]),
            Refusal::ContainerNameTooLongDocument {
                chars: 2000,
                limit: phrase::CONTAINER_NAME.into(),
                path: "p".into(),
            },
        ),
        (
            breach(
                BreachShape::ThreadAnchor,
                vec![("count", number(3.0)), ("threadId", string("t"))],
            ),
            Refusal::CommentAnchorTooLargeDocument {
                count: 3,
                limit: phrase::ANCHOR_NODES.into(),
                path: "p".into(),
                thread_id: "t".into(),
            },
        ),
        (
            breach(
                BreachShape::AnchorQuote,
                vec![("chars", number(4.0)), ("elementId", string("e"))],
            ),
            Refusal::AnchorQuoteTooLongDocument {
                chars: 4,
                element_id: "e".into(),
                limit: phrase::TEXT_ANCHOR_QUOTE.into(),
                path: "p".into(),
            },
        ),
    ]
}

/// The annotation layer's counts.
fn count_cases() -> Vec<(TextBreach, Refusal)> {
    vec![
        (
            breach(BreachShape::OpenThreads, vec![("count", number(501.0))]),
            Refusal::TooManyOpenThreadsDocument {
                count: 501,
                limit: phrase::OPEN_THREADS.into(),
                path: "p".into(),
            },
        ),
        (
            breach(BreachShape::OpenChanges, vec![("count", number(1001.0))]),
            Refusal::TooManyOpenChangesDocument {
                count: 1001,
                limit: phrase::OPEN_CHANGES.into(),
                path: "p".into(),
            },
        ),
        (
            breach(BreachShape::ThreadMessages, vec![("count", number(1001.0))]),
            Refusal::TooManyThreadMessagesDocument {
                count: 1001,
                limit: phrase::THREAD_MESSAGES.into(),
                path: "p".into(),
            },
        ),
    ]
}

/// What a document's history left standing.
fn structure_cases() -> Vec<(TextBreach, Refusal)> {
    vec![
        (
            breach(BreachShape::ContentRoot, vec![("key", string("nodes"))]),
            Refusal::ContentRootKindDocument { key: "nodes".into(), path: "p".into() },
        ),
        (
            breach(BreachShape::UnattachedContainer, vec![("container", string("c"))]),
            Refusal::UnattachedContainerDocument { container: "c".into(), path: "p".into() },
        ),
        (
            breach(BreachShape::ReservedMapKey, vec![("container", string("c"))]),
            Refusal::ReservedMapKeyDocument { container: "c".into(), path: "p".into() },
        ),
        (
            breach(BreachShape::RetiredShape, vec![("found", string("f"))]),
            Refusal::RetiredShapeWrittenDocument { found: "f".into(), path: "p".into() },
        ),
        (
            breach(BreachShape::RetiredCommentPlane, vec![("rows", number(2.0))]),
            Refusal::RetiredCommentPlaneWrittenDocument { path: "p".into(), rows: 2 },
        ),
    ]
}

#[test]
fn a_breach_is_refused_naming_the_document_with_its_own_fields() {
    let cases =
        [body_cases(), value_cases(), anchor_cases(), count_cases(), structure_cases()].concat();
    assert_eq!(cases.len(), 18);
    for (given, refusal) in cases {
        assert_eq!(text_breach_refusal(&given, "p"), refusal, "{:?}", given.shape);
    }
}

#[test]
fn tags_are_refused_by_measure_and_bearer() {
    let tags = |measure: &str, element: Value| {
        breach(
            BreachShape::Tags,
            vec![("measure", string(measure)), ("amount", number(7.0)), ("elementId", element)],
        )
    };
    let (count, length) = (phrase::TAG_COUNT.to_owned(), phrase::TAG_LENGTH.to_owned());
    assert_eq!(
        text_breach_refusal(&tags("count", Value::Null), "p"),
        Refusal::TagsCountBoardDocument { amount: 7, limit: count.clone(), path: "p".into() }
    );
    assert_eq!(
        text_breach_refusal(&tags("count", string("e")), "p"),
        Refusal::TagsCountElementDocument {
            amount: 7,
            element_id: "e".into(),
            limit: count,
            path: "p".into()
        }
    );
    assert_eq!(
        text_breach_refusal(&tags("chars", Value::Null), "p"),
        Refusal::TagsLengthBoardDocument { amount: 7, limit: length.clone(), path: "p".into() }
    );
    assert_eq!(
        text_breach_refusal(&tags("chars", string("e")), "p"),
        Refusal::TagsLengthElementDocument {
            amount: 7,
            element_id: "e".into(),
            limit: length,
            path: "p".into()
        }
    );
}

#[test]
fn a_canvas_is_refused_by_what_it_holds_too_many_of() {
    let canvas = |measure: &str| {
        breach(
            BreachShape::CanvasSize,
            vec![("measure", string(measure)), ("count", number(2001.0))],
        )
    };
    assert_eq!(
        text_breach_refusal(&canvas("nodes"), "p"),
        Refusal::CanvasTooLargeNodesDocument {
            count: 2001,
            limit: phrase::CANVAS_NODES.into(),
            path: "p".into()
        }
    );
    assert_eq!(
        text_breach_refusal(&canvas("edges-and-lines"), "p"),
        Refusal::CanvasTooLargeEdgesAndLinesDocument {
            count: 2001,
            limit: phrase::CANVAS_EDGES_AND_LINES.into(),
            path: "p".into()
        }
    );
}
