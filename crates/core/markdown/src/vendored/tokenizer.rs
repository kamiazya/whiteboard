//! A tokenizer glues states from the state machine together.
//!
//! It facilitates everything needed to turn bytes into events with a state
//! machine.
//! It also enables the logic needed for parsing markdown, such as an
//! [`attempt`][] to try and parse something, which can succeed or, when
//! unsuccessful, revert the attempt.
//!
//! [`attempt`]: Tokenizer::attempt

use crate::vendored::event::{Content, Event, Kind, Link, Name, Point};
use crate::vendored::parser::ParseState;
use crate::vendored::resolve::{Name as ResolveName, call as call_resolve};
use crate::vendored::state::{State, call};
use crate::vendored::subtokenize::Subresult;
use core::mem::take;

use crate::vendored::util::{constant::TAB_SIZE, edit_map::EditMap};
use alloc::{boxed::Box, collections::BTreeSet, string::String, vec, vec::Vec};

/// Containers.
///
/// Containers are found when tokenizing
/// [document content][crate::vendored::construct::document].
/// They parse a portion at the start of one or more lines.
/// The rest of those lines is a different content type (specifically, flow),
/// which they “contain”.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Container {
    /// [Block quote][crate::vendored::construct::block_quote].
    BlockQuote,
    /// [List item][crate::vendored::construct::list_item].
    ListItem,
    /// [GFM: Footnote definition][crate::vendored::construct::gfm_footnote_definition].
    GfmFootnoteDefinition,
}

/// Info used to tokenize a container.
///
/// Practically, these fields are only used for list items.
#[derive(Debug)]
pub(crate) struct ContainerState {
    /// Kind.
    pub(crate) kind: Container,
    /// Whether the first line was blank.
    pub(crate) blank_initial: bool,
    /// Size.
    pub(crate) size: usize,
}

/// How to handle a byte.
#[derive(Debug, PartialEq)]
enum ByteAction {
    /// This is a normal byte.
    ///
    /// Includes replaced bytes.
    Normal(u8),
    /// This byte must be ignored.
    Ignore,
    /// This is a new byte.
    Insert(u8),
}

/// Label start kind.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LabelKind {
    /// Label (image) start.
    ///
    /// ```markdown
    /// > | a ![b] c
    ///       ^^
    /// ```
    ///
    /// Construct: [Label start (image)][crate::vendored::construct::label_start_image].
    Image,
    /// Label (image) link.
    ///
    /// ```markdown
    /// > | a [b] c
    ///       ^
    /// ```
    ///
    /// Construct: [Label start (link)][crate::vendored::construct::label_start_link].
    Link,
    /// GFM: Label (footnote) link.
    ///
    /// ```markdown
    /// > | a [^b] c
    ///       ^^
    /// ```
    ///
    /// Construct: [GFM: Label start (footnote)][crate::vendored::construct::gfm_label_start_footnote].
    GfmFootnote,
    /// GFM: Label (footnote) link, not matching a footnote definition, so
    /// handled as a label (link) start.
    ///
    /// ```markdown
    /// > | a [^b](c) d
    ///       ^^
    /// ```
    ///
    /// Construct: [Label end][crate::vendored::construct::label_end].
    GfmUndefinedFootnote,
}

/// Label start, looking for an end.
#[derive(Debug)]
pub(crate) struct LabelStart {
    /// Kind of start.
    pub(crate) kind: LabelKind,
    /// Indices of where the label starts and ends in `events`.
    pub(crate) start: (usize, usize),
    /// A boolean used internally to figure out if a (link) label start can’t
    /// be used anymore (because it would contain another link).
    /// That link start is still looking for a balanced closing bracket though,
    /// so we can’t remove it just yet.
    pub(crate) inactive: bool,
}

/// Valid label.
#[derive(Debug)]
pub(crate) struct Label {
    pub(crate) kind: LabelKind,
    /// Indices of label start.
    pub(crate) start: (usize, usize),
    /// Indices of label end.
    pub(crate) end: (usize, usize),
}

/// Different kinds of attempts.
#[derive(Debug, PartialEq)]
enum AttemptKind {
    /// Discard what was tokenized when unsuccessful.
    Attempt,
    /// Discard always.
    Check,
}

/// How to handle [`State::Ok`][] or [`State::Nok`][].
#[derive(Debug)]
struct Attempt {
    /// Where to go to when successful.
    ok: State,
    /// Where to go to when unsuccessful.
    nok: State,
    /// Kind of attempt.
    kind: AttemptKind,
    /// If needed, the progress to revert to.
    ///
    /// It is not needed to discard an [`AttemptKind::Attempt`] that has a
    /// `nok` of [`State::Nok`][], because that means it is used in *another*
    /// attempt, which will receive that `Nok`, and has to handle it.
    progress: Option<Progress>,
}

