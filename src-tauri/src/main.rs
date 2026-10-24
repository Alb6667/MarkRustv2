#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;

/// Batas ukuran berkas yang boleh dibuka. Editor memuat seluruh dokumen ke
/// memori (Delta Quill), jadi berkas raksasa harus ditolak lebih awal.
const MAX_DOCUMENT_BYTES: u64 = 10 * 1024 * 1024;

/// Normalnya path datang dari dialog pilihan pengguna, tetapi webview tidak
/// bisa dibuktikan sebagai sumbernya. Karena itu batasi juga: wajib absolut
/// dan berekstensi teks/Markdown, supaya penyalahgunaan tidak bisa membaca
/// atau menimpa berkas sembarangan (mis. konfigurasi sistem).
fn document_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if path.as_os_str().is_empty() {
        return Err("Path berkas kosong".into());
    }
    if !path.is_absolute() {
        return Err("Path berkas harus absolut".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "md" | "markdown" | "txt" | "mdown" | "mkd") {
        return Err("Hanya berkas .md, .markdown, atau .txt yang didukung".into());
    }
    Ok(path)
}

#[tauri::command]
fn read_document(path: String) -> Result<String, String> {
    let path = document_path(&path)?;
    let meta = fs::metadata(&path).map_err(|e| format!("Tidak bisa membuka berkas: {e}"))?;
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "Berkas terlalu besar (maksimum {} MB)",
            MAX_DOCUMENT_BYTES / 1024 / 1024
        ));
    }
    fs::read_to_string(&path).map_err(|e| format!("Tidak bisa membaca berkas: {e}"))
}

/// Tulis lewat berkas sementara di direktori yang sama lalu rename, supaya
/// proses baca tidak pernah melihat dokumen setengah jadi.
#[tauri::command]
fn write_document(path: String, contents: String) -> Result<(), String> {
    let target = document_path(&path)?;
    let parent = target
        .parent()
        .ok_or_else(|| "Path tanpa direktori induk".to_string())?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Nama berkas tidak valid".to_string())?;

    let tmp = parent.join(format!(".{name}.markrust-tmp"));
    if let Err(e) = fs::write(&tmp, contents.as_bytes()) {
        return Err(format!("Gagal menulis berkas sementara: {e}"));
    }
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Gagal menyimpan berkas: {e}"));
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_document, write_document])
        .setup(|app| {
            // Menu native tanpa accelerator: pintasan keyboard ditangani
            // terpusat di frontend. Kalau keduanya aktif, Ctrl+S bisa memicu
            // dua kali simpan pada platform yang meneruskan keydown ke webview.
            let new_item = MenuItemBuilder::with_id("new", "Dokumen Baru").build(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Buka…").build(app)?;
            let save_item = MenuItemBuilder::with_id("save", "Simpan").build(app)?;
            let save_as_item = MenuItemBuilder::with_id("save_as", "Simpan Sebagai…").build(app)?;
            let mode_item =
                MenuItemBuilder::with_id("toggle_mode", "Ganti Mode WYSIWYG/Markdown")
                    .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "Berkas")
                .items(&[&new_item, &open_item, &save_item, &save_as_item, &mode_item])
                .build()?;
            app.set_menu(MenuBuilder::new(app).items(&[&file_menu]).build()?)?;

            app.on_menu_event(|handle, event| {
                let _ = handle.emit("markrust://menu", event.id().0.clone());
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
