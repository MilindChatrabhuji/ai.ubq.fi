//! Fixed readonly directory inspector. No CLI/path/command selection is supported.
#[cfg(unix)]
fn main() {
    if gateway_native::existing_account_import::owner_inspector_entry().is_err() {
        std::process::exit(1);
    }
}
#[cfg(not(unix))]
fn main() {
    std::process::exit(1);
}
