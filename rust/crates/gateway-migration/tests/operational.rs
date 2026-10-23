#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_migration::{operational::*, *};
use support::{fixture::*, sqlite_store::*};

#[test]
fn private_native_wire_refuses_unknown_actions_and_repeated_adoption() {
    assert!(
        decode_native_request(br#"{"v":1,"request":{"operation":"refresh_native_owner"}}"#)
            .is_err()
    );
    assert!(decode_native_request(br#"{"v":1,"request":{"operation":"export_native_rollback","now_ms":2300,"artifacts":{},"url":"https://invalid"}}"#).is_err());
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("native-wire.sqlite3"));
    let capture: NativeCapture =
        serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap();
    let make = || NativeMigrationRequest {
        v: 1,
        request: NativeOperation::AdoptNative {
            capture: capture.clone(),
        },
    };
    let response = run(execute_native(&store, make())).unwrap();
    assert!(matches!(response.response, NativeResult::Adopted { .. }));
    assert!(run(execute_native(&store, make())).is_err());
    assert!(
        run(execute_native(
            &store,
            NativeMigrationRequest {
                v: 99,
                request: NativeOperation::AdoptNative { capture }
            }
        ))
        .is_err()
    );
}
