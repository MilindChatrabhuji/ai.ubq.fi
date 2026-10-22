//! Local-only operator: private stdin to private stdout, no provider/network or
//! database writes. Full source credentials never leave this native process.
#[cfg(all(unix, not(target_arch = "wasm32")))]
fn main() {
    if execute().is_err() {
        eprintln!("Private native bootstrap refused; no candidate was emitted");
        std::process::exit(78);
    }
}
#[cfg(all(unix, not(target_arch = "wasm32")))]
fn execute() -> Result<(), Box<dyn std::error::Error>> {
    use gateway_auth::native_credentials::OwnerFence;
    use gateway_migration::native_operator::{NativeCustodyRegistration, prepare_local_bootstrap};
    use std::io::{Read, Write};
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Registration {
        home: std::path::PathBuf,
        fence: OwnerFence,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        v: u32,
        capture: Option<gateway_migration::NativeCapture>,
        capture_file: Option<std::path::PathBuf>,
        registrations: Vec<Registration>,
        #[serde(default)]
        staged: bool,
    }
    let maximum = gateway_migration::operational::PRIVATE_WIRE_MAX_BYTES;
    if std::env::args_os().len() != 1 {
        return Err("No command arguments are accepted".into());
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take((maximum + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err("Private operator input exceeds bound".into());
    }
    // Deserialize original bytes, never through serde_json::Value.
    let input: Input = serde_json::from_slice(&bytes)?;
    if input.v != 1 {
        return Err("Unsupported private operator input".into());
    }
    let registrations = input
        .registrations
        .into_iter()
        .map(|r| NativeCustodyRegistration::existing(r.home, r.fence))
        .collect::<Result<Vec<_>, _>>()?;
    if input.staged && input.capture.is_none() {
        let path = input
            .capture_file
            .as_ref()
            .ok_or("Expected exactly one private capture input")?;
        let directory = gateway_migration::native_stage::directory(
            path.parent().ok_or("Missing stopped-file parent")?,
        )?;
        let mut plan = run(
            gateway_migration::native_operator::prepare_local_stage_file(
                path,
                &directory,
                registrations,
            ),
        )?;
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &plan.begin())?;
        output.write_all(b"\n")?;
        while plan.write_next_batch(&mut output)? {
            output.write_all(b"\n")?;
        }
        serde_json::to_writer(&mut output, &plan.seal())?;
        output.write_all(b"\n")?;
        return Ok(());
    }
    let capture = match (input.capture, input.capture_file, input.staged) {
        (Some(capture), None, _) => capture,
        (None, Some(path), true) => {
            use std::os::unix::fs::MetadataExt;
            let before = std::fs::symlink_metadata(&path)?;
            if !path.is_absolute() || !before.is_file() || before.mode() & 0o077 != 0 {
                return Err("Private native capture file is not owner-only/regular".into());
            }
            let file = std::fs::File::open(&path)?;
            let opened = file.metadata()?;
            if opened.dev() != before.dev()
                || opened.ino() != before.ino()
                || opened.uid() != before.uid()
            {
                return Err("Private native capture file changed before read".into());
            }
            serde_json::from_reader(std::io::BufReader::new(file))?
        }
        _ => return Err("Expected exactly one private capture input".into()),
    };
    if input.staged {
        let mut plan = run(gateway_migration::native_operator::prepare_local_stage(
            capture,
            registrations,
        ))?;
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &plan.begin())?;
        output.write_all(b"\n")?;
        while plan.write_next_batch(&mut output)? {
            output.write_all(b"\n")?;
        }
        serde_json::to_writer(&mut output, &plan.seal())?;
        output.write_all(b"\n")?;
        return Ok(());
    }
    let candidate = run(prepare_local_bootstrap(&capture, registrations))?;
    let output = serde_json::to_vec(&candidate)?;
    if output.len() > maximum {
        return Err("Private candidate exceeds bound".into());
    }
    // The operator must connect this stream directly to a private file/pipe.
    // It contains access projection DATA and is never a diagnostic/log stream.
    std::io::stdout().lock().write_all(&output)?;
    Ok(())
}
#[cfg(all(unix, not(target_arch = "wasm32")))]
fn run<F: std::future::Future>(future: F) -> F::Output {
    use std::{
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };
    struct Current(std::thread::Thread);
    impl Wake for Current {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Current(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}
#[cfg(not(all(unix, not(target_arch = "wasm32"))))]
fn main() {
    panic!("Private local bootstrap requires a native Unix operator");
}
