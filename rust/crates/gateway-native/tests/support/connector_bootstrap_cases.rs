//! Named fixture-only probes. No product role, destination or env API.
pub(super) fn nonblocking443() {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    let socket = match Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) {
        Ok(socket) => socket,
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({"stage":"socket","errno":error.raw_os_error(),"kind":format!("{:?}",error.kind())})
            );
            return;
        }
    };
    socket.set_nonblocking(true).unwrap();
    let address = SockAddr::from("127.0.0.1:443".parse::<std::net::SocketAddr>().unwrap());
    let result = socket.connect(&address);
    println!(
        "{}",
        match result {
            Ok(()) =>
                serde_json::json!({"stage":"connect","errno":0,"kind":"Connected","claim":"initial-syscall-only"}),
            Err(error) =>
                serde_json::json!({"stage":"connect","errno":error.raw_os_error(),"kind":format!("{:?}",error.kind()),"claim":"initial-syscall-only"}),
        }
    );
}