/// The internal state of a tokenizer.
///
/// Not to be confused with states from the state machine, this instead is all
/// the information on where we currently are and what’s going on.
#[derive(Clone, Debug)]
struct Progress {
    /// Length of `events`.
    ///
    /// It’s not allowed to remove events, so reverting will just pop stuff off.
    events_len: usize,
    /// Length of the stack.
    ///
    /// It’s not allowed to decrease the stack in an attempt.
    stack_len: usize,
    /// Previous code.
    previous: Option<u8>,
    /// Current code.
    current: Option<u8>,
    /// Current place in the file.
    point: Point,
}

/// A lot of shared fields used to tokenize things.
#[derive(Debug)]
pub(crate) struct TokenizeState<'a> {
    // Couple complex fields used to tokenize the document.
    /// Tokenizer, used to tokenize flow in document.
    pub(crate) document_child: Option<Box<Tokenizer<'a>>>,
    /// State, used to tokenize containers.
    pub(crate) document_child_state: Option<State>,
    /// Stack of currently active containers.
    pub(crate) document_container_stack: Vec<ContainerState>,
    /// How many active containers continued.
    pub(crate) document_continued: usize,
    /// Index of last `data`.
    pub(crate) document_data_index: Option<usize>,
    /// Container exits by line number.
    pub(crate) document_exits: Vec<Option<Vec<Event>>>,
    /// Whether the previous flow was a paragraph or a definition.
    pub(crate) document_lazy_accepting_before: bool,
    /// Whether this is the first paragraph (potentially after definitions) in
    /// a list item.
    /// Used for GFM task list items.
    pub(crate) document_at_first_paragraph_of_list_item: bool,

    // Couple of very frequent settings for parsing whitespace.
    pub(crate) space_or_tab_eol_content: Option<Content>,
    pub(crate) space_or_tab_eol_connect: bool,
    pub(crate) space_or_tab_eol_ok: bool,
    pub(crate) space_or_tab_connect: bool,
    pub(crate) space_or_tab_content: Option<Content>,
    pub(crate) space_or_tab_min: usize,
    pub(crate) space_or_tab_max: usize,
    pub(crate) space_or_tab_size: usize,
    pub(crate) space_or_tab_token: Name,

    // Couple of media related fields.
    /// List of usable label starts.
    ///
    /// Used when tokenizing [text content][crate::vendored::construct::text].
    pub(crate) label_starts: Vec<LabelStart>,
    /// List of unusable label starts.
    ///
    /// Used when tokenizing [text content][crate::vendored::construct::text].
    pub(crate) label_starts_loose: Vec<LabelStart>,
    /// Stack of images and links.
    ///
    /// Used when tokenizing [text content][crate::vendored::construct::text].
    pub(crate) labels: Vec<Label>,

    /// Defined definition identifiers.
    pub(crate) definitions: BTreeSet<String>,
    /// Defined GFM footnote definition identifiers.
    pub(crate) gfm_footnote_definitions: BTreeSet<String>,

    /// Whether to connect events.
    pub(crate) connect: bool,
    /// Marker.
    pub(crate) marker: u8,
    /// Secondary marker.
    pub(crate) marker_b: u8,
    /// Several markers.
    pub(crate) markers: &'static [u8],
    /// Whether something was seen.
    pub(crate) seen: bool,
    /// Size.
    pub(crate) size: usize,
    /// Secondary size.
    pub(crate) size_b: usize,
    /// Tertiary size.
    pub(crate) size_c: usize,
    /// Index.
    pub(crate) start: usize,
    /// Index.
    pub(crate) end: usize,
    /// Slot for an event name.
    pub(crate) token_1: Name,
    /// Slot for an event name.
    pub(crate) token_2: Name,
    /// Slot for an event name.
    pub(crate) token_3: Name,
    /// Slot for an event name.
    pub(crate) token_4: Name,
    /// Slot for an event name.
    pub(crate) token_5: Name,
    /// Slot for an event name.
    pub(crate) token_6: Name,
}

