//! Persistente Konfiguration (Profil, Einstellungen, Freunde, Verlauf) als
//! eine JSON-Datei im App-Config-Ordner. Schreiben atomar (tmp + rename),
//! kaputte Dateien werden als `.bak` gesichert statt überschrieben.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub const IDENTIFIER: &str = "io.github.emre.screenclean";

pub fn path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(IDENTIFIER)
        .join("config.json")
}

pub fn read() -> Value {
    let p = path();
    let Ok(text) = fs::read_to_string(&p) else { return Value::Null };
    match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            let _ = fs::rename(&p, p.with_extension("json.bak"));
            Value::Null
        }
    }
}

#[tauri::command]
pub fn config_load() -> Value {
    read()
}

#[tauri::command]
pub fn config_save(value: Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("Konfiguration muss ein Objekt sein".into());
    }
    let p = path();
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
