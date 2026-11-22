//! `Send` where threads exist and nothing where they do not.

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

#[cfg(test)]
mod tests {
    use super::MaybeSend;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn accepts<T: MaybeSend + ?Sized>(_: &T) {}

    #[test]
    fn what_crosses_threads_is_accepted_everywhere() {
        accepts(&1_u8);
        accepts("text");
        accepts(&std::sync::Arc::new(String::new()));
        accepts(&std::future::ready(1));
    }

    /// Only wasm32 admits a value that is not `Send`; natively this line would
    /// not compile, which is what makes the other half of the contract.
    #[test]
    #[cfg(target_arch = "wasm32")]
    fn a_value_that_is_not_send_is_accepted_on_wasm32() {
        accepts(&std::rc::Rc::new(1_u8));
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn send_is_what_the_native_bound_asks_for() {
        fn needs_send<T: Send>(_: &T) {}
        fn through_maybe_send<T: MaybeSend>(value: &T) {
            needs_send(value);
        }
        through_maybe_send(&1_u8);
    }
}