/// A tokenizer itself.
#[derive(Debug)]
pub(crate) struct Tokenizer<'a> {
    /// Jump between line endings.
    column_start: Vec<(usize, usize)>,
    // First line where this tokenizer starts.
    first_line: usize,
    /// Current point after the last line ending (excluding jump).
    line_start: Point,
    /// Track whether the current byte is already consumed (`true`) or expected
    /// to be consumed (`false`).
    ///
    /// Tracked to make sure everything’s valid.
    consumed: bool,
    /// Stack of how to handle attempts.
    attempts: Vec<Attempt>,
    /// Current byte.
    pub(crate) current: Option<u8>,
    /// Previous byte.
    pub(crate) previous: Option<u8>,
    /// Current relative and absolute place in the file.
    pub(crate) point: Point,
    /// Semantic labels.
    pub(crate) events: Vec<Event>,
    /// Hierarchy of semantic labels.
    ///
    /// Tracked to make sure everything’s valid.
    pub(crate) stack: Vec<Name>,
    /// Edit map, to batch changes.
    pub(crate) map: EditMap,
    /// List of resolvers.
    pub(crate) resolvers: Vec<ResolveName>,
    /// Shared parsing state across tokenizers.
    pub(crate) parse_state: &'a ParseState<'a>,
    /// A lot of shared fields used to tokenize things.
    pub(crate) tokenize_state: TokenizeState<'a>,
    /// Whether we would be interrupting something.
    ///
    /// Used when tokenizing [flow content][crate::vendored::construct::flow].
    pub(crate) interrupt: bool,
    /// Whether containers cannot “pierce” into the current construct.
    ///
    /// Used when tokenizing [document content][crate::vendored::construct::document].
    pub(crate) concrete: bool,
    /// Whether this row is piercing into the current construct with more
    /// containers.
    ///
    /// Used when tokenizing [document content][crate::vendored::construct::document].
    pub(crate) pierce: bool,
    /// Whether this line is lazy: there are less containers than before.
    pub(crate) lazy: bool,
}

