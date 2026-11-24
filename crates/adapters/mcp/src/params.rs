//! The params of each served request, as the SDK's `@modelcontextprotocol/core`
//! schemas declare them, members in declaration order (Zod reports issues
//! in that order). `_meta` is left out: the envelope already refused a
//! message whose `_meta` `RequestMetaSchema` refuses, so no request reaching
//! a method holds one.

use crate::schema::{Field, Shape};

/// A member an object must hold. A struct literal rather than a `const fn`,
/// so a nested shape is a constant the compiler promotes to `'static`.
macro_rules! required {
    ($name:literal, $shape:expr $(,)?) => {
        Field { name: $name, shape: $shape, optional: false }
    };
}

/// A member an object may leave out.
macro_rules! optional {
    ($name:literal, $shape:expr $(,)?) => {
        Field { name: $name, shape: $shape, optional: true }
    };
}

const ICON: Shape = Shape::Object(&[
    required!("src", Shape::String),
    optional!("mimeType", Shape::String),
    optional!("sizes", Shape::Array(&Shape::String)),
    optional!("theme", Shape::Enum(&["light", "dark"])),
]);

/// `ImplementationSchema`: `BaseMetadataSchema`'s members, then the icons,
/// then its own.
const IMPLEMENTATION: Shape = Shape::Object(&[
    required!("name", Shape::String),
    optional!("title", Shape::String),
    optional!("icons", Shape::Array(&ICON)),
    required!("version", Shape::String),
    optional!("websiteUrl", Shape::String),
    optional!("description", Shape::String),
]);

const FORM_ELICITATION: Shape =
    Shape::Both(&Shape::Object(&[optional!("applyDefaults", Shape::Boolean)]), &Shape::JsonObject);

/// `ElicitationCapabilitySchema`. Its preprocess turns `{}` into
/// `{ form: {} }`, which this shape takes as it takes `{}`.
const ELICITATION: Shape = Shape::Both(
    &Shape::Object(&[optional!("form", FORM_ELICITATION), optional!("url", Shape::JsonObject)]),
    &Shape::JsonObject,
);

const CLIENT_TASKS: Shape = Shape::Object(&[
    optional!("list", Shape::JsonObject),
    optional!("cancel", Shape::JsonObject),
    optional!(
        "requests",
        Shape::Object(&[
            optional!("sampling", Shape::Object(&[optional!("createMessage", Shape::JsonObject)])),
            optional!("elicitation", Shape::Object(&[optional!("create", Shape::JsonObject)])),
        ]),
    ),
]);

const CLIENT_CAPABILITIES: Shape = Shape::Object(&[
    optional!("experimental", Shape::Record(&Shape::JsonObject)),
    optional!(
        "sampling",
        Shape::Object(&[
            optional!("context", Shape::JsonObject),
            optional!("tools", Shape::JsonObject)
        ]),
    ),
    optional!("elicitation", ELICITATION),
    optional!("roots", Shape::Object(&[optional!("listChanged", Shape::Boolean)])),
    optional!("tasks", CLIENT_TASKS),
    optional!("extensions", Shape::Record(&Shape::JsonObject)),
]);

/// `InitializeRequestParamsSchema`.
pub(crate) static INITIALIZE: Shape = Shape::Object(&[
    required!("protocolVersion", Shape::String),
    required!("capabilities", CLIENT_CAPABILITIES),
    required!("clientInfo", IMPLEMENTATION),
]);

/// `SetLevelRequestParamsSchema`.
pub(crate) static SET_LEVEL: Shape = Shape::Object(&[required!(
    "level",
    Shape::Enum(&["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]),
)]);

/// `PaginatedRequestParamsSchema`, for `tools/list`.
pub(crate) static PAGINATED: Shape = Shape::Object(&[optional!("cursor", Shape::String)]);

/// `CallToolRequestParamsSchema`: `TaskAugmentedRequestParamsSchema`'s
/// `task` first, then its own members.
pub(crate) static CALL_TOOL: Shape = Shape::Object(&[
    optional!("task", Shape::Object(&[optional!("ttl", Shape::Number)])),
    required!("name", Shape::String),
    optional!("arguments", Shape::JsonObject),
]);
