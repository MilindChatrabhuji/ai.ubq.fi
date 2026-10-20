#[cfg(unix)]
fn main() {
    gateway_native::run_native_supervisor();
}
#[cfg(not(unix))]
fn main() {
    std::process::exit(78);
}