impl<'a> Tokenizer<'a> {
    /// Create a new tokenizer.
    pub(crate) fn new(point: Point, parse_state: &'a ParseState) -> Tokenizer<'a> {
        Tokenizer {
            previous: None,
            current: None,
            // To do: reserve size when feeding?
            column_start: vec![],
            first_line: point.line,
            line_start: point.clone(),
            consumed: true,
            attempts: vec![],
            point,
            stack: vec![],
            events: vec![],
            parse_state,
            tokenize_state: TokenizeState {
                connect: false,
                document_container_stack: vec![],
                document_exits: vec![],
                document_continued: 0,
                document_lazy_accepting_before: false,
                document_data_index: None,
                document_child_state: None,
                document_child: None,
                document_at_first_paragraph_of_list_item: false,
                definitions: BTreeSet::new(),
                gfm_footnote_definitions: BTreeSet::new(),
                end: 0,
                label_starts: vec![],
                label_starts_loose: vec![],
                marker: 0,
                marker_b: 0,
                markers: &[],
                labels: vec![],
                seen: false,
                size: 0,
                size_b: 0,
                size_c: 0,
                space_or_tab_eol_content: None,
                space_or_tab_eol_connect: false,
                space_or_tab_eol_ok: false,
                space_or_tab_connect: false,
                space_or_tab_content: None,
                space_or_tab_min: 0,
                space_or_tab_max: 0,
                space_or_tab_size: 0,
                space_or_tab_token: Name::SpaceOrTab,
                start: 0,
                token_1: Name::Data,
                token_2: Name::Data,
                token_3: Name::Data,
                token_4: Name::Data,
                token_5: Name::Data,
                token_6: Name::Data,
            },
            map: EditMap::new(),
            interrupt: false,
            pierce: false,
            concrete: false,
            lazy: false,
            resolvers: vec![],
        }
    }

    /// Register a resolver.
    pub(crate) fn register_resolver(&mut self, name: ResolveName) {
        if !self.resolvers.contains(&name) {
            self.resolvers.push(name);
        }
    }

    /// Register a resolver, before others.
    pub(crate) fn register_resolver_before(&mut self, name: ResolveName) {
        if !self.resolvers.contains(&name) {
            self.resolvers.insert(0, name);
        }
    }

    /// Define a jump between two places.
    ///
    /// This defines to which future index we move after a line ending.
    pub(crate) fn define_skip(&mut self, mut point: Point) {
        move_point_back(self, &mut point);

        let info = (point.index, point.vs);

        let at = point.line - self.first_line;

        if at >= self.column_start.len() {
            self.column_start.push(info);
        } else {
            self.column_start[at] = info;
        }

        self.account_for_potential_skip();
    }

    /// Increment the current positional info if we’re right after a line
    /// ending, which has a skip defined.
    fn account_for_potential_skip(&mut self) {
        let at = self.point.line - self.first_line;

        if self.point.column == 1 && at != self.column_start.len() {
            self.move_to(self.column_start[at]);
        }
    }

    /// Prepare for a next byte to get consumed.
    fn expect(&mut self, byte: Option<u8>) {
        self.consumed = false;
        self.current = byte;
    }

    /// Consume the current byte.
    /// Each state function is expected to call this to signal that this code is
    /// used, or call a next function.
    pub(crate) fn consume(&mut self) {
        self.move_one();

        self.previous = self.current;
        // While we’re not at eof, it is at least better to not have the
        // same current code as `previous` *and* `current`.
        self.current = None;
        // Mark as consumed.
        self.consumed = true;
    }

    /// Move to the next (virtual) byte.
    fn move_one(&mut self) {
        match byte_action(self.parse_state.bytes, &self.point) {
            ByteAction::Ignore => {
                self.point.index += 1;
            }
            ByteAction::Insert(byte) => {
                self.previous = Some(byte);
                self.point.column += 1;
                self.point.vs += 1;
            }
            ByteAction::Normal(byte) => {
                self.previous = Some(byte);
                self.point.vs = 0;
                self.point.index += 1;

                if byte == b'\n' {
                    self.point.line += 1;
                    self.point.column = 1;

                    if self.point.line - self.first_line + 1 > self.column_start.len() {
                        self.column_start.push((self.point.index, self.point.vs));
                    }

                    self.line_start = self.point.clone();

                    self.account_for_potential_skip();
                } else {
                    self.point.column += 1;
                }
            }
        }
    }

    /// Move (virtual) bytes.
    fn move_to(&mut self, to: (usize, usize)) {
        let (to_index, to_vs) = to;
        while self.point.index < to_index || self.point.index == to_index && self.point.vs < to_vs {
            self.move_one();
        }
    }

    /// Mark the start of a semantic label.
    pub(crate) fn enter(&mut self, name: Name) {
        enter_impl(self, name, None);
    }

    /// Enter with a link.
    pub(crate) fn enter_link(&mut self, name: Name, link: Link) {
        enter_impl(self, name, Some(link));
    }

    /// Mark the end of a semantic label.
    pub(crate) fn exit(&mut self, name: Name) {
        if self.stack.pop().is_none() || self.events.is_empty() {
            return;
        }
        let mut point = self.point.clone();

        // A bit weird, but if we exit right after a line ending, we *don’t* want to consider
        // potential skips.
        if matches!(self.previous, Some(b'\n')) {
            point = self.line_start.clone();
        } else {
            move_point_back(self, &mut point);
        }

        let event = Event { kind: Kind::Exit, name, point, link: None };
        self.events.push(event);
    }

    /// Capture the tokenizer progress.
    fn capture(&mut self) -> Progress {
        Progress {
            previous: self.previous,
            current: self.current,
            point: self.point.clone(),
            events_len: self.events.len(),
            stack_len: self.stack.len(),
        }
    }

    /// Apply tokenizer progress.
    fn free(&mut self, previous: Progress) {
        self.previous = previous.previous;
        self.current = previous.current;
        self.point = previous.point;
        self.events.truncate(previous.events_len);
        self.stack.truncate(previous.stack_len);
    }

    /// Stack an attempt, moving to `ok` on [`State::Ok`][] and `nok` on
    /// [`State::Nok`][], reverting in both cases.
    pub(crate) fn check(&mut self, ok: State, nok: State) {
        // Always capture (and restore) when checking.
        // No need to capture (and restore) when `nok` is `State::Nok`, because the
        // parent attempt will do it.
        let progress = Some(self.capture());
        let attempt = Attempt { kind: AttemptKind::Check, progress, ok, nok };
        self.attempts.push(attempt);
    }

    /// Stack an attempt, moving to `ok` on [`State::Ok`][] and `nok` on
    /// [`State::Nok`][], reverting in the latter case.
    pub(crate) fn attempt(&mut self, ok: State, nok: State) {
        // Always capture (and restore) when checking.
        // No need to capture (and restore) when `nok` is `State::Nok`, because the
        // parent attempt will do it.
        let progress = if nok == State::Nok { None } else { Some(self.capture()) };

        let attempt = Attempt { kind: AttemptKind::Attempt, progress, ok, nok };
        self.attempts.push(attempt);
    }

    /// Tokenize.
    pub(crate) fn push(&mut self, from: (usize, usize), to: (usize, usize), state: State) -> State {
        push_impl(self, from, to, state, false)
    }

    /// Flush.
    pub(crate) fn flush(&mut self, state: State, resolve: bool) -> Subresult {
        let to = (self.point.index, self.point.vs);
        push_impl(self, to, to, state, true);

        let mut value = Subresult {
            done: false,
            gfm_footnote_definitions: take(&mut self.tokenize_state.gfm_footnote_definitions),
            definitions: take(&mut self.tokenize_state.definitions),
        };

        if resolve && self.parse_state.budget.refusal().is_none() {
            let resolvers = self.resolvers.split_off(0);
            let mut index = 0;
            let defs = &mut value.definitions;
            let fn_defs = &mut value.gfm_footnote_definitions;
            while index < resolvers.len() {
                if let Some(mut result) = call_resolve(self, resolvers[index]) {
                    fn_defs.extend(take(&mut result.gfm_footnote_definitions));
                    defs.extend(take(&mut result.definitions));
                }
                index += 1;
            }

            self.map.consume(&mut self.events);
        }

        value
    }
}

/// Move back past ignored bytes.
fn move_point_back(tokenizer: &mut Tokenizer, point: &mut Point) {
    while point.index > 0 {
        point.index -= 1;
        let action = byte_action(tokenizer.parse_state.bytes, point);
        if !matches!(action, ByteAction::Ignore) {
            point.index += 1;
            break;
        }
    }
}

/// Enter.
fn enter_impl(tokenizer: &mut Tokenizer, name: Name, link: Option<Link>) {
    let mut point = tokenizer.point.clone();
    move_point_back(tokenizer, &mut point);

    tokenizer.stack.push(name.clone());
    tokenizer.events.push(Event { kind: Kind::Enter, name, point, link });
}

/// Run the tokenizer.
fn push_impl(
    tokenizer: &mut Tokenizer,
    from: (usize, usize),
    to: (usize, usize),
    mut state: State,
    flush: bool,
) -> State {
    tokenizer.move_to(from);

    loop {
        // Every transition is a unit of work, so a text that makes the machine
        // walk the same ground over and over runs out of fuel and stops.
        if !tokenizer.parse_state.budget.spend(1) {
            break;
        }

        match state {
            State::Ok | State::Nok => {
                if let Some(attempt) = tokenizer.attempts.pop() {
                    if (attempt.kind == AttemptKind::Check || state == State::Nok)
                        && let Some(progress) = attempt.progress
                    {
                        tokenizer.free(progress);
                    }

                    tokenizer.consumed = true;

                    let next = if state == State::Ok { attempt.ok } else { attempt.nok };

                    state = next;
                } else {
                    break;
                }
            }
            State::Next(name) => {
                let action = if tokenizer.point.index < to.0
                    || (tokenizer.point.index == to.0 && tokenizer.point.vs < to.1)
                {
                    Some(byte_action(tokenizer.parse_state.bytes, &tokenizer.point))
                } else if flush {
                    None
                } else {
                    break;
                };

                if let Some(ByteAction::Ignore) = action {
                    tokenizer.move_one();
                } else {
                    let byte =
                        if let Some(ByteAction::Insert(byte) | ByteAction::Normal(byte)) = action {
                            Some(byte)
                        } else {
                            None
                        };

                    tokenizer.expect(byte);
                    state = call(tokenizer, name);
                }
            }
            State::Retry(name) => {
                state = call(tokenizer, name);
            }
        }
    }

    tokenizer.consumed = true;

    state
}

/// Figure out how to handle a byte.
fn byte_action(bytes: &[u8], point: &Point) -> ByteAction {
    if point.index < bytes.len() {
        let byte = bytes[point.index];

        if byte == b'\r' {
            // CRLF.
            if point.index < bytes.len() - 1 && bytes[point.index + 1] == b'\n' {
                ByteAction::Ignore
            }
            // CR.
            else {
                ByteAction::Normal(b'\n')
            }
        } else if byte == b'\t' {
            let remainder = point.column % TAB_SIZE;
            let vs = if remainder == 0 { 0 } else { TAB_SIZE - remainder };

            // On the tab itself, first send it.
            if point.vs == 0 {
                if vs == 0 { ByteAction::Normal(byte) } else { ByteAction::Insert(byte) }
            } else if vs == 0 {
                ByteAction::Normal(b' ')
            } else {
                ByteAction::Insert(b' ')
            }
        } else {
            ByteAction::Normal(byte)
        }
    } else {
        unreachable!("out of bounds")
    }
}
