mod config;
mod discovery;
mod input;
mod log;
mod web;

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static READY: AtomicBool = AtomicBool::new(false);
static START_HIDDEN: AtomicBool = AtomicBool::new(false);

fn show_main(app: &AppHandle) {
    let web = app.state::<web::Web>();
    if web.running() {
        return web.open(app);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if app.state::<web::Web>().running() {
        return show_main(app);
    }
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

/// Notbremse: Input sofort in Rust sperren, dann Frontend informieren.
fn emergency_stop(app: &AppHandle) {
    app.state::<input::InputState>().disable();
    log::emit(app, "warn", "Notbremse ausgelöst");
    let _ = app.emit("app:stop", ());
}

/// Beenden mit kurzer Gnadenfrist: das Frontend verabschiedet sich bei allen
/// Teilnehmern, damit deren Auto-Reconnect nicht ins Leere läuft.
fn graceful_exit(app: &AppHandle) {
    app.state::<input::InputState>().disable();
    let _ = app.emit("app:quit", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(350));
        app.exit(0);
    });
}

/// Fenster erst zeigen, wenn die Oberfläche gerendert ist – kein weißes Aufblitzen.
#[tauri::command]
fn app_ready(app: AppHandle) {
    if !READY.swap(true, Ordering::SeqCst) && !START_HIDDEN.load(Ordering::SeqCst) {
        show_main(&app);
    }
}

#[derive(Serialize)]
struct SysInfo {
    os: &'static str,
    arch: &'static str,
    hostname: String,
    session: String,
    version: &'static str,
}

#[tauri::command]
fn sys_info() -> SysInfo {
    SysInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        hostname: hostname::get().ok().and_then(|h| h.into_string().ok()).unwrap_or_default(),
        session: std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[derive(Serialize)]
struct MonitorInfo {
    name: String,
    primary: bool,
    scale: f64,
    rect: input::Rect,
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| MonitorInfo {
            name: m.name().cloned().unwrap_or_default(),
            primary: Some(*m.position()) == primary,
            scale: m.scale_factor(),
            rect: input::Rect {
                x: m.position().x,
                y: m.position().y,
                w: m.size().width as i32,
                h: m.size().height as i32,
            },
        })
        .collect()
}

/// Cursor-Overlay des Hosts: transparent, klick-durchlässig, immer oben,
/// auf Windows vom Capture ausgeschlossen (WDA_EXCLUDEFROMCAPTURE).
#[tauri::command]
async fn overlay_show(app: AppHandle, rect: input::Rect) -> Result<bool, String> {
    let win = match app.get_webview_window("overlay") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
            .title("Screen-Clean Overlay")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .content_protected(true)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    win.set_position(tauri::PhysicalPosition::new(rect.x, rect.y)).map_err(|e| e.to_string())?;
    win.set_size(tauri::PhysicalSize::new(rect.w as u32, rect.h as u32)).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    // true = Overlay erscheint im Stream (nur Windows kann es ausschließen)
    Ok(!cfg!(windows))
}

#[tauri::command]
fn overlay_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("nur http(s)-Links".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    let res = if enabled { al.enable() } else { al.disable() };
    res.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
fn tray_status(app: AppHandle, text: String) {
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_tooltip(Some(text));
    }
}

