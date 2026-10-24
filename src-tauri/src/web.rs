//! Browser-Modus für Linux.
//!
//! WebKitGTK wird von den meisten Distros (z. B. Ubuntu) ohne WebRTC gebaut –
//! im Tauri-Fenster gibt es dann kein `RTCPeerConnection`. In dem Fall liefert
//! dieser Mini-HTTP-Server die Oberfläche lokal aus und sie läuft in Chrome/
//! Chromium (App-Fenster) oder dem Standard-Browser. Befehle und Events gehen
//! über `/api/<befehl>` bzw. `/events` (SSE).
//!
//! Sicherheit: nur 127.0.0.1, zufälliger Port, jede Anfrage mit fremdem
//! `Origin` (andere Webseiten) wird abgewiesen. Die URL trägt nur einen
//! Einmal-Token (Prozess-Kommandozeilen sind für alle lokalen Nutzer lesbar);
//! die Seite tauscht ihn gegen den eigentlichen Sitzungs-Token.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_opener::OpenerExt;

const MAX_BODY: usize = 1 << 20;

#[derive(Default)]
pub struct Web {
    ctx: Mutex<Option<Arc<Ctx>>>,
}

impl Web {
    pub fn running(&self) -> bool {
        self.ctx.lock().unwrap().is_some()
    }

    /// Fenster nach vorn holen – oder öffnen, falls keins verbunden ist.
    /// Nie ein zweites: doppelte Fenster hätten denselben Code und stören sich.
    pub fn open(&self) {
        if let Some(ctx) = self.ctx.lock().unwrap().as_ref() {
            ctx.show();
        }
    }
}

struct Ctx {
    app: AppHandle,
    own: String,
    dev: Option<String>,
    token: String,
    boot: Mutex<Vec<String>>,
    origins: Vec<String>,
    clients: Arc<Mutex<Vec<TcpStream>>>,
}

impl Ctx {
    fn show(&self) {
        let mut clients = self.clients.lock().unwrap();
        clients.retain_mut(|s| s.write_all(b"event: app:focus\ndata: null\n\n").is_ok());
        if clients.is_empty() {
            drop(clients);
            open_browser(&self.app, &self.url());
        }
    }

    fn url(&self) -> String {
        let boot = token();
        self.boot.lock().unwrap().push(boot.clone());
        match &self.dev {
            Some(d) => format!("{d}/?api={}&boot={boot}", self.own),
            None => format!("{}/?boot={boot}", self.own),
        }
    }
}

fn token() -> String {
    let mut b = [0u8; 16];
    #[cfg(unix)]
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    if b == [0; 16] {
        // RandomState ist pro Prozess zufällig geseedet
        use std::hash::BuildHasher;
        let s = std::collections::hash_map::RandomState::new();
        b[..8].copy_from_slice(&s.hash_one(std::time::SystemTime::now()).to_le_bytes());
        b[8..].copy_from_slice(&s.hash_one(std::process::id()).to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Öffnet die UI bevorzugt als Chromium-App-Fenster, sonst im Standard-Browser.
fn open_browser(app: &AppHandle, url: &str) {
    let profile = dirs::config_dir().map(|d| d.join(crate::config::IDENTIFIER).join("browser"));
    for bin in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge", "vivaldi"] {
        let mut c = std::process::Command::new(bin);
        c.args([
            &format!("--app={url}"),
            "--window-size=1200,800",
            "--no-first-run",
            "--no-default-browser-check",
            // gleiche WM_CLASS wie die App: Taskleiste zeigt unser Icon statt Chrome
            "--class=screen-clean",
            // Host im Hintergrund: Timer nicht drosseln, sonst ruckeln Cursor und Heartbeat
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ]);
        if let Some(p) = &profile {
            c.arg(format!("--user-data-dir={}", p.display()));
        }
        if c.spawn().is_ok() {
            return;
        }
    }
    let _ = app.opener().open_url(url, None::<&str>);
}

#[tauri::command]
pub fn web_start(app: AppHandle, state: tauri::State<Web>) -> Result<(), String> {
    crate::READY.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut cur = state.ctx.lock().unwrap();
    if let Some(ctx) = cur.as_ref() {
        ctx.show();
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let own = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
    // Im Dev-Modus kommt die UI vom Vite-Server, die API von hier (CORS)
    let dev = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref().map(|u| u.origin().ascii_serialization())
    } else {
        None
    };
    let clients: Arc<Mutex<Vec<TcpStream>>> = Default::default();
    for ev in ["lan:peer", "app:stop"] {
        let c = clients.clone();
        app.listen_any(ev, move |e| broadcast(&c, ev, e.payload()));
    }
    let origins = [Some(own.clone()), dev.clone()].into_iter().flatten().collect();
    let ctx = Arc::new(Ctx { app: app.clone(), own, dev, token: token(), boot: Mutex::default(), origins, clients });
    let server = ctx.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let ctx = server.clone();
            std::thread::spawn(move || {
                let _ = handle(&ctx, stream);
            });
        }
    });

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    crate::log::emit(&app, "info", format!("Browser-Modus aktiv ({})", ctx.own));
    // Toten SSE-Verbindungen regelmäßig per Kommentar-Ping auf die Schliche kommen
    let ping = ctx.clients.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(15));
        ping.lock().unwrap().retain_mut(|s| s.write_all(b": ping\n\n").is_ok());
    });
    open_browser(&app, &ctx.url());
    *cur = Some(ctx);
    Ok(())
}

