//! Recovery snapshots live only in the app data directory, never at a webview path.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::Manager;

static LOCK: Mutex<()> = Mutex::new(());
const LIMIT: usize = 12 * 1024 * 1024;
const KEEP: usize = 5;

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|p| p.join("recovery-v1")).map_err(|e| e.to_string())
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
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    write(&directory(&app)?, &contents)
}
#[tauri::command]
pub fn read_recovery(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    read(&directory(&app)?)
}
#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    for path in snapshots(&directory(&app)?)? { fs::remove_file(path).map_err(|e| e.to_string())?; }
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
}
