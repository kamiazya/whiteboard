use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// Collects each visited operation's row.
struct Rows(Vec<Row>);

impl Visit for Rows {
    fn operation<O: Operation>(&mut self) {
        self.0.push(O::ROW);
    }
}

#[test]
fn the_visited_operations_are_the_rows_in_table_order() {
    let mut visited = Rows(Vec::new());
    each_operation(&mut visited);
    assert_eq!(visited.0, OPERATIONS);
    assert_eq!(OPERATIONS.len(), 2);
}

#[test]
fn no_two_rows_share_a_name_a_tool_or_a_route() {
    for (i, row) in OPERATIONS.iter().enumerate() {
        for other in &OPERATIONS[i + 1..] {
            assert_ne!(row.name, other.name);
            assert!(row.tool.is_none() || row.tool != other.tool, "{}", row.name);
            assert!(row.route.is_none() || row.route != other.route, "{}", row.name);
        }
    }
}

#[test]
fn every_row_is_reached_and_names_the_contracts_of_its_operation() {
    for row in OPERATIONS {
        assert!(row.tool.is_some() || row.route.is_some(), "{} is reached by nothing", row.name);
        assert!(row.tool.is_none_or(|tool| tool.starts_with("wb_")), "{}", row.name);
        assert!(
            row.route
                .is_none_or(|route| route.path.starts_with("/api/v1/workspaces/:workspaceId/")),
            "{}",
            row.name
        );
        assert_eq!(row.input.schema, format!("{}InputSchema", row.name));
        assert_eq!(row.output.schema, format!("{}OutputSchema", row.name));
    }
}
