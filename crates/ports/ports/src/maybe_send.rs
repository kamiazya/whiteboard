//! `Send` and `Sync` where threads exist and nothing where they do not.

/// `Send` natively, so a port's future can cross to another worker thread.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSend: Send {}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + ?Sized> MaybeSend for T {}

/// Nothing on wasm32: the instance is one thread, and the host's promises and
/// handles (`Rc`, a JS value) are not `Send`, so requiring it would exclude
/// every browser implementation of a port.
#[cfg(target_arch = "wasm32")]
pub trait MaybeSend {}

#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> MaybeSend for T {}

/// `Sync` natively, so an operation's future that borrows its ports across an
/// await is `Send`: the future holds `&P`, and `&P` is `Send` only where `P`
/// is `Sync`.
#[cfg(not(target_arch = "wasm32"))]
pub trait MaybeSync: Sync {}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Sync + ?Sized> MaybeSync for T {}

/// Nothing on wasm32, for the reason [`MaybeSend`] asks nothing there.
#[cfg(target_arch = "wasm32")]
pub trait MaybeSync {}

#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> MaybeSync for T {}

#[cfg(test)]
mod tests {
    use super::{MaybeSend, MaybeSync};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn accepts<T: MaybeSend + ?Sized>(_: &T) {}
    fn shares<T: MaybeSync + ?Sized>(_: &T) {}

    #[test]
    fn what_crosses_threads_is_accepted_everywhere() {
        accepts(&1_u8);
        accepts("text");
        accepts(&std::sync::Arc::new(String::new()));
        accepts(&std::future::ready(1));
        shares(&1_u8);
        shares(&std::sync::Mutex::new(String::new()));
    }

    /// Only wasm32 admits a value that is not `Send` or not `Sync`; natively
    /// these lines would not compile, which is what makes the other half of
    /// the contract.
    #[test]
    #[cfg(target_arch = "wasm32")]
    fn a_value_that_is_not_send_or_not_sync_is_accepted_on_wasm32() {
        accepts(&std::rc::Rc::new(1_u8));
        shares(&std::cell::Cell::new(1_u8));
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn send_and_sync_are_what_the_native_bounds_ask_for() {
        fn needs_send<T: Send>(_: &T) {}
        fn through_maybe_send<T: MaybeSend>(value: &T) {
            needs_send(value);
        }
        fn needs_sync<T: Sync>(_: &T) {}
        fn through_maybe_sync<T: MaybeSync>(value: &T) {
            needs_sync(value);
        }
        through_maybe_send(&1_u8);
        through_maybe_sync(&1_u8);
    }
}
