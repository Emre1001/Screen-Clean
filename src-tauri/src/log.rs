//! System-Protokoll: eine Textdatei neben der Konfiguration (rotiert bei
//! 1 MB) plus Live-Event `app:log` ans Frontend. Rust und Frontend schreiben
//! beide hierhin – bei Problemen reicht diese eine Datei.

use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

const MAX_BYTES: u64 = 1 << 20;
static LOCK: Mutex<()> = Mutex::new(());

pub fn path() -> PathBuf {
    crate::config::path().with_file_name("screen-clean.log")
}

/// UTC-Zeitstempel ohne Zusatz-Crate (Algorithmus „days from civil“ invertiert).
fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn write(level: &str, msg: &str) {
    let _guard = LOCK.lock();
    let p = path();
    if fs::metadata(&p).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&p, p.with_extension("log.1"));
    }
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{} [{level}] {msg}", timestamp());
    }
}

/// Meldung aus Rust: in die Datei und live ins Protokoll der Oberfläche.
pub fn emit(app: &AppHandle, level: &str, msg: impl Into<String>) {
    let msg = msg.into();
    write(level, &msg);
    let _ = app.emit("app:log", json!({ "level": level, "msg": msg }));
}

#[tauri::command]
pub fn log_write(level: String, msg: String) {
    let level = match level.as_str() {
        "warn" | "error" => level,
        _ => "info".into(),
    };
    write(&level, &msg.chars().take(2000).collect::<String>());
}

#[tauri::command]
pub fn log_open(app: AppHandle) -> Result<(), String> {
    write("info", "Protokoll geöffnet");
    app.opener().open_path(path().to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn timestamp_format() {
        let t = super::timestamp();
        assert_eq!(t.len(), 20, "{t}");
        assert!(t.starts_with("20") && t.ends_with('Z'));
    }
}
