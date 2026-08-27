//! Sidecar relay: owns every `omp --mode rpc-ui` child process and pipes their
//! newline-delimited JSON to the webview.
//!
//! Rust deliberately understands NOTHING about the RPC protocol — it moves
//! bytes and manages process lifetime. All framing semantics (request/response
//! correlation, event dispatch) live in `src/rpc/bridge.ts`.
//!
//! Two measurements drove this design (see the plan's Fase 0):
//!   * a sidecar takes ~3.8s to emit its `ready` frame
//!   * a sidecar costs ~285 MB RSS while idle
//!
//! So sessions are pooled rather than one-per-tab-forever: at most
//! `MAX_LIVE_SESSIONS` run at once, the least-recently-used is evicted to make
//! room, and one spare is kept pre-warmed so opening a tab is instant instead
//! of a four-second stall.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::Receiver;
use tauri::ipc::Channel;
use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// BASENAME only. `bundle.externalBin` says "binaries/omp", but tauri-build
/// copies the binary FLAT next to the app exe and `sidecar()` joins exe_dir
/// with exactly what you pass — `sidecar("binaries/omp")` is a runtime ENOENT.
const SIDECAR_NAME: &str = "omp";
const SIDECAR_ARGS: [&str; 2] = ["--mode", "rpc-ui"];

/// Live sidecars allowed at once. At ~285 MB each this is the RAM ceiling:
/// three is ~850 MB, which is the most we are willing to spend. Tabs beyond
/// this stay open in the UI but their process is evicted; selecting one
/// respawns it and replays the transcript via `switch_session`.
const MAX_LIVE_SESSIONS: usize = 3;

/// Keep one spare process warm so opening a tab does not pay the ~3.8s spawn.
/// Costs one idle runtime; disable by setting to false.
const PREWARM_ENABLED: bool = true;

/// One frame of coalescing. React cannot paint faster than this, and it
/// collapses hundreds of channel round-trips per second into ~120.
const COALESCE: Duration = Duration::from_millis(8);

/// Stay under the ~8 KiB inline-eval threshold; above it the payload is parked
/// and the webview needs an extra round trip to fetch it.
const MAX_BATCH_BYTES: usize = 6 * 1024;

/// Defensive cap so a child that never emits a newline cannot OOM us.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Frames buffered for a pre-warmed child before a tab adopts it. The `ready`
/// frame plus startup chatter is a handful of lines; this is pure headroom.
const MAX_BUFFERED_EVENTS: usize = 512;

/// Ask the plugin for unframed chunks and do our own line splitting. The
/// plugin's framed mode is ambiguous about whether the delimiter is retained,
/// and both readings produce subtly broken code. Framing it ourselves removes
/// the question from the critical path.
const RAW_OUT: bool = true;

/// Label used for a pre-warmed child that no tab has claimed yet.
const PREWARM_LABEL: &str = "__prewarm__";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// `rename_all` renames VARIANTS; `rename_all_fields` (serde >= 1.0.181)
/// renames struct-variant FIELDS. Omitting the second makes the TS types
/// silently disagree with the wire format on every field.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum AgentEvent {
	Frames {
		tab_id: String,
		lines: Vec<String>,
	},
	Stderr {
		tab_id: String,
		lines: Vec<String>,
	},
	Fault {
		tab_id: String,
		message: String,
	},
	Exited {
		tab_id: String,
		code: Option<i32>,
		signal: Option<i32>,
	},
	/// The pool reclaimed this session's process to stay under
	/// `MAX_LIVE_SESSIONS`. Distinct from `Exited` on purpose: eviction is our
	/// decision and the normal cost of keeping many sessions open, so the UI
	/// must not report it as a crash. An `Exited` follows and is expected.
	Evicted {
		tab_id: String,
	},
}

