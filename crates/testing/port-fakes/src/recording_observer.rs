use std::future::{Future, ready};
use std::sync::{Mutex, MutexGuard, PoisonError};

use whiteboard_ports::{DocumentMoved, DocumentWritten, MaybeSend, WriteObserver};

/// One thing an observer was told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Told {
    Written(DocumentWritten),
    Moved(DocumentMoved),
}

/// A write observer that keeps everything it was told, in order, for a test
/// to read back.
#[derive(Debug, Default)]
pub struct RecordingObserver {
    told: Mutex<Vec<Told>>,
}

impl RecordingObserver {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every write told so far, leaving nothing behind (moves included).
    #[must_use]
    pub fn take(&self) -> Vec<DocumentWritten> {
        self.take_told()
            .into_iter()
            .filter_map(|told| match told {
                Told::Written(written) => Some(written),
                Told::Moved(_) => None,
            })
            .collect()
    }

    /// Everything told so far, writes and moves in the order told, leaving
    /// nothing behind.
    #[must_use]
    pub fn take_told(&self) -> Vec<Told> {
        std::mem::take(&mut *self.locked())
    }

    /// A poisoned list is still a consistent one: a push cannot panic part way.
    fn locked(&self) -> MutexGuard<'_, Vec<Told>> {
        self.told.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl WriteObserver for RecordingObserver {
    fn document_written(&self, written: &DocumentWritten) -> impl Future<Output = ()> + MaybeSend {
        self.locked().push(Told::Written(written.clone()));
        ready(())
    }

    fn document_moved(&self, moved: &DocumentMoved) -> impl Future<Output = ()> + MaybeSend {
        self.locked().push(Told::Moved(moved.clone()));
        ready(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_on;

    fn written(path: &str) -> DocumentWritten {
        DocumentWritten { workspace_id: "w".into(), document_id: "d".into(), path: path.into() }
    }

    fn moved(from: &str, to: &str) -> DocumentMoved {
        DocumentMoved { workspace_id: "w".into(), from: from.into(), to: to.into() }
    }

    #[test]
    fn it_keeps_what_it_was_told_until_taken() {
        let observer = RecordingObserver::new();
        block_on(observer.document_written(&written("a")));
        block_on(observer.document_written(&written("b")));
        assert_eq!(observer.take(), vec![written("a"), written("b")]);
        assert!(observer.take().is_empty());
    }

    #[test]
    fn writes_and_moves_are_kept_in_the_order_told() {
        let observer = RecordingObserver::new();
        block_on(observer.document_written(&written("a")));
        block_on(observer.document_moved(&moved("a", "b")));
        block_on(observer.document_written(&written("b")));
        assert_eq!(
            observer.take_told(),
            vec![
                Told::Written(written("a")),
                Told::Moved(moved("a", "b")),
                Told::Written(written("b"))
            ],
        );
        assert!(observer.take_told().is_empty());
    }

    #[test]
    fn taking_the_writes_leaves_no_move_behind() {
        let observer = RecordingObserver::new();
        block_on(observer.document_moved(&moved("a", "b")));
        block_on(observer.document_written(&written("b")));
        assert_eq!(observer.take(), vec![written("b")]);
        assert!(observer.take_told().is_empty());
    }
}
