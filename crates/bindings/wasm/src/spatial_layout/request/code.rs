//! The fences' tokens a request carries (`codeTokens`): what the caller's
//! highlighter answered for each fence the core asked for, as
//! `[lang, value, lines]` with `lines` null when it answered nothing.

use whiteboard_canvas_render::references::FenceTokens;
use whiteboard_canvas_render::typeset::{CodeToken, TokenRole};
use whiteboard_model::Value;

use crate::json_canvas_wire::{Fields, items_of, string_of};

fn role_of(value: &Value) -> Option<TokenRole> {
    Some(match string_of(value)?.as_str() {
        "keyword" => TokenRole::Keyword,
        "string" => TokenRole::String,
        "number" => TokenRole::Number,
        "comment" => TokenRole::Comment,
        _ => return None,
    })
}

fn token_of(value: &Value) -> Option<CodeToken> {
    let mut f = Fields::of(value)?;
    let token = CodeToken { text: f.field("text", string_of)??, role: f.field("role", role_of)? };
    f.all_named().then_some(token)
}

fn fence_of(value: &Value) -> Option<FenceTokens> {
    let Value::Seq(items) = value else { return None };
    let [lang, source, lines] = items.as_slice() else { return None };
    let lines = match lines {
        Value::Null => None,
        lines => Some(items_of(lines, |line| items_of(line, token_of))?),
    };
    Some(FenceTokens { lang: string_of(lang)?, value: string_of(source)?, lines })
}

pub(super) fn code_tokens_of(value: &Value) -> Option<Vec<FenceTokens>> {
    items_of(value, fence_of)
}