impl AgentEvent {
	/// Re-key an event when a pre-warmed child is adopted by a real tab.
	fn retag(&mut self, next: &str) {
		let tab_id = match self {
			AgentEvent::Frames { tab_id, .. }
			| AgentEvent::Stderr { tab_id, .. }
			| AgentEvent::Fault { tab_id, .. }
			| AgentEvent::Exited { tab_id, .. }
			| AgentEvent::Evicted { tab_id } => tab_id,
		};
		tab_id.clear();
		tab_id.push_str(next);
	}
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentHandle {
	pid: u32,
	/// true when an existing session was re-attached rather than spawned.
	/// StrictMode's double-mount and an HMR reload both land here.
	resumed: bool,
	/// true when a pre-warmed process was adopted, so the caller knows the
	/// ~3.8s spawn was skipped.
	prewarmed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PoolStatus {
	live: usize,
	max_live: usize,
	prewarm_ready: bool,
	tabs: Vec<String>,
}

// ---------------------------------------------------------------------------
// Sink — where a pump's output goes
// ---------------------------------------------------------------------------

/// A pre-warmed child produces output (notably its `ready` frame) before any
/// tab owns it, so the pump starts in `Buffering` and is promoted to `Live`
/// on adoption. The same swap re-points a tab's stream at a fresh Channel
/// after a webview reload orphans the old callback id.
enum SinkState {
	Buffering(Vec<AgentEvent>),
	Live(Channel<AgentEvent>),
}

struct SinkInner {
	tab_id: String,
	state: SinkState,
}

type Sink = Arc<Mutex<SinkInner>>;

fn new_buffering_sink(tab_id: &str) -> Sink {
	Arc::new(Mutex::new(SinkInner {
		tab_id: tab_id.to_owned(),
		state: SinkState::Buffering(Vec::new()),
	}))
}

/// Promote a sink to `Live`, re-tagging and flushing anything buffered.
fn adopt(sink: &Sink, tab_id: &str, channel: Channel<AgentEvent>) -> Result<(), String> {
	let mut guard = sink.lock().map_err(|_| "sink mutex poisoned")?;
	guard.tab_id = tab_id.to_owned();
	let previous = std::mem::replace(&mut guard.state, SinkState::Live(channel));
	if let (SinkState::Buffering(pending), SinkState::Live(channel)) = (previous, &guard.state) {
		for mut event in pending {
			event.retag(tab_id);
			let _ = channel.send(event);
		}
	}
	Ok(())
}

fn send(sink: &Sink, mut event: AgentEvent) {
	let Ok(mut guard) = sink.lock() else { return };
	let tab_id = guard.tab_id.clone();
	event.retag(&tab_id);
	match &mut guard.state {
		SinkState::Live(channel) => {
			let _ = channel.send(event);
		},
		SinkState::Buffering(pending) => {
			if pending.len() < MAX_BUFFERED_EVENTS {
				pending.push(event);
			}
		},
	}
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Session {
	child: CommandChild,
	pid: u32,
	sink: Sink,
	/// Drives LRU eviction when the pool is at capacity.
	last_active: Instant,
}

struct Prewarmed {
	child: CommandChild,
	pid: u32,
	sink: Sink,
}

#[derive(Default)]
struct Pool {
	sessions: HashMap<String, Session>,
	prewarm: Option<Prewarmed>,
}

#[derive(Default)]
struct Sessions(Mutex<Pool>);

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

#[derive(Default)]
struct LineAssembler {
	buf: Vec<u8>,
	/// True while the tail of an over-long frame is still arriving.
	discarding: bool,
}

impl LineAssembler {
	/// Split `chunk` into complete lines, delimiters stripped, empties dropped.
	///
	/// `flush_tail = false` (raw mode): an unterminated tail is carried over.
	/// `flush_tail = true` (framed mode): the tail is emitted immediately,
	///   correct because the plugin only ends a chunk on a line boundary.
	fn push(&mut self, chunk: &[u8], flush_tail: bool, out: &mut Vec<String>) {
		self.buf.extend_from_slice(chunk);
		while let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
			let mut line: Vec<u8> = self.buf.drain(..=i).collect();
			line.pop(); // '\n'
			if self.discarding {
				// The remainder of the frame we gave up on. Its end is this newline.
				self.discarding = false;
				continue;
			}
			Self::emit(line, out);
		}
		if self.buf.len() > MAX_LINE_BYTES {
			// Runaway line: drop it rather than grow forever — but remember that we
			// are mid-discard. Clearing alone left the *tail* of the same frame in
			// the buffer, and the next newline shipped it upward as if it were a
			// complete line: a fragment of JSON delivered as a whole one.
			self.buf.clear();
			self.discarding = true;
		}
		if flush_tail {
			self.flush(out);
		}
	}

	fn flush(&mut self, out: &mut Vec<String>) {
		if self.discarding {
			// Never completed, so there is no line here — only the tail of one we
			// already refused.
			self.buf.clear();
			self.discarding = false;
			return;
		}
		if self.buf.is_empty() {
			return;
		}
		Self::emit(std::mem::take(&mut self.buf), out);
	}

	fn emit(mut line: Vec<u8>, out: &mut Vec<String>) {
		if line.last() == Some(&b'\r') {
			line.pop();
		}
		if line.is_empty() {
			return;
		}
		out.push(String::from_utf8_lossy(&line).into_owned());
	}
}

// ---------------------------------------------------------------------------
// Pump
// ---------------------------------------------------------------------------

fn flush_batch(sink: &Sink, batch: &mut Vec<String>, bytes: &mut usize) {
	if batch.is_empty() {
		return;
	}
	*bytes = 0;
	send(
		sink,
		AgentEvent::Frames {
			tab_id: String::new(), // retagged inside `send`
			lines: std::mem::take(batch),
		},
	);
}

/// The plugin's event channel has capacity ONE and its pipe readers
/// `block_on(tx.send(..))`. That is useful backpressure onto the child's
/// stdout, but it also means anything slow here stalls the child. Keep it
/// tight: no locks held across await, no I/O.
async fn pump(app: AppHandle, sink: Sink, mut rx: Receiver<CommandEvent>) {
	let mut out_asm = LineAssembler::default();
	let mut err_asm = LineAssembler::default();
	let mut lines: Vec<String> = Vec::new();
	let mut batch: Vec<String> = Vec::new();
	let mut bytes = 0usize;

	let mut tick = tokio::time::interval(COALESCE);
	tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

	loop {
		tokio::select! {
			 biased; // always drain the child before firing the timer

			 event = rx.recv() => match event {
				  Some(CommandEvent::Stdout(chunk)) => {
						lines.clear();
						out_asm.push(&chunk, !RAW_OUT, &mut lines);
						for line in lines.drain(..) {
							 bytes += line.len() + 4; // + JSON quoting/comma overhead
							 batch.push(line);
							 if bytes >= MAX_BATCH_BYTES {
								  flush_batch(&sink, &mut batch, &mut bytes);
							 }
						}
				  }
				  Some(CommandEvent::Stderr(chunk)) => {
						lines.clear();
						// Always flush the tail on stderr: a diagnostic split in two
						// is harmless, a stalled log is not.
						err_asm.push(&chunk, true, &mut lines);
						if !lines.is_empty() {
							 // Flush stdout first so interleaving is preserved.
							 flush_batch(&sink, &mut batch, &mut bytes);
							 send(&sink, AgentEvent::Stderr {
								  tab_id: String::new(),
								  lines: std::mem::take(&mut lines),
							 });
						}
				  }
				  Some(CommandEvent::Error(message)) => {
						flush_batch(&sink, &mut batch, &mut bytes);
						send(&sink, AgentEvent::Fault { tab_id: String::new(), message });
				  }
				  Some(CommandEvent::Terminated(payload)) => {
						lines.clear();
						out_asm.flush(&mut lines);
						batch.append(&mut lines);
						flush_batch(&sink, &mut batch, &mut bytes);

						lines.clear();
						err_asm.flush(&mut lines);
						if !lines.is_empty() {
							 send(&sink, AgentEvent::Stderr {
								  tab_id: String::new(),
								  lines: std::mem::take(&mut lines),
							 });
						}

						send(&sink, AgentEvent::Exited {
							 tab_id: String::new(),
							 code: payload.code,
							 signal: payload.signal,
						});
						break;
				  }
				  None => {
						flush_batch(&sink, &mut batch, &mut bytes);
						break;
				  }
				  // CommandEvent is #[non_exhaustive]: this arm is REQUIRED to
				  // compile, and new variants can land in a patch release.
				  _ => {}
			 },

			 _ = tick.tick() => flush_batch(&sink, &mut batch, &mut bytes),
		}
	}

	// Drop our bookkeeping for whatever tab this pump belonged to. Read the
	// label from the sink because adoption may have re-keyed it mid-flight.
	let label = sink.lock().ok().map(|guard| guard.tab_id.clone());
	if let Some(label) = label {
		if let Ok(mut pool) = app.state::<Sessions>().0.lock() {
			// Only if the entry under that key is still ours. A suspend/resume
			// cycle can put a *newer* child under the same tab id before this
			// pump notices its own has died, and removing by key alone orphaned
			// the live replacement — the process kept running with nothing in the
			// pool pointing at it.
			let ours = pool
				.sessions
				.get(&label)
				.is_some_and(|session| Arc::ptr_eq(&session.sink, &sink));
			if ours {
				pool.sessions.remove(&label);
			}
			if label == PREWARM_LABEL {
				pool.prewarm = None;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/// The user's home directory, if the environment says where it is.
///
/// `$HOME` rather than a crate: this is the only place the app needs it, and a
/// dependency for one environment variable is not a trade worth making.
fn dirs_home() -> Option<std::path::PathBuf> {
	std::env::var_os("HOME")
		.map(std::path::PathBuf::from)
		.filter(|path| path.is_dir())
}

/// Spawn a sidecar and start its pump. The returned sink starts `Buffering`;
/// the caller promotes it with `adopt`.
fn spawn_sidecar(
	app: &AppHandle,
	label: &str,
	cwd: Option<&str>,
) -> Result<(CommandChild, u32, Sink), String> {
	let mut command = app
		.shell()
		.sidecar(SIDECAR_NAME)
		.map_err(|e| e.to_string())?
		.args(SIDECAR_ARGS)
		.set_raw_out(RAW_OUT);

	// Without this every session inherits the app's working directory, so a
	// session opened for one project would run against another. A pre-warmed
	// child has no project yet; it is only adopted for a tab whose directory
	// matches.
	//
	// With no project at all, fall back to the user's home rather than whatever
	// the app happens to be running from: under `cargo run` that is
	// `packages/desktop/src-tauri`, so a brand-new session opened its file tree
	// on Tauri's own build directory — `capabilities/`, `icons/`, `build.rs`.
	let target = cwd.map(std::path::PathBuf::from).or_else(dirs_home);
	if let Some(dir) = target {
		command = command.current_dir(dir);
	}

	let (rx, child) = command.spawn().map_err(|e| e.to_string())?;

	let pid = child.pid();
	let sink = new_buffering_sink(label);
	tauri::async_runtime::spawn(pump(app.clone(), Arc::clone(&sink), rx));
	Ok((child, pid, sink))
}

/// Top the spare back up, off the caller's critical path.
fn schedule_prewarm(app: &AppHandle) {
	if !PREWARM_ENABLED {
		return;
	}
	let app = app.clone();
	tauri::async_runtime::spawn(async move {
		// `app.state()` returns a temporary guard, so it needs its own binding:
		// inlining it into the `let ... else` drops it at the end of the
		// statement while the lock is still borrowed (E0716).
		let state = app.state::<Sessions>();
		{
			let Ok(pool) = state.0.lock() else { return };
			if pool.prewarm.is_some() || pool.sessions.len() >= MAX_LIVE_SESSIONS {
				return;
			}
		}
		let Ok((child, pid, sink)) = spawn_sidecar(&app, PREWARM_LABEL, None) else {
			return;
		};
		let Ok(mut pool) = state.0.lock() else {
			let _ = child.kill();
			return;
		};
		// Lost a race while spawning: another caller filled the slot.
		if pool.prewarm.is_some() {
			let _ = child.kill();
			return;
		}
		pool.prewarm = Some(Prewarmed { child, pid, sink });
	});
}

/// Evict the least-recently-used session so a new one fits. Never evicts
/// `keep`, which is the tab being opened right now.
fn evict_lru(pool: &mut Pool, keep: &str) -> Option<String> {
	let victim = pool
		.sessions
		.iter()
		.filter(|(label, _)| label.as_str() != keep)
		.min_by_key(|(_, session)| session.last_active)
		.map(|(label, _)| label.clone())?;
	let session = pool.sessions.remove(&victim)?;
	// Announce before killing, so the tab knows the exit that follows was ours.
	send(&session.sink, AgentEvent::Evicted { tab_id: victim.clone() });
	let _ = session.child.kill();
	Some(victim)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Idempotent. Calling it twice for the same `tab_id` does NOT spawn a second
/// process — it swaps in the fresh Channel and returns the live pid with
/// `resumed: true`. That is what makes React StrictMode's double-mount and an
/// HMR reload both safe.
#[tauri::command]
fn agent_start(
	app: AppHandle,
	sessions: State<'_, Sessions>,
	tab_id: String,
	cwd: Option<String>,
	on_event: Channel<AgentEvent>, // JS passes this as `onEvent`
) -> Result<AgentHandle, String> {
	let mut pool = sessions.0.lock().map_err(|_| "sessions mutex poisoned")?;

	// Already running: re-point the stream at the new Channel.
	if let Some(existing) = pool.sessions.get_mut(&tab_id) {
		existing.last_active = Instant::now();
		let sink = Arc::clone(&existing.sink);
		let pid = existing.pid;
		drop(pool);
		adopt(&sink, &tab_id, on_event)?;
		return Ok(AgentHandle { pid, resumed: true, prewarmed: false });
	}

	if pool.sessions.len() >= MAX_LIVE_SESSIONS {
		evict_lru(&mut pool, &tab_id);
	}

	// Adopt the spare only for a tab with no directory of its own: the spare was
	// started in the app's cwd and a child's working directory cannot be changed
	// after spawn.
	if cwd.is_none() {
		if let Some(Prewarmed { child, pid, sink }) = pool.prewarm.take() {
			pool.sessions.insert(
				tab_id.clone(),
				Session { child, pid, sink: Arc::clone(&sink), last_active: Instant::now() },
			);
			drop(pool);
			adopt(&sink, &tab_id, on_event)?;
			schedule_prewarm(&app);
			return Ok(AgentHandle { pid, resumed: false, prewarmed: true });
		}
	}

	drop(pool); // never hold a std guard across the spawn boundary

	let (child, pid, sink) = spawn_sidecar(&app, &tab_id, cwd.as_deref())?;

	let mut pool = sessions.0.lock().map_err(|_| "sessions mutex poisoned")?;
	/*
	 * Someone else may have finished spawning for this tab while the lock was
	 * down — it has to be, because a std guard must not be held across a spawn.
	 * Two `agent_start` calls for one tab both missed the check above, both
	 * spawned, and the second `insert` dropped the first child's handle on the
	 * floor: a process nothing could reach, and one more live sidecar than
	 * `MAX_LIVE_SESSIONS` allows. Losing the race costs one wasted spawn; the
	 * loser kills its own child and attaches to the winner's.
	 */
	if let Some(existing) = pool.sessions.get_mut(&tab_id) {
		existing.last_active = Instant::now();
		let winner = Arc::clone(&existing.sink);
		let winner_pid = existing.pid;
		drop(pool);
		let _ = child.kill();
		adopt(&winner, &tab_id, on_event)?;
		return Ok(AgentHandle { pid: winner_pid, resumed: true, prewarmed: false });
	}

	pool
		.sessions
		.insert(tab_id.clone(), Session { child, pid, sink: Arc::clone(&sink), last_active: Instant::now() });
	drop(pool);
	adopt(&sink, &tab_id, on_event)?;

	schedule_prewarm(&app);
	Ok(AgentHandle { pid, resumed: false, prewarmed: false })
}

/// Write one line to the child's stdin. `CommandChild::write` is a SYNCHRONOUS
/// `write_all` on an os_pipe — fine for JSON lines that fit the pipe buffer
/// (~64 KiB).
#[tauri::command]
fn agent_send(sessions: State<'_, Sessions>, tab_id: String, line: String) -> Result<(), String> {
	let mut pool = sessions.0.lock().map_err(|_| "sessions mutex poisoned")?;
	let session = pool
		.sessions
		.get_mut(&tab_id)
		.ok_or_else(|| format!("no live session for tab {tab_id}"))?;
	session.last_active = Instant::now();

	let mut buf = line.into_bytes();
	if buf.last() != Some(&b'\n') {
		buf.push(b'\n'); // write() is not line-oriented
	}
	session.child.write(&buf).map_err(|e| e.to_string())
}

/// Suspend a tab: kill its process but leave the tab open in the UI. The
/// transcript lives in the session jsonl, so selecting the tab again respawns
/// and replays via `switch_session`.
#[tauri::command]
fn agent_suspend(
	app: AppHandle,
	sessions: State<'_, Sessions>,
	tab_id: String,
) -> Result<(), String> {
	let session = sessions
		.0
		.lock()
		.map_err(|_| "sessions mutex poisoned")?
		.sessions
		.remove(&tab_id);
	if let Some(session) = session {
		session.child.kill().map_err(|e| e.to_string())?;
	}
	schedule_prewarm(&app);
	Ok(())
}

/// `CommandChild::kill(self)` consumes the handle, so we must `.remove()` to
/// take ownership — you cannot kill through a `&mut` from `get_mut`.
#[tauri::command]
fn agent_kill(sessions: State<'_, Sessions>, tab_id: String) -> Result<(), String> {
	let session = sessions
		.0
		.lock()
		.map_err(|_| "sessions mutex poisoned")?
		.sessions
		.remove(&tab_id);
	match session {
		Some(s) => s.child.kill().map_err(|e| e.to_string()),
		None => Ok(()),
	}
}

/// Run a short-lived `omp <args…>` and return its stdout.
///
/// The RPC protocol has no configuration surface — none of its 59 commands
/// touch settings, MCP or plugins — so those go through the CLI instead. This
/// stays in Rust rather than granting the webview `shell:allow-execute`, which
/// would also let it spawn the long-lived sidecar and bypass the relay.
#[tauri::command]
async fn omp_cli(app: AppHandle, args: Vec<String>) -> Result<String, String> {
	/*
	 * Spawned rather than `output()`ed so it can be killed.
	 *
	 * `output()` waits for the channel to close and offers no way to reach the
	 * child, and `CommandChild` does not kill on drop — so a CLI invocation that
	 * hung (a wedged `omp sessions`, a stuck lock) left a process behind for the
	 * life of the app with nothing tracking it. The pool does not own these:
	 * they are short-lived by design, which is exactly why they need a deadline.
	 */
	let (mut rx, child) = app
		.shell()
		.sidecar(SIDECAR_NAME)
		.map_err(|e| e.to_string())?
		.args(args)
		.spawn()
		.map_err(|e| e.to_string())?;

	let deadline = Instant::now() + Duration::from_millis(CLI_TIMEOUT_MS);
	let mut stdout = Vec::new();
	let mut stderr = Vec::new();
	let mut code: Option<i32> = None;

	while Instant::now() < deadline {
		let left = deadline.saturating_duration_since(Instant::now());
		let Ok(event) = tokio::time::timeout(left, rx.recv()).await else { break };
		match event {
			Some(CommandEvent::Stdout(bytes)) => stdout.extend_from_slice(&bytes),
			Some(CommandEvent::Stderr(bytes)) => stderr.extend_from_slice(&bytes),
			Some(CommandEvent::Terminated(status)) => {
				code = status.code;
				break;
			}
			Some(_) => continue,
			None => break,
		}
	}

	let _ = child.kill();

	match code {
		Some(0) => Ok(String::from_utf8_lossy(&stdout).into_owned()),
		Some(status) => {
			let message = String::from_utf8_lossy(&stderr).trim().to_string();
			Err(if message.is_empty() { format!("exited with status {status}") } else { message })
		}
		None => Err("the command did not finish in time".to_string()),
	}
}

/// How many dropped paths to remember before starting over. Far above any real
/// session; it exists so a long-lived window cannot grow the set forever.
const MAX_REMEMBERED_DROPS: usize = 512;

/// How long a short CLI invocation (`omp sessions --json`, `omp config …`) gets.
/// Measured at 0.5-1s for the session listing, so this is generous by two orders
/// of magnitude and exists only so a wedged child cannot outlive the call.
const CLI_TIMEOUT_MS: u64 = 60_000;

/// Paths the user actually dropped on the window.
///
/// `read_dropped_image` is reachable from the webview like any other command, so
/// without this it is a "read me any image on this disk" primitive for whatever
/// happens to be running in there. Rust sees the real drop event, so Rust is the
/// only side that can tell an image the user handed us from one a script asked
/// for. Entries are canonicalised, because the webview is told the path by Tauri
/// and could hand back a different spelling of the same file.
#[derive(Default)]
struct Dropped(Mutex<HashSet<std::path::PathBuf>>);

/// Where omp keeps its sessions. Every path this process is asked to delete has
/// to live under here.
fn sessions_root() -> Option<std::path::PathBuf> {
	dirs_home().map(|home| home.join(".omp").join("agent").join("sessions"))
}

/// Delete a session file.
///
/// The webview has no filesystem access and `omp sessions` only reads, so this
/// is the one door — which is exactly why it is narrow. A delete command
/// reachable from a webview that accepts any path is a hole, not a feature, so
/// the path is canonicalised and required to sit under omp's own sessions
/// directory and to end in `.jsonl`. Symlinks are resolved before the check,
/// not after.
///
/// Stopping a live sidecar for this session is the caller's job: only the
/// webview knows which tab holds which session.
#[tauri::command]
fn delete_session(path: String) -> Result<(), String> {
	let root = sessions_root().ok_or("no home directory")?;
	let root = root.canonicalize().map_err(|e| format!("sessions directory unreadable: {e}"))?;
	let target = std::path::PathBuf::from(&path)
		.canonicalize()
		.map_err(|e| format!("no such session: {e}"))?;

	if !target.starts_with(&root) {
		return Err("refusing to delete outside omp's sessions directory".into());
	}
	if target.extension().and_then(|e| e.to_str()) != Some("jsonl") {
		return Err("refusing to delete a file that is not a session".into());
	}

	std::fs::remove_file(&target).map_err(|e| e.to_string())
}

/// Run one RPC command against a session nobody has open, then go away.
///
/// Deliberately NOT in the pool. The pool is three live sidecars with LRU
/// eviction, so borrowing a slot to rename a session could evict one that is
/// mid-turn and cost it the turn — a context menu must not be able to do that.
/// A child that was never registered evicts nothing.
///
/// The caller sends already-encoded NDJSON lines and names the response it is
/// waiting for; this understands no more of the protocol than the relay does.
#[tauri::command]
async fn agent_oneshot(
	app: AppHandle,
	cwd: Option<String>,
	lines: Vec<String>,
	expect_id: String,
	timeout_ms: u64,
) -> Result<String, String> {
	let mut command = app
		.shell()
		.sidecar(SIDECAR_NAME)
		.map_err(|e| e.to_string())?
		.args(SIDECAR_ARGS);

	if let Some(dir) = cwd.map(std::path::PathBuf::from).or_else(dirs_home) {
		command = command.current_dir(dir);
	}

	let (mut rx, mut child) = command.spawn().map_err(|e| e.to_string())?;

	for line in &lines {
		if let Err(err) = child.write(format!("{line}\n").as_bytes()) {
			let _ = child.kill();
			return Err(err.to_string());
		}
	}

	let deadline = Instant::now() + Duration::from_millis(timeout_ms);
	let mut pending = String::new();
	let mut answer: Option<String> = None;

	while Instant::now() < deadline {
		let left = deadline.saturating_duration_since(Instant::now());
		let Ok(Some(event)) = tokio::time::timeout(left, rx.recv()).await else { break };
		let chunk = match event {
			CommandEvent::Stdout(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
			CommandEvent::Terminated(_) => break,
			_ => continue,
		};
		pending.push_str(&chunk);
		while let Some(cut) = pending.find('\n') {
			let line: String = pending.drain(..=cut).collect();
			let line = line.trim().to_string();
			// Match on the correlation id, like every other client of this
			// protocol: responses are not guaranteed to arrive in order.
			if !line.is_empty() && line.contains(&format!("\"id\":\"{expect_id}\"")) {
				answer = Some(line);
				break;
			}
		}
		if answer.is_some() {
			break;
		}
	}

	let _ = child.kill();
	answer.ok_or_else(|| "the session did not answer in time".to_string())
}

/// An image the user dropped on the window, read for them.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedImage {
	name: String,
	mime_type: String,
	/// Base64, the shape `prompt(message, images)` wants.
	data: String,
}

/// Largest image we will read off a drop. The agent skips anything bigger
/// anyway, and a webview is a bad place to hold a 100 MB base64 string.
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

fn image_mime(path: &std::path::Path) -> Option<&'static str> {
	match path
		.extension()
		.and_then(|ext| ext.to_str())
		.map(str::to_ascii_lowercase)
		.as_deref()
	{
		Some("png") => Some("image/png"),
		Some("jpg" | "jpeg") => Some("image/jpeg"),
		Some("gif") => Some("image/gif"),
		Some("webp") => Some("image/webp"),
		_ => None,
	}
}

/// Read a dropped image so it can be sent as content.
///
/// The webview cannot do this itself. Tauri intercepts window drops and hands
/// the frontend paths rather than `File` objects, and this app grants no
/// filesystem plugin — which is why HTML5 drag-and-drop looked broken.
///
/// Deliberately narrow: it reads **images only**, by extension, under a size
/// cap. Everything else the user drops travels as an `@path` mention that the
/// agent resolves on its own side, so this command never needs to be a general
/// "read any file the webview asks for" hole.
#[tauri::command]
fn read_dropped_image(dropped: State<'_, Dropped>, path: String) -> Result<DroppedImage, String> {
	let path = std::path::Path::new(&path);
	// Only a file the user dropped. See `Dropped`.
	let canonical = path.canonicalize().map_err(|err| err.to_string())?;
	let known = dropped
		.0
		.lock()
		.map_err(|_| "dropped-paths mutex poisoned")?
		.contains(&canonical);
	if !known {
		return Err("that file was not dropped on this window".into());
	}
	let mime = image_mime(path).ok_or_else(|| "not an image".to_string())?;

	let meta = std::fs::metadata(path).map_err(|err| err.to_string())?;
	if meta.len() > MAX_IMAGE_BYTES {
		return Err(format!("larger than {} MB", MAX_IMAGE_BYTES / 1024 / 1024));
	}

	let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
	Ok(DroppedImage {
		name: path
			.file_name()
			.and_then(|name| name.to_str())
			.unwrap_or("image")
			.to_string(),
		mime_type: mime.to_string(),
		data: base64_encode(&bytes),
	})
}

/// Base64 without a dependency. The alphabet is 64 bytes and the loop is six
/// lines; pulling a crate in for that is not worth the supply chain.
fn base64_encode(bytes: &[u8]) -> String {
	const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
		let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
		out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
		out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
		out.push(if chunk.len() > 1 {
			ALPHABET[(n >> 6 & 63) as usize] as char
		} else {
			'='
		});
		out.push(if chunk.len() > 2 {
			ALPHABET[(n & 63) as usize] as char
		} else {
			'='
		});
	}
	out
}

#[tauri::command]
fn agent_pool_status(sessions: State<'_, Sessions>) -> Result<PoolStatus, String> {
	let pool = sessions.0.lock().map_err(|_| "sessions mutex poisoned")?;
	Ok(PoolStatus {
		live: pool.sessions.len(),
		max_live: MAX_LIVE_SESSIONS,
		prewarm_ready: pool.prewarm.is_some(),
		tabs: pool.sessions.keys().cloned().collect(),
	})
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Idempotent: `mem::take` empties the map, so calling this from several hooks
/// is harmless. Poison is deliberately ignored — this is a teardown path.
fn kill_all(app: &AppHandle) {
	let sessions = app.state::<Sessions>();
	let taken = {
		let mut pool = match sessions.0.lock() {
			Ok(pool) => pool,
			Err(poisoned) => poisoned.into_inner(),
		};
		let spare = pool.prewarm.take();
		(std::mem::take(&mut pool.sessions), spare)
	};
	for (_, session) in taken.0 {
		let _ = session.child.kill();
	}
	if let Some(spare) = taken.1 {
		let _ = spare.child.kill();
	}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		// REQUIRED. Without it `app.shell()` panics at runtime on unmanaged
		// state — and it compiles perfectly.
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_clipboard_manager::init())
		.manage(Sessions::default())
		.manage(Dropped::default())
		.invoke_handler(tauri::generate_handler![
			agent_start,
			agent_send,
			agent_suspend,
			agent_kill,
			agent_pool_status,
			omp_cli,
			agent_oneshot,
			delete_session,
			read_dropped_image
		])
		.setup(|app| {
			schedule_prewarm(&app.handle().clone());
			Ok(())
		})
		.on_window_event(|window, event| {
			// Scoped by label so a future secondary window does not nuke every tab.
			if matches!(event, WindowEvent::Destroyed) && window.label() == "main" {
				kill_all(window.app_handle());
			}
			// Remember what was dropped, so `read_dropped_image` can refuse
			// everything else.
			//
			// Accumulating rather than replacing: the webview reads a drop
			// asynchronously, and two batches dropped in quick succession would
			// otherwise race — the second drop would invalidate the first before
			// its images had been read. Bounded by clearing wholesale once the set
			// is implausibly large, which no real session reaches.
			if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
				if let Ok(state) = window.app_handle().state::<Dropped>().0.lock().as_mut() {
					if state.len() > MAX_REMEMBERED_DROPS {
						state.clear();
					}
					state.extend(paths.iter().filter_map(|path| path.canonicalize().ok()));
				}
			}
		})
		.build(tauri::generate_context!())
		.expect("error while building tauri application")
		.run(|app, event| match event {
			// The shell plugin's own RunEvent::Exit cleanup only covers children
			// registered by its JS-facing `spawn` command. Rust-spawned children
			// are invisible to it — this is our only guarantee.
			RunEvent::ExitRequested { .. } | RunEvent::Exit => kill_all(app),
			_ => {},
		});
}
