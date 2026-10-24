//! Recovery snapshots live only in the app data directory, never at a webview path.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::Manager;
use fs2::FileExt;
use std::fs::File;

// Each process owns exactly one locked session directory. Stale sessions can
// be adopted only after the OS grants their lock; never infer liveness from PID.
struct Session { dir: PathBuf, _lock: File }
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
const LIMIT: usize = 12 * 1024 * 1024;
const KEEP: usize = 5;
const TOTAL_LIMIT: u64 = 256 * 1024 * 1024;

fn lock_session(dir: &Path) -> Result<Option<Session>, String> {
    let lock = fs::OpenOptions::new().read(true).write(true).create(true)
        .truncate(false).open(dir.join("session.lock")).map_err(|e| e.to_string())?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(Some(Session { dir: dir.to_path_buf(), _lock: lock })),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
            || e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn acquire(root: &Path) -> Result<Session, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut dirs = fs::read_dir(root).map_err(|e| e.to_string())?
        .filter_map(Result::ok).map(|e| e.path())
        .filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("session-")))
        .collect::<Vec<_>>();
    dirs.sort();
    // Claim one abandoned document; leave all other recoveries untouched.
    for dir in dirs.iter().rev() {
        if let Some(session) = lock_session(dir)? {
            if !snapshots(dir)?.is_empty() { return Ok(session); }
        }
    }
    loop {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let dir = root.join(format!("session-{stamp:039}-{}", std::process::id()));
        match fs::create_dir(&dir) {
            Ok(()) => return lock_session(&dir)?.ok_or_else(|| "Session lock unavailable".into()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
}
fn with_session<T>(app: &tauri::AppHandle, task: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    let mut state = SESSION.lock().map_err(|e| e.to_string())?;
    if state.is_none() {
        let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let mut session = acquire(&base.join("recovery-v2"))?;
        // Adopt old-format recovery in place, under the same OS lock. Never
        // copy it into several sessions or delete an unclaimed legacy draft.
        let legacy = base.join("recovery-v1");
        if snapshots(&session.dir)?.is_empty() && legacy.is_dir() {
            if let Some(old) = lock_session(&legacy)? {
                if !snapshots(&legacy)?.is_empty() { session = old; }
            }
        }
        *state = Some(session);
    }
    task(&state.as_ref().unwrap().dir)
}
// Count both legacy and session storage, including crash-left temporary files.
// Never follow symlinks and never silently skip an unreadable entry.
fn disk_usage(dir: &Path) -> Result<u64, String> {
    if !dir.exists() { return Ok(0); }
    let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        let bytes = if meta.is_dir() { disk_usage(&entry.path())? }
            else if meta.is_file() { meta.len() } else { 0 };
        total = total.checked_add(bytes).ok_or("Ukuran recovery tidak valid")?;
    }
    Ok(total)
}
fn write_budgeted(base: &Path, dir: &Path, contents: &str, limit: u64) -> Result<(), String> {
    validate(contents)?;
    // A separate OS lock serializes quota checks + writes across processes.
    // Session ownership is already held; no code takes locks in reverse order.
    let lock = fs::OpenOptions::new().read(true).write(true).create(true)
        .truncate(false).open(base.join("recovery-budget.lock")).map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    let usage = disk_usage(&base.join("recovery-v1"))?
        .checked_add(disk_usage(&base.join("recovery-v2"))?).ok_or("Ukuran recovery tidak valid")?;
    // Reserve room for the complete new snapshot before pruning our versions.
    if usage.saturating_add(contents.len() as u64) > limit {
        return Err("Batas total recovery tercapai. Simpan berkas; cadangan sesi lain tidak dihapus otomatis.".into());
    }
    write(dir, contents)
}
fn snapshots(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.exists() { return Ok(vec![]); }
    let mut files = fs::read_dir(dir).map_err(|e| e.to_string())?
        .filter_map(Result::ok).map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}
fn validate(contents: &str) -> Result<(), String> {
    if contents.len() > LIMIT { return Err("Draf terlalu besar (maksimum 12 MB)".into()); }
    let data: serde_json::Value = serde_json::from_str(contents).map_err(|e| e.to_string())?;
    if data["version"] != 1 || !data["markdown"].is_string() {
        return Err("Format draf tidak valid".into());
    }
    Ok(())
}
fn write(dir: &Path, contents: &str) -> Result<(), String> {
    validate(contents)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let name = format!("{stamp:039}-{}", std::process::id());
    let tmp = dir.join(format!("{name}.tmp"));
    let target = dir.join(format!("{name}.json"));
    let result = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)?;
        Ok(())
    })();
    if let Err(e) = result { let _ = fs::remove_file(tmp); return Err(e.to_string()); }
    // Prune only after a complete new version is safely written.
    let files = snapshots(dir)?;
    for old in files.iter().take(files.len().saturating_sub(KEEP)) {
        fs::remove_file(old).map_err(|e| format!("Cadangan baru ditulis tetapi cleanup gagal: {e}"))?;
    }
    Ok(())
}
fn read(dir: &Path) -> Result<Option<String>, String> {
    let files = snapshots(dir)?;
    for path in files.iter().rev() {
        if fs::metadata(path).map_err(|e| e.to_string())?.len() > LIMIT as u64 { continue; }
        if let Ok(text) = fs::read_to_string(path) {
            if validate(&text).is_ok() { return Ok(Some(text)); }
        }
    }
    if files.is_empty() { Ok(None) } else { Err("Tidak ada versi cadangan yang valid".into()) }
}
#[tauri::command]
pub fn write_recovery(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    with_session(&app, |dir| {
        let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
        write_budgeted(&base, dir, &contents, TOTAL_LIMIT)
    })
}
#[tauri::command]
pub fn read_recovery(app: tauri::AppHandle) -> Result<Option<String>, String> {
    with_session(&app, read)
}
#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle) -> Result<(), String> {
    with_session(&app, |dir| {
        for path in snapshots(dir)? { fs::remove_file(path).map_err(|e| e.to_string())?; }
        Ok(())
    })
}

