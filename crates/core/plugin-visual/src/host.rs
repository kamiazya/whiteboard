//! The bundled visual plugin loaded from its files (ADR-0054 decision 12):
//! what its contract leaves to a host, and the registry built over the
//! manifest, contract and asset tables the TypeScript package also reads
//! (owner decision q45: one set of files, the single source).

use whiteboard_facet_engine::plugin::{LoadError, PluginSources, build};
use whiteboard_facet_engine::registry::Registry;
use whiteboard_facet_engine::schema::{Code, Detail, External, Host, Issue};
use whiteboard_model::Value;

use crate::checks;

const MANIFEST: &str = include_str!("../../../../packages/plugin-visual/src/visual.manifest.json");
const CONTRACT: &str = include_str!("../../../../contracts/facets/visual/visual.schema.json");
const THEMES: &str = include_str!("../../../../packages/plugin-visual/src/assets/themes.json");
const STENCILS: &str = include_str!("../../../../packages/plugin-visual/src/assets/stencils.json");
const LUCIDE: &str =
    include_str!("../../../../packages/plugin-visual/src/assets/icons-lucide.json");
const GLYPHS: &str =
    include_str!("../../../../packages/plugin-visual/src/assets/icons-glyphs.json");

const CONTRACT_PATH: &str = "facets/visual/visual.schema.json";

/// The model's `CanvasColor`, as its union answers: a preset or a six-digit
/// hex string. A string that is neither is refused by the hex arm alone (the
/// preset arm's refusal stops, the hex arm's does not, and a union whose one
/// live arm is unambiguous speaks with that arm's issues); anything else is
/// refused by both.
fn canvas_color(value: &Value) -> Result<Value, Vec<Issue>> {
    match value {
        Value::String(text) if checks::canvas_color(text) => Ok(value.clone()),
        Value::String(_) => Err(vec![Issue {
            path: Vec::new(),
            code: Code::InvalidFormat,
            detail: Detail::None,
            continues: true,
        }]),
        _ => {
            let arm = |code| {
                vec![Issue { path: Vec::new(), code, detail: Detail::None, continues: false }]
            };
            let arms = vec![arm(Code::InvalidValue), arm(Code::InvalidType)];
            Err(vec![Issue {
                path: Vec::new(),
                code: Code::InvalidUnion,
                detail: Detail::Arms(arms),
                continues: false,
            }])
        }
    }
}

/// What `contracts/facets/visual` leaves to its host, beside the engine's own
/// matchers: its tag grammar, the two named checks, and the three definitions
/// the model owns (`EdgeRoutingStyle` and `LineJumps` as the contract writes
/// them, `CanvasColor` by the model's own union).
pub const VISUAL_HOST: Host<'static> = Host {
    matchers: &[("tag_identifier", checks::tag_identifier)],
    checks: &[("single_grapheme", checks::single_grapheme), ("canvas_color", checks::canvas_color)],
    externals: &[
        ("EdgeRoutingStyle", External::AsWritten),
        ("LineJumps", External::AsWritten),
        ("CanvasColor", External::Validator(canvas_color)),
    ],
};

/// The text of each file the plugin is made of.
#[derive(Debug, Clone, Copy)]
pub struct VisualSources<'a> {
    pub manifest: &'a str,
    pub contract: &'a str,
    pub themes: &'a str,
    pub stencils: &'a str,
    /// The vendored lucide icons, registered first.
    pub lucide_icons: &'a str,
    /// The glyphs (edge, category, signature), registered after them.
    pub glyph_icons: &'a str,
}

/// Loads the plugin `sources` describe.
///
/// # Errors
///
/// Why the files do not make a plugin: see [`LoadError`].
pub fn registry_from(sources: &VisualSources<'_>) -> Result<Registry, LoadError> {
    build(
        &PluginSources {
            manifest: sources.manifest,
            contracts: &[(CONTRACT_PATH, sources.contract)],
            tables: &[
                ("visual.themes", sources.themes),
                ("visual.icons", sources.lucide_icons),
                ("visual.icons", sources.glyph_icons),
                ("visual.stencils", sources.stencils),
            ],
            migrations: &[],
        },
        &VISUAL_HOST,
    )
}

/// The registry of the bundled plugin, from the files the TypeScript package
/// holds.
///
/// ponytail: rebuilt on every call; cache it behind a `OnceLock` when the wasm
/// export that serves writes lands.
///
/// # Errors
///
/// [`LoadError`] if the bundled files are not a plugin, which a test holds
/// they are.
pub fn visual_registry() -> Result<Registry, LoadError> {
    registry_from(&VisualSources {
        manifest: MANIFEST,
        contract: CONTRACT,
        themes: THEMES,
        stencils: STENCILS,
        lucide_icons: LUCIDE,
        glyph_icons: GLYPHS,
    })
}
