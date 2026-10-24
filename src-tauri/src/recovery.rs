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

fn lock_session(dir: &Path) -> Result<Option<Session>, String> {
    let lock = fs::OpenOptions::new().read(true).write(true).create(true)
        .truncate(false).open(dir.join("session.lock")).map_err(|e| e.to_string())?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(Some(Session { dir: dir.to_path_buf(), _lock: lock })),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
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
    for old in files.iter().take(files.len().saturating_sub(KEEP)) { let _ = fs::remove_file(old); }
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
    with_session(&app, |dir| write(dir, &contents))
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

}