fn broadcast(clients: &Mutex<Vec<TcpStream>>, event: &str, data: &str) {
    let msg = format!("event: {event}\ndata: {data}\n\n");
    clients.lock().unwrap().retain_mut(|s| s.write_all(msg.as_bytes()).is_ok());
}

fn respond(s: &mut TcpStream, code: u16, mime: &str, body: &[u8], cors: Option<&str>) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Method Not Allowed",
    };
    let mut head = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: keep-alive\r\nCache-Control: no-store\r\n", body.len());
    if let Some(o) = cors {
        head.push_str(&format!("Access-Control-Allow-Origin: {o}\r\nAccess-Control-Allow-Headers: content-type, x-token, x-boot\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes())?;
    s.write_all(body)
}

/// Keep-Alive: mehrere Anfragen pro Verbindung (Eingaben kommen im 8-ms-Takt).
fn handle(ctx: &Ctx, mut s: TcpStream) -> std::io::Result<()> {
    s.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    s.set_nodelay(true)?;
    let mut r = BufReader::new(s.try_clone()?);
    while request(ctx, &mut r, &mut s)? {}
    Ok(())
}

/// Eine Anfrage beantworten. `false` = Verbindung nicht weiter lesen.
fn request(ctx: &Ctx, r: &mut BufReader<TcpStream>, s: &mut TcpStream) -> std::io::Result<bool> {
    let mut line = String::new();
    if r.read_line(&mut line)? == 0 {
        return Ok(false);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 || h.trim_end().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));

    let origin = headers.get("origin").map(String::as_str);
    if origin.is_some_and(|o| !ctx.origins.iter().any(|x| x == o)) {
        respond(s, 403, "text/plain", b"forbidden", None)?;
        return Ok(false);
    }
    if method == "OPTIONS" {
        return respond(s, 204, "text/plain", b"", origin).map(|()| true);
    }
    let authed = headers.get("x-token") == Some(&ctx.token)
        || query.split('&').any(|kv| kv.strip_prefix("token=") == Some(ctx.token.as_str()));

    // Einmal-Token aus der URL gegen den Sitzungs-Token tauschen
    if path == "/session" && method == "POST" {
        let boot = headers.get("x-boot").cloned().unwrap_or_default();
        let mut list = ctx.boot.lock().unwrap();
        let Some(i) = list.iter().position(|b| *b == boot) else {
            return respond(s, 403, "text/plain", b"forbidden", origin).map(|()| true);
        };
        list.remove(i);
        return respond(s, 200, "application/json", json!(ctx.token).to_string().as_bytes(), origin).map(|()| true);
    }

    if path == "/events" {
        if !authed {
            return respond(s, 403, "text/plain", b"forbidden", origin).map(|()| true);
        }
        let mut head = String::from("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n");
        if let Some(o) = origin {
            head.push_str(&format!("Access-Control-Allow-Origin: {o}\r\n"));
        }
        head.push_str("\r\n: ok\n\n");
        s.write_all(head.as_bytes())?;
        ctx.clients.lock().unwrap().push(s.try_clone()?);
        return Ok(false);
    }

    if let Some(cmd) = path.strip_prefix("/api/") {
        if !authed {
            return respond(s, 403, "text/plain", b"forbidden", origin).map(|()| true);
        }
        if method != "POST" {
            return respond(s, 405, "text/plain", b"", origin).map(|()| true);
        }
        let len = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
        if len > MAX_BODY {
            return respond(s, 400, "text/plain", b"too large", origin).map(|()| true);
        }
        let mut body = vec![0; len];
        r.read_exact(&mut body)?;
        let args: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
        let (code, out) = match crate::dispatch(&ctx.app, cmd, args) {
            Ok(v) => (200, v),
            Err(e) => (400, Value::String(e)),
        };
        return respond(s, code, "application/json", out.to_string().as_bytes(), origin).map(|()| true);
    }

    if method != "GET" {
        return respond(s, 405, "text/plain", b"", None).map(|()| true);
    }
    let file = if path == "/" { "/index.html" } else { path };
    match ctx.app.asset_resolver().get(file.to_string()) {
        Some(a) => respond(s, 200, &a.mime_type, &a.bytes, None)?,
        None => respond(s, 404, "text/plain", b"not found", None)?,
    }
    Ok(true)
}
