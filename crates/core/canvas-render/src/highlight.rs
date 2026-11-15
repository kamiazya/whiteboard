//! The gate of the default highlighter (`highlight/lowlight.ts`'s
//! `highlightCode`): whether it would colour a fence, and what that spends of
//! a layout's tokenizer account. The tokens themselves are the host's (ADR-0054
//! step 7, owner decision q75): the core asks for exactly the fences this gate
//! passes, and draws every other one plain, as the TypeScript does.

use crate::typeset::NestedLayoutBudget;

/// Aliases people write in a fence, mapped to a registered grammar (`ALIASES`).
const ALIASES: [(&str, &str); 13] = [
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("js", "javascript"),
    ("jsx", "javascript"),
    ("mjs", "javascript"),
    ("sh", "bash"),
    ("shell", "bash"),
    ("zsh", "bash"),
    ("py", "python"),
    ("md", "markdown"),
    ("html", "xml"),
    ("svg", "xml"),
    ("yml", "yaml"),
];

/// Every name highlight.js answers for: the nine grammars registered, and the
/// aliases each grammar declares of its own, which it registers beside them.
const REGISTERED: [&str; 38] = [
    "bash",
    "sh",
    "zsh",
    "css",
    "javascript",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "jsonc",
    "json5",
    "markdown",
    "md",
    "mkdown",
    "mkd",
    "python",
    "py",
    "gyp",
    "ipython",
    "typescript",
    "ts",
    "tsx",
    "mts",
    "cts",
    "xml",
    "html",
    "xhtml",
    "rss",
    "atom",
    "xjb",
    "xsd",
    "xsl",
    "plist",
    "wsf",
    "svg",
    "yaml",
    "yml",
];

/// The squared characters one fence may cost in identifier runs: one
/// 4096-character identifier.
const WORD_RUN_BUDGET: u64 = 4096 * 4096;

/// The squared characters one yaml fence may cost in whole lines.
const LINE_RUN_BUDGET: u64 = 8192 * 8192;

/// The grammar a fence's language names after the aliases, when registered.
fn grammar_of(lang: &str) -> Option<String> {
    let lower = lang.to_lowercase();
    let name =
        ALIASES.iter().find(|(alias, _)| *alias == lower).map_or(lower, |(_, n)| (*n).to_owned());
    REGISTERED.contains(&name.as_str()).then_some(name)
}

/// highlight.js's identifier run: ASCII letters, digits, `_` and `$`.
const fn in_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// The summed squared length, in UTF-16 units, of the runs of `value` whose
/// characters `in_run` holds, stopping once past `cap` (`runCost`).
fn run_cost(value: &str, in_run: impl Fn(char) -> bool, cap: u64) -> u64 {
    let mut total = 0_u64;
    let mut run = 0_u64;
    for c in value.chars().chain(std::iter::once('\n')) {
        if in_run(c) {
            run += if c.len_utf16() == 2 { 2 } else { 1 };
            continue;
        }
        total += run * run;
        run = 0;
        if total > cap {
            return total;
        }
    }
    total
}

/// Whether the default highlighter colours a fence of `lang` holding `value`,
/// spending its price from `budget` when it does; a fence it would not colour
/// spends nothing, and one the account cannot cover is counted as refused.
#[must_use]
pub fn would_colour(lang: &str, value: &str, budget: Option<&NestedLayoutBudget>) -> bool {
    let Some(name) = grammar_of(lang) else { return false };
    let words = run_cost(value, in_word, WORD_RUN_BUDGET);
    if words > WORD_RUN_BUDGET {
        return false;
    }
    let lines = if name == "yaml" { run_cost(value, |c| c != '\n', LINE_RUN_BUDGET) } else { 0 };
    if lines > LINE_RUN_BUDGET {
        return false;
    }
    budget.is_none_or(|budget| budget.spend_tokenizer(words, lines))
}
