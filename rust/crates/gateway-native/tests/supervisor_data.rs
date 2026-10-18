use gateway_native::{
    redaction,
    supervisor::SourceId,
    supervisor_data::{SupervisorData, SupervisorSourceConfig},
    supervisor_metadata, supervisor_rollout,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "uos-supervisor-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self {
            root: fs::canonicalize(root).unwrap(),
        }
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn database(home: &Path, version: usize) -> PathBuf {
    fs::create_dir_all(home).unwrap();
    let path = home.join(format!("state_{version}.sqlite"));
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE threads(id TEXT,title TEXT,name TEXT,preview TEXT,cwd TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,git_branch TEXT,updated_at INTEGER,updated_at_ms INTEGER,archived INTEGER,thread_source TEXT,source TEXT)").unwrap();
    db.execute("INSERT INTO threads VALUES (?1,'metadata title',NULL,'metadata preview','/fixture/work','metadata-model','low',42,'fixture-branch',1700000000,NULL,0,'cli',NULL)",params!["thread-a"]).unwrap();
    drop(db);
    path
}
struct Server {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
    methods: Arc<Mutex<Vec<String>>>,
    lists: Arc<AtomicUsize>,
}
impl Server {
    fn start(path: PathBuf, rollout: Option<PathBuf>) -> Self {
        Self::start_with_full_failure(path, rollout, false)
    }
    fn start_with_full_failure(path: PathBuf, rollout: Option<PathBuf>, fail_full: bool) -> Self {
        let listener = UnixListener::bind(&path).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let methods = Arc::new(Mutex::new(Vec::new()));
        let record = methods.clone();
        let lists = Arc::new(AtomicUsize::new(0));
        let list_count = lists.clone();
        let join = thread::spawn(move || {
            let mut connections = Vec::new();
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    break;
                };
                if worker_stop.load(Ordering::Relaxed) {
                    break;
                }
                let record = record.clone();
                let list_count = list_count.clone();
                let rollout = rollout.clone();
                connections.push(thread::spawn(move||{stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();let Ok(mut socket)=tungstenite::accept(stream)else{return;};while let Ok(message)=socket.read(){if message.is_close(){let _=socket.flush();break;}let Ok(value)=serde_json::from_slice::<Value>(&message.into_data())else{continue;};let Some(method)=value["method"].as_str()else{continue;};record.lock().unwrap().push(method.into());let Some(id)=value.get("id")else{continue;};if fail_full && method=="thread/turns/list" && value["params"]["itemsView"]=="full" {let oversized="x".repeat(1_048_577);let _=socket.send(tungstenite::Message::Text(oversized.into()));break;}let result=match method {
      "initialize"=>json!({"protocolVersion":1}),"thread/loaded/list"=>json!({"data":["thread-a"]}),
      "thread/list"=>{list_count.fetch_add(1,Ordering::Relaxed);json!({"data":[{"id":"thread-a","name":"password=ZQ_SYNTHETIC_VALUE_12345","model":"live-model","reasoningEffort":"high","source":"cli","updatedAt":1700000001000i64}],"nextCursor":null})},
      "thread/read"=>json!({"thread":{"id":"thread-a","name":"password=ZQ_SYNTHETIC_VALUE_12345","model":"live-model","reasoningEffort":"high","status":{"type":"active","activeFlags":["needsInput"]},"updatedAt":1700000002000i64,"path":rollout}}),
      "thread/turns/list"=>{if value["params"]["itemsView"]=="full" {json!({"data":[{"id":"turn-a","status":"inProgress","startedAt":1700000000,"items":[{"type":"userMessage","content":[{"type":"text","text":"Fix the synthetic fixture"}]},{"type":"agentMessage","id":"message-a","text":"password:\"zqfirst"},{"type":"commandExecution","id":"command-a","command":"echo fixture","status":"completed","exitCode":0,"aggregatedOutput":"zqsecond\" done"},{"type":"reasoning","text":"zqPRIVATE_REASONING"}]}]})}else{json!({"data":[{"id":"turn-a","status":"inProgress","startedAt":1700000000,"items":[]}]})}},
      "account/rateLimits/read"=>json!({"rateLimits":{"usedPercent":35,"windowDurationMins":300,"resetsAt":1700000100}}),_=>panic!("Unexpected non-read method: {method}")};
      if socket.send(tungstenite::Message::Text(json!({"id":id,"result":result}).to_string().into())).is_err(){break;}
    }}));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            path,
            stop,
            join: Some(join),
            methods,
            lists,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = UnixStream::connect(&self.path);
        if let Some(join) = self.join.take() {
            join.join().unwrap();
        }
    }
}
#[test]
fn real_readonly_sqlite_and_missing_corrupt_schema_cases_are_bounded() {
    let fixture = Fixture::new();
    let home = fixture.home();
    let old = database(&home, 2);
    let selected = database(&home, 12);
    let before = fs::read(&selected).unwrap();
    let files = fs::read_dir(&home)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(
        supervisor_metadata::find_state_database(&home),
        Some(selected.clone())
    );
    let result = supervisor_metadata::read_metadata(&home, Some(&["thread-a".into()]));
    assert!(result.reason.is_none());
    assert_eq!(result.rows["thread-a"].tokens_used, Some(json!(42)));
    assert_eq!(result.rows["thread-a"].archived, None);
    let injected = supervisor_metadata::read_metadata(
        &home,
        Some(&["thread-a'); DROP TABLE threads; --".into()]),
    );
    assert!(injected.rows.is_empty());
    assert!(injected.reason.is_none());
    assert_eq!(before, fs::read(&selected).unwrap());
    assert_eq!(
        files,
        fs::read_dir(&home)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<Vec<_>>()
    );
    let blocker = Connection::open(&selected).unwrap();
    blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(
        supervisor_metadata::read_metadata(&home, None)
            .reason
            .is_some()
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    drop(blocker);
    fs::write(home.join("state_13.sqlite"), b"not a database").unwrap();
    assert!(
        supervisor_metadata::read_metadata(&home, None)
            .reason
            .is_some()
    );
    fs::remove_file(home.join("state_13.sqlite")).unwrap();
    let schema = Connection::open(home.join("state_14.sqlite")).unwrap();
    schema
        .execute_batch("CREATE TABLE threads(id TEXT)")
        .unwrap();
    drop(schema);
    assert_eq!(
        supervisor_metadata::read_metadata(&home, None)
            .reason
            .as_deref(),
        Some("state database query failed")
    );
    assert_eq!(
        supervisor_metadata::read_metadata(&fixture.root.join("missing"), None)
            .reason
            .as_deref(),
        Some("state database not found")
    );
    assert!(old.exists());
}
#[test]
fn actual_uds_inventory_selection_cache_brief_and_rollout_are_read_only() {
    let fixture = Fixture::new();
    let home = fixture.home();
    let db = database(&home, 12);
    let before = fs::read(&db).unwrap();
    fs::create_dir(home.join("sessions")).unwrap();
    let rollout = home.join("sessions/rollout-thread-a.jsonl");
    fs::write(&rollout,[json!({"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"analysis","content":[{"type":"output_text","text":"zqPRIVATE_ROLLOUT"}]}}).to_string(),json!({"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Fresh visible rollout result"}]}}).to_string()].join("\n")).unwrap();
    let socket = fixture.root.join("source.sock");
    let server = Server::start(socket.clone(), Some(rollout.clone()));
    let config = SupervisorSourceConfig::configured(
        SourceId::parse("fixture").unwrap(),
        "Fixture Machine".into(),
        socket,
        Some(home.clone()),
    )
    .unwrap();
    let data = Arc::new(
        SupervisorData::configured(vec![config])
            .unwrap()
            .with_metadata(Some("fixture-host".into()), vec![]),
    );
    let snapshots = thread::scope(|scope| {
        let tasks = (0..4)
            .map(|_| {
                let data = &data;
                scope.spawn(move || data.snapshot(1700000000000).unwrap())
            })
            .collect::<Vec<_>>();
        tasks
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(snapshots.windows(2).all(|v| v[0] == v[1]));
    assert_eq!(server.lists.load(Ordering::Relaxed), 1);
    let snapshot = &snapshots[0];
    assert_eq!(snapshot["counts"]["active"], 1);
    assert_eq!(snapshot["sessions"][0]["model"], "live-model");
    assert_eq!(snapshot["sessions"][0]["tokensUsed"], 42);
    assert!(!snapshot.to_string().contains("ZQ_SYNTHETIC_VALUE"));
    assert_eq!(
        data.select("fixture", "not-listed", 1700000000000)
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        data.select("fixture", "../private", 1700000000000)
            .unwrap_err()
            .status,
        400
    );
    let selected = data.select("fixture", "thread-a", 1700000000000).unwrap();
    assert_eq!(
        selected.sampled_at_ms(),
        snapshot["sampledAtMs"].as_i64().unwrap()
    );
    let context = data.brief_context(&selected, 1700000000000).unwrap();
    assert!(context.transcript_available);
    assert_eq!(context.state.as_deref(), Some("active"));
    assert_eq!(context.title.as_deref(), Some("[redacted]"));
    assert!(context.rollout_tail_events > 0);
    let mut actual = serde_json::to_value(&context).unwrap();
    actual["rolloutPath"] = json!("/fixture/home/sessions/rollout-thread-a.jsonl");
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/supervisor-source-golden.json")).unwrap();
    assert_eq!(actual, golden["collection"]["expected"]);
    let wire = serde_json::to_string(&context).unwrap();
    assert!(!wire.contains("zqfirst") && !wire.contains("zqsecond") && !wire.contains("zqPRIVATE"));
    assert!(wire.contains("Fresh visible rollout result"));
    assert_eq!(before, fs::read(&db).unwrap());
    assert_eq!(
        gateway_native::SupervisorMethod::parse("turn/start")
            .unwrap_err()
            .status,
        403
    );
    let methods = server.methods.lock().unwrap();
    assert!(methods.iter().all(|m| matches!(
        m.as_str(),
        "initialize"
            | "initialized"
            | "thread/list"
            | "thread/loaded/list"
            | "thread/read"
            | "thread/turns/list"
            | "account/rateLimits/read"
    )));
    drop(methods);
    let outside = fixture.root.join("outside-thread-a.jsonl");
    fs::write(&outside, b"outside").unwrap();
    let escape = home.join("sessions/link-thread-a.jsonl");
    std::os::unix::fs::symlink(&outside, &escape).unwrap();
    assert!(
        supervisor_rollout::read_rollout_tail(
            Some(&home),
            selected.known_thread(),
            escape.to_str()
        )
        .is_empty()
    );
    assert!(
        supervisor_rollout::read_rollout_tail(
            Some(&home),
            selected.known_thread(),
            outside.to_str()
        )
        .is_empty()
    );
    assert!(
        supervisor_rollout::read_rollout_tail(
            Some(&home),
            selected.known_thread(),
            Some("/tmp/../private-thread-a")
        )
        .is_empty()
    );
}
#[test]
fn raw_follow_redaction_precedes_clipping_and_preserves_indices() {
    let items = json!([{"type":"userMessage","text":"private user ignored"},{"type":"agentMessage","id":"m","text":format!("{}password:\"zqfirst","x".repeat(3990))},{"type":"commandExecution","id":"c","command":"zqsecond\"","aggregatedOutput":"token=ZQ_SYNTHETIC_CREDENTIAL_12345","status":"completed"}]);
    let clean = redaction::sanitize_follow_items(&items);
    assert_eq!(clean[1]["id"], "m");
    assert_eq!(clean[2]["status"], "completed");
    assert!(
        !clean.to_string().contains("zqfirst")
            && !clean.to_string().contains("zqsecond")
            && !clean.to_string().contains("ZQ_SYNTHETIC_CREDENTIAL")
    );
    let entries = gateway_native::supervisor::extract_follow("turn", &clean);
    assert_eq!(entries[0].index, 1);
    assert_eq!(entries[1].index, 2);
    assert!(entries[0].text.encode_utf16().count() <= 4000);
}

#[test]
fn failed_full_frame_degrades_to_recorded_summary_without_inventing_transcript() {
    let fixture = Fixture::new();
    let path = fixture.root.join("source.sock");
    let _server = Server::start_with_full_failure(path.clone(), None, true);
    let source = SupervisorSourceConfig::configured(
        SourceId::parse("fixture").unwrap(),
        "Fixture Machine".into(),
        path,
        None,
    )
    .unwrap();
    let data = SupervisorData::configured(vec![source]).unwrap();
    let selected = data
        .select("fixture", "thread-a", 1_700_000_000_000)
        .unwrap();
    let context = data.brief_context(&selected, 1_700_000_000_000).unwrap();
    assert_eq!(context.state.as_deref(), Some("active"));
    assert!(!context.transcript_available);
    assert!(context.turns.is_empty());
    assert_eq!(context.title.as_deref(), Some("[redacted]"));
}
