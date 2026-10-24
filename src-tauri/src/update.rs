//! In-App-Updates aus GitHub Releases (signiertes latest.json, tauri-plugin-updater).
//! Das Plugin lädt in einen eigenen Temp-Ordner und räumt selbst auf – es bleiben
//! keine Installer liegen. Läuft über Befehle, damit es auch im Browser-Modus geht.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Value, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(u) = update else { return Ok(Value::Null) };
    let info = json!({ "version": u.version, "current": u.current_version, "notes": u.body.clone().unwrap_or_default() });
    *app.state::<Pending>().0.lock().unwrap() = Some(u);
    Ok(info)
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let u = app.state::<Pending>().0.lock().unwrap().take().ok_or("Kein Update vorgemerkt")?;
    crate::log::write("info", &format!("Update auf {} wird installiert", u.version));
    let mut got: u64 = 0;
    let progress = app.clone();
    u.download_and_install(
        move |chunk, total| {
            got += chunk as u64;
            if let Some(total) = total.filter(|t| *t > 0) {
                let _ = progress.emit("update:progress", json!({ "percent": got as f64 * 100.0 / total as f64 }));
            }
        },
        || {},
    )
    .await
    .map_err(|e| {
        crate::log::write("error", &format!("Update fehlgeschlagen: {e}"));
        e.to_string()
    })?;
    app.restart();
}