// IDs are directory names, never arbitrary filesystem paths from the webview.
fn candidate_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    if id == "legacy" { return Ok(base.join("recovery-v1")); }
    if !id.starts_with("session-") || !id.bytes().all(|c| c.is_ascii_digit() || c == b'-' || c.is_ascii_lowercase()) {
        return Err("ID recovery tidak valid".into());
    }
    Ok(base.join("recovery-v2").join(id))
}
#[tauri::command]
pub fn list_recoveries(app: tauri::AppHandle) -> Result<String, String> {
    // Initialize/adopt once, then list our recovery and unlocked abandoned ones.
    with_session(&app, |_| Ok(()))?;
    let state = SESSION.lock().map_err(|e| e.to_string())?;
    let own = &state.as_ref().unwrap().dir;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut dirs = Vec::new();
    for entry in fs::read_dir(base.join("recovery-v2")).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_dir() && path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("session-")) { dirs.push(path); }
    }
    if base.join("recovery-v1").is_dir() { dirs.push(base.join("recovery-v1")); }
    let mut rows = Vec::new();
    for dir in dirs {
        let held;
        if &dir != own {
            held = lock_session(&dir)?;
            if held.is_none() { continue; }
        }
        if let Ok(Some(raw)) = read(&dir) {
            let data: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let id = if dir == base.join("recovery-v1") { "legacy".to_string() }
                else { dir.file_name().unwrap().to_string_lossy().into_owned() };
            rows.push(serde_json::json!({"id":id,"path":data["path"],"savedAt":data["savedAt"]}));
        }
    }
    Ok(serde_json::Value::Array(rows).to_string())
}
#[tauri::command]
pub fn select_recovery(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut state = SESSION.lock().map_err(|e| e.to_string())?;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = candidate_path(&base, &id)?;
    if state.as_ref().is_some_and(|s| s.dir == path) { return Ok(()); }
    // Reject symlink directories and check ownership again, not just at listing.
    if !fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_dir() {
        return Err("Recovery tidak valid".into());
    }
    let selected = lock_session(&path)?.ok_or("Recovery sedang dipakai instance lain")?;
    if read(&path)?.is_none() { return Err("Recovery sudah tidak tersedia".into()); }
    *state = Some(selected); // Release previous lock without deleting its files.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_are_bounded_and_corruption_falls_back() {
        let dir = std::env::temp_dir().join(format!("markrust-recovery-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        for n in 0..7 { write(&dir, &format!(r#"{{"version":1,"markdown":"{n}"}}"#)).unwrap(); }
        let files = snapshots(&dir).unwrap();
        assert_eq!(files.len(), KEEP);
        assert!(read(&dir).unwrap().unwrap().contains('6'));
        fs::write(files.last().unwrap(), "broken").unwrap();
        assert!(read(&dir).unwrap().unwrap().contains('5'));
        assert!(write(&dir, "bad json").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn live_sessions_are_isolated_and_crashed_session_can_be_claimed() {
        let root = std::env::temp_dir().join(format!("mr-sessions-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let first = acquire(&root).unwrap();
        write(&first.dir, r#"{"version":1,"markdown":"first"}"#).unwrap();
        let second = acquire(&root).unwrap();
        assert_ne!(first.dir, second.dir);
        write(&second.dir, r#"{"version":1,"markdown":"second"}"#).unwrap();
        assert!(read(&first.dir).unwrap().unwrap().contains("first"));
        assert!(read(&second.dir).unwrap().unwrap().contains("second"));
        let abandoned = first.dir.clone();
        drop(first); // OS releases the lock, just as when the process exits.
        let recovered = acquire(&root).unwrap();
        assert_eq!(recovered.dir, abandoned);
        assert!(read(&recovered.dir).unwrap().unwrap().contains("first"));
        assert!(read(&second.dir).unwrap().unwrap().contains("second"));
        drop(recovered);
        drop(second);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn quota_refuses_new_snapshot_without_deleting_any_session() {
        let base = std::env::temp_dir().join(format!("mr-quota-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let root = base.join("recovery-v2");
        let first = acquire(&root).unwrap();
        let second = acquire(&root).unwrap();
        let data = r#"{"version":1,"markdown":"important"}"#;
        write_budgeted(&base, &first.dir, data, 4096).unwrap();
        write_budgeted(&base, &second.dir, data, 4096).unwrap();
        let before = disk_usage(&root).unwrap();
        assert!(write_budgeted(&base, &first.dir, data, before).is_err());
        assert_eq!(disk_usage(&root).unwrap(), before);
        assert_eq!(read(&first.dir).unwrap().unwrap(), data);
        assert_eq!(read(&second.dir).unwrap().unwrap(), data);
        // Count interrupted writes and old-format snapshots too.
        fs::write(first.dir.join("interrupted.tmp"), b"12345").unwrap();
        fs::create_dir_all(base.join("recovery-v1")).unwrap();
        fs::write(base.join("recovery-v1/old.json"), data).unwrap();
        assert!(write_budgeted(&base, &first.dir, data, before + data.len() as u64).is_err());
        drop(first); drop(second);
        fs::remove_dir_all(base).unwrap();
    }

    // Invoked as a separate test executable by the parent. stdin is the
    // handshake channel; no polling or arbitrary sleep is needed.
    #[test]
    fn subprocess_lock_holder() {
        let Some(root) = std::env::var_os("MARKRUST_LOCK_TEST_ROOT") else { return; };
        let session = acquire(Path::new(&root)).unwrap();
        write(&session.dir, r#"{"version":1,"markdown":"child draft"}"#).unwrap();
        println!("RECOVERY_READY");
        std::io::stdout().flush().unwrap();
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        drop(session);
    }

    #[test]
    fn killed_process_releases_lock_and_its_draft_survives() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let root = std::env::temp_dir().join(format!("mr-child-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "recovery::tests::subprocess_lock_holder", "--nocapture"])
            .env("MARKRUST_LOCK_TEST_ROOT", &root)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(output.read_line(&mut line).unwrap() > 0, "child exited before acquiring lock");
            if line.contains("RECOVERY_READY") { break; }
        }
        let parent = acquire(&root).unwrap();
        assert!(read(&parent.dir).unwrap().is_none(), "live child must be skipped");
        child.kill().unwrap();
        child.wait().unwrap();
        let recovered = acquire(&root).unwrap();
        assert_ne!(recovered.dir, parent.dir);
        assert!(read(&recovered.dir).unwrap().unwrap().contains("child draft"));
        drop(recovered); drop(parent);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_ids_cannot_escape_storage_root() {
        let base = Path::new("app-data");
        assert!(candidate_path(base, "../outside").is_err());
        assert!(candidate_path(base, "session-../../outside").is_err());
        assert!(candidate_path(base, "session-foo/bar").is_err());
        assert_eq!(candidate_path(base, "session-123-45").unwrap(), base.join("recovery-v2/session-123-45"));
        assert_eq!(candidate_path(base, "legacy").unwrap(), base.join("recovery-v1"));
    }

}
