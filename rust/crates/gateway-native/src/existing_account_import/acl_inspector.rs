//! Anchored Darwin metadata observation. No parent chdir or caller command/path protocol.
#[cfg(target_os = "macos")]
use super::exclusive_owner::Facts;
use super::exclusive_owner::{PinnedExecutable, fail};
use gateway_core::GatewayError;
use std::{fs::File, time::Instant};
#[cfg(target_os = "macos")]
use std::{
    io::Read,
    os::{
        fd::AsFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Child, Command, Stdio},
    time::Duration,
};
#[cfg(target_os = "macos")]
const LS_SHA256S: [&str; 2] = [
    "a1cb6fd856f9414ada4cc9682f137c343261d777b8374df1abac7a931fb66f7a",
    "24752389e1d97c9555dd153b644902fadd460dfbe1a166251876c67bbacb0810",
];
#[cfg(target_os = "macos")]
const OUTPUT_LIMIT: usize = 1024;
#[cfg(target_os = "macos")]
const HEADER_LIMIT: usize = 256;

/// The sole parameterless helper entry. stdin must already be an anchored directory.
pub fn entry() -> Result<(), GatewayError> {
    if std::env::args_os().len() != 1 {
        return Err(fail());
    }
    #[cfg(target_os = "macos")]
    {
        // Each reviewed identity still goes through the complete descriptor,
        // NOFOLLOW, metadata and exact-hash verifier; no host/version input grants trust.
        let tool = LS_SHA256S
            .iter()
            .find_map(|digest| {
                PinnedExecutable::verify(std::path::Path::new("/bin/ls"), digest).ok()
            })
            .ok_or_else(fail)?;
        if tool.facts.uid != 0 {
            return Err(fail());
        }
        rustix::process::fchdir(std::io::stdin().as_fd()).map_err(|_| fail())?;
        tool.recheck()?;
        let error = Command::new(tool.path())
            .args(["-d", "-l", "-n", "-e", "."])
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env("TZ", "UTC")
            .stdin(Stdio::null())
            .exec();
        let _ = error;
        Err(fail())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(fail())
    }
}

