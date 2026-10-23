//! Private offline driver; no command arguments, dotenv, network or live-store discovery.
#[cfg(all(unix, not(target_arch = "wasm32")))]
mod driver;
#[cfg(all(unix, not(target_arch = "wasm32")))]
mod store;

#[cfg(all(unix, not(target_arch = "wasm32")))]
fn main() {
    use std::io::{Read, Write};
    let execute = || -> Result<(), Box<dyn std::error::Error>> {
        if std::env::args_os().len() != 1 {
            return Err("No command arguments accepted".into());
        }
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .take(65_537)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 65_536 {
            return Err("Private operator input exceeds bound".into());
        }
        let input = serde_json::from_slice(&bytes)?;
        let receipt = driver::execute(input)?;
        serde_json::to_writer(std::io::stdout().lock(), &receipt)?;
        std::io::stdout().lock().write_all(b"\n")?;
        Ok(())
    };
    if execute().is_err() {
        eprintln!("Private copied-store inverse refused; no success receipt");
        std::process::exit(78);
    }
}

#[cfg(not(all(unix, not(target_arch = "wasm32"))))]
fn main() {
    panic!("Private copied-store inverse requires native Unix")
}