#[tauri::command]
fn restart(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn quit(app: AppHandle) {
    graceful_exit(&app);
}

/// Befehle für den Browser-Modus (HTTP statt Tauri-IPC) – gleiche Funktionen.
pub(crate) fn dispatch(app: &AppHandle, cmd: &str, a: Value) -> Result<Value, String> {
    fn de<T: serde::de::DeserializeOwned>(a: &Value, k: &str) -> Result<T, String> {
        serde_json::from_value(a.get(k).cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())
    }
    let a = &a;
    Ok(match cmd {
        "config_load" => config::config_load(),
        "config_save" => json!(config::config_save(de(a, "value")?)?),
        "input_send" => json!(input::input_send(app.state(), de(a, "events")?)),
        "input_enable" => json!(input::input_enable(app.state(), de(a, "enabled")?)),
        "input_target" => json!(input::input_target(app.state(), de(a, "rect")?)?),
        "input_check" => json!(input::input_check(app.state())?),
        "discovery_set" => json!(discovery::discovery_set(app.state(), de(a, "beacon")?)),
        "discovery_status" => json!(discovery::discovery_status(app.state())?),
        "sys_info" => json!(sys_info()),
        "list_monitors" => json!(list_monitors(app.clone())),
        "overlay_show" => json!(tauri::async_runtime::block_on(overlay_show(app.clone(), de(a, "rect")?))?),
        "overlay_hide" => json!(overlay_hide(app.clone())),
        "open_url" => json!(open_url(app.clone(), de(a, "url")?)?),
        "notify" => json!(notify(app.clone(), de(a, "title")?, de(a, "body")?)),
        "autostart_set" => json!(autostart_set(app.clone(), de(a, "enabled")?)?),
        "autostart_get" => json!(autostart_get(app.clone())),
        "set_close_to_tray" => json!(set_close_to_tray(de(a, "enabled")?)),
        "tray_status" => json!(tray_status(app.clone(), de(a, "text")?)),
        "restart" => json!(restart(app.clone())),
        "quit" => json!(quit(app.clone())),
        "app_ready" => json!(app_ready(app.clone())),
        "log_write" => json!(log::log_write(de(a, "level")?, de(a, "msg")?)),
        "log_open" => json!(log::log_open(app.clone())?),
        "emit_to" => {
            let target: String = de(a, "target")?;
            let event: String = de(a, "event")?;
            json!(app.emit_to(target.as_str(), &event, a.get("payload").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?)
        }
        _ => return Err(format!("unbekannter Befehl: {cmd}")),
    })
}

/// Kompatibilitäts-Modus muss vor dem Erzeugen des WebViews greifen.
fn apply_compat_mode() {
    let cfg = config::read();
    if cfg.pointer("/settings/compat").and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    #[cfg(windows)]
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu --disable-gpu-compositing");
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// WebKitGTK hat WebRTC/MediaStream standardmäßig aus und fragt nie nach
/// Kamera/Bildschirm – beides hier freischalten (nur Medien-Anfragen).
#[cfg(target_os = "linux")]
fn enable_linux_media(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|wv| {
        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};
        use webkit2gtk::glib::object::Cast;
        let view = wv.inner();
        if let Some(s) = WebViewExt::settings(&view) {
            s.set_enable_webrtc(true);
            s.set_enable_media_stream(true);
            s.set_enable_mediasource(true);
            s.set_media_playback_requires_user_gesture(false);
        }
        view.connect_permission_request(|_, req| {
            if req.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                req.allow();
            } else {
                req.deny();
            }
            true
        });
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Screen-Clean öffnen", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stopp / Trennen  (Strg+Shift+X)", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &stop, &sep, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("Screen-Clean")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "stop" => emergency_stop(app),
            "quit" => graceful_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    apply_compat_mode();
    START_HIDDEN.store(std::env::args().any(|a| a == "--minimized"), Ordering::SeqCst);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_denylist(&["overlay"])
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, ev| {
                    if ev.state != ShortcutState::Pressed {
                        return;
                    }
                    if sc.matches(Modifiers::ALT | Modifiers::SHIFT, Code::KeyS) {
                        toggle_main(app);
                    } else if sc.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyX) {
                        emergency_stop(app);
                    }
                })
                .build(),
        )
        .manage(input::InputState::spawn())
        .manage(discovery::Discovery::default())
        .manage(web::Web::default())
        .setup(move |app| {
            log::write("info", &format!("Screen-Clean {} startet ({})", env!("CARGO_PKG_VERSION"), std::env::consts::OS));
            for sc in ["alt+shift+s", "ctrl+shift+x"] {
                if let Err(e) = app.global_shortcut().register(sc) {
                    log::write("warn", &format!("Shortcut {sc} nicht registriert (belegt?): {e}"));
                }
            }
            app.state::<discovery::Discovery>().start(app.handle().clone());
            build_tray(app)?;
            #[cfg(target_os = "linux")]
            enable_linux_media(&app.get_webview_window("main").expect("main window"));
            // Sicherheitsnetz: meldet sich die Oberfläche nicht, trotzdem anzeigen
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                let web = handle.state::<web::Web>().running();
                if !READY.swap(true, Ordering::SeqCst) && !START_HIDDEN.load(Ordering::SeqCst) && !web {
                    log::write("warn", "Oberfläche hat sich nicht gemeldet – Fenster trotzdem anzeigen");
                    show_main(&handle);
                }
            });
            Ok(())
        })
        .on_window_event(|win, ev| {
            if let WindowEvent::CloseRequested { api, .. } = ev {
                if win.label() == "main" && CLOSE_TO_TRAY.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = win.hide();
                } else if win.label() == "main" {
                    win.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            config::config_load,
            config::config_save,
            input::input_send,
            input::input_enable,
            input::input_target,
            input::input_check,
            discovery::discovery_set,
            discovery::discovery_status,
            sys_info,
            list_monitors,
            overlay_show,
            overlay_hide,
            open_url,
            notify,
            autostart_set,
            autostart_get,
            set_close_to_tray,
            tray_status,
            restart,
            quit,
            app_ready,
            log::log_write,
            log::log_open,
            web::web_start,
        ])
        .run(tauri::generate_context!())
        .expect("Screen-Clean konnte nicht starten");
}