pub(super) fn observe(
    directory: &File,
    inspector: &PinnedExecutable,
    deadline: Instant,
) -> Result<(), GatewayError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (directory, inspector, deadline);
        Err(fail())
    }
    #[cfg(target_os = "macos")]
    {
        let before = Facts::read(directory)?;
        inspector.recheck()?;
        let (mut out, child_out) = UnixStream::pair().map_err(|_| fail())?;
        let (mut err, child_err) = UnixStream::pair().map_err(|_| fail())?;
        out.set_nonblocking(true).map_err(|_| fail())?;
        err.set_nonblocking(true).map_err(|_| fail())?;
        let stdin = directory.as_fd().try_clone_to_owned().map_err(|_| fail())?;
        let mut child = Command::new(inspector.path())
            .env_clear()
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env("TZ", "UTC")
            .stdin(Stdio::from(stdin))
            .stdout(Stdio::from(std::os::fd::OwnedFd::from(child_out)))
            .stderr(Stdio::from(std::os::fd::OwnedFd::from(child_err)))
            .spawn()
            .map_err(|_| fail())?;
        let result = capture(&mut child, &mut out, &mut err, deadline);
        if result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let stdout = result?;
        inspector.recheck()?;
        if Facts::read(directory)? != before {
            return Err(fail());
        }
        parse(&stdout, &before)
    }
}
#[cfg(target_os = "macos")]
fn drain(stream: &mut UnixStream, bytes: &mut Vec<u8>) -> Result<bool, GatewayError> {
    let mut chunk = [0u8; 256];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > OUTPUT_LIMIT {
                    return Err(fail());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => (),
            Err(_) => return Err(fail()),
        }
    }
}
#[cfg(target_os = "macos")]
fn capture(
    child: &mut Child,
    out: &mut UnixStream,
    err: &mut UnixStream,
    deadline: Instant,
) -> Result<Vec<u8>, GatewayError> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        let out_done = drain(out, &mut stdout)?;
        let err_done = drain(err, &mut stderr)?;
        if let Some(status) = child.try_wait().map_err(|_| fail())?
            && out_done
            && err_done
        {
            if !status.success() || !stderr.is_empty() {
                return Err(fail());
            }
            return Ok(stdout);
        }
        if Instant::now() >= deadline {
            return Err(fail());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[cfg(target_os = "macos")]
fn number(text: &str) -> Result<u64, GatewayError> {
    if text.is_empty()
        || text.len() > 20
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(fail());
    }
    text.parse().map_err(|_| fail())
}
#[cfg(target_os = "macos")]
fn permissions(mode: u32) -> String {
    let mut output = String::from("d");
    for shift in [6, 3, 0] {
        output.push(if mode & (4 << shift) != 0 { 'r' } else { '-' });
        output.push(if mode & (2 << shift) != 0 { 'w' } else { '-' });
        output.push(match (mode & (1 << shift) != 0, shift) {
            (true, 6) if mode & 0o4000 != 0 => 's',
            (false, 6) if mode & 0o4000 != 0 => 'S',
            (true, 3) if mode & 0o2000 != 0 => 's',
            (false, 3) if mode & 0o2000 != 0 => 'S',
            (true, 0) if mode & 0o1000 != 0 => 't',
            (false, 0) if mode & 0o1000 != 0 => 'T',
            (true, _) => 'x',
            (false, _) => '-',
        });
    }
    output
}
/// Every byte is consumed. xattr '@' is accepted only with NO subsequent ACE/output line.
#[cfg(target_os = "macos")]
pub(super) fn parse(output: &[u8], facts: &Facts) -> Result<(), GatewayError> {
    if output.len() > HEADER_LIMIT
        || output.first() != Some(&b'd')
        || output.len() < 2
        || output.get(output.len().saturating_sub(2)) != Some(&b'.')
        || output.last() != Some(&b'\n')
        || output[..output.len().saturating_sub(1)]
            .iter()
            .any(|b| !matches!(*b, 0x20..=0x7e))
    {
        return Err(fail());
    }
    let text = std::str::from_utf8(output).map_err(|_| fail())?;
    let fields = text
        .trim_end_matches('\n')
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    if fields.len() != 9
        || fields[8] != "."
        || !(fields[0] == permissions(facts.mode)
            || fields[0] == format!("{}@", permissions(facts.mode)))
        || number(fields[1])? != facts.links
        || number(fields[2])? != u64::from(facts.uid)
        || number(fields[3])? != u64::from(facts.gid)
        || number(fields[4])? != facts.size
        || ![
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ]
        .contains(&fields[5])
        || !(1..=31).contains(&number(fields[6])?)
    {
        return Err(fail());
    }
    let stamp = fields[7];
    if let Some((hour, minute)) = stamp.split_once(':') {
        if hour.len() != 2
            || minute.len() != 2
            || !hour.bytes().all(|b| b.is_ascii_digit())
            || !minute.bytes().all(|b| b.is_ascii_digit())
            || hour.parse::<u8>().map_err(|_| fail())? > 23
            || minute.parse::<u8>().map_err(|_| fail())? > 59
        {
            return Err(fail());
        }
    } else if !(1..=9999).contains(&number(stamp)?) {
        return Err(fail());
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod pin_tests {
    use super::LS_SHA256S;
    #[test]
    fn only_two_exact_reviewed_readonly_os_tool_digests_are_eligible() {
        let local = "a1cb6fd856f9414ada4cc9682f137c343261d777b8374df1abac7a931fb66f7a";
        let hosted = "24752389e1d97c9555dd153b644902fadd460dfbe1a166251876c67bbacb0810";
        assert_eq!(LS_SHA256S, [local, hosted]);
        let accepts = |digest: &str| LS_SHA256S.contains(&digest);
        assert!(accepts(local));
        assert!(accepts(hosted));
        let mut one_byte_wrong = hosted.to_owned();
        one_byte_wrong.replace_range(63..64, "1");
        assert!(!accepts(&one_byte_wrong));
        assert!(!accepts(
            "3be943172b502b245545fbfd57706c210fabb9ee058829c5bf00c3f67c8fb474"
        ));
        assert!(!accepts(&hosted[..63]));
        assert!(!accepts(&format!("{hosted}0")));
        assert!(!accepts(&hosted.to_ascii_uppercase()));
        assert!(!accepts(&format!(" {hosted}")));
    }
}
