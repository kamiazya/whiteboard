//! A function over the 50-line budget, whose body holds every brace a lexer
//! must not count: in a string, a raw string, a char and a comment.

pub struct Board;

impl Board {
    pub fn tall(&self) -> u32 {
        let mut total = 0;
        let _open = "{";
        let _raw = r#"{ "{" }"#;
        let _close = '}';
        // }
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total += 1;
        total
    }

    pub fn short(&self) -> impl Iterator<Item = u32> {
        [1, 2].into_iter()
    }
}

pub trait Measure {
    fn declared(&self) -> u32;

    fn defaulted(&self) -> u32 {
        0
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn short() {
        let f: fn(u32) -> u32 = |x| x;
        assert_eq!(f(1), 1);
    }
}
