#[cfg(unix)]
fn main() {
    gateway_native::run_native_connector();
}
#[cfg(not(unix))]
fn main() {
    std::process::exit(78);
}
