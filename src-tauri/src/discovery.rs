//! LAN-Erkennung per UDP-Broadcast-Beacon.
//!
//! Jede Instanz sendet alle 2 s ein kleines JSON an alle Broadcast-Adressen
//! und meldet empfangene Beacons ans Frontend (`lan:peer`).

use serde_json::Value;
use socket2::{Domain, Protocol, Socket, Type};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const PORT: u16 = 47821;
const APP: &str = "screen-clean";

#[derive(Default)]
pub struct Discovery {
    beacon: Arc<Mutex<Option<Value>>>,
    socket: Mutex<Option<Arc<UdpSocket>>>,
    error: Mutex<Option<String>>,
}

fn bind() -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    #[cfg(all(unix, not(target_os = "solaris")))]
    s.set_reuse_port(true)?;
    s.set_broadcast(true)?;
    s.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, PORT)).into())?;
    Ok(s.into())
}

fn broadcast_targets() -> Vec<SocketAddr> {
    let mut out = vec![SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::BROADCAST, PORT))];
    if let Ok(ifs) = if_addrs::get_if_addrs() {
        for i in ifs {
            if let if_addrs::IfAddr::V4(v4) = i.addr {
                if let (false, Some(b)) = (v4.ip.is_loopback(), v4.broadcast) {
                    let a = SocketAddr::V4(SocketAddrV4::new(b, PORT));
                    if !out.contains(&a) {
                        out.push(a);
                    }
                }
            }
        }
    }
    out
}

fn send(sock: &UdpSocket, payload: &Value) {
    let bytes = payload.to_string();
    for t in broadcast_targets() {
        let _ = sock.send_to(bytes.as_bytes(), t);
    }
}

impl Discovery {
    pub fn start(&self, app: AppHandle) {
        let sock = match bind() {
            Ok(s) => Arc::new(s),
            Err(e) => {
                let msg = format!("UDP-Port {PORT}: {e}");
                crate::log::emit(&app, "warn", format!("WLAN-Erkennung aus – {msg}"));
                *self.error.lock().unwrap() = Some(msg);
                return;
            }
        };
        *self.socket.lock().unwrap() = Some(sock.clone());

        let beacon = self.beacon.clone();
        let tx = sock.clone();
        std::thread::spawn(move || loop {
            if let Some(b) = beacon.lock().unwrap().clone() {
                send(&tx, &b);
            }
            std::thread::sleep(Duration::from_secs(2));
        });

        std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            loop {
                let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
                let Ok(mut v) = serde_json::from_slice::<Value>(&buf[..n]) else { continue };
                if v.get("app").and_then(Value::as_str) != Some(APP) {
                    continue;
                }
                v["ip"] = Value::String(from.ip().to_string());
                let _ = app.emit("lan:peer", v);
            }
        });
    }
}

/// Beacon setzen (`None` = unsichtbar). Beim Abschalten geht ein `bye` raus.
#[tauri::command]
pub fn discovery_set(state: tauri::State<Discovery>, beacon: Option<Value>) {
    let mut cur = state.beacon.lock().unwrap();
    if beacon.is_none() {
        if let (Some(old), Some(sock)) = (cur.as_ref(), state.socket.lock().unwrap().as_ref()) {
            let mut bye = old.clone();
            bye["bye"] = Value::Bool(true);
            send(sock, &bye);
        }
    }
    *cur = beacon.map(|mut b| {
        b["app"] = Value::String(APP.into());
        b
    });
}

#[tauri::command]
pub fn discovery_status(state: tauri::State<Discovery>) -> Result<u16, String> {
    match state.error.lock().unwrap().clone() {
        Some(e) => Err(e),
        None => Ok(PORT),
    }
}
