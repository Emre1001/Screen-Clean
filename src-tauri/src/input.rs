//! Remote-Input: Maus & Tastatur über enigo.
//!
//! enigo lebt auf einem eigenen Thread (nicht überall `Send`), Befehle kommen
//! per Channel. Ein globaler Kill-Switch (`enabled`) blockt jede Injection
//! unabhängig vom Frontend – Strg+Shift+X schaltet ihn direkt in Rust ab.

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, Deserialize, serde::Serialize, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Ein Eingabe-Ereignis vom steuernden Viewer. Koordinaten normalisiert (0..1)
/// relativ zum geteilten Monitor. `m` = [Strg, Shift, Alt, Meta].
#[derive(Debug, Deserialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum InputEvent {
    Move { x: f64, y: f64 },
    Btn { b: u8, down: bool },
    Wheel { dx: i32, dy: i32 },
    Key { key: String, down: bool, #[serde(default)] m: [bool; 4] },
    Mods { m: [bool; 4] },
    Text { s: String },
    Combo { keys: Vec<String> },
}

enum Cmd {
    Event(InputEvent),
    Target(Rect),
    ReleaseAll,
}

pub struct InputState {
    tx: Mutex<Sender<Cmd>>,
    enabled: AtomicBool,
    last_error: Arc<Mutex<Option<String>>>,
}

const MODS: [Key; 4] = [Key::Control, Key::Shift, Key::Alt, Key::Meta];

impl InputState {
    pub fn spawn() -> Self {
        let (tx, rx) = channel::<Cmd>();
        let last_error = Arc::new(Mutex::new(None));
        let err = last_error.clone();
        std::thread::Builder::new()
            .name("input".into())
            .spawn(move || {
                let mut enigo: Option<Enigo> = None;
                let mut target = Rect { x: 0, y: 0, w: 1920, h: 1080 };
                let mut mods = [false; 4];
                let mut buttons = [false; 5];
                // Alles abholen, was schon wartet, und Mausbewegungen zusammenfassen:
                // bei Rückstau zählt nur die letzte Position (weniger Latenz).
                while let Ok(first) = rx.recv() {
                    let mut batch = vec![first];
                    batch.extend(rx.try_iter());
                    for cmd in coalesce(batch) {
                        if let Cmd::Target(r) = cmd {
                            target = r;
                            continue;
                        }
                        if enigo.is_none() {
                            match new_enigo() {
                                Ok(e) => enigo = Some(e),
                                Err(e) => {
                                    crate::log::write("error", &format!("Eingabe nicht verfügbar: {e}"));
                                    *err.lock().unwrap() = Some(e);
                                    continue;
                                }
                            }
                        }
                        let en = enigo.as_mut().unwrap();
                        let res = match cmd {
                            Cmd::ReleaseAll => {
                                release_all(en, &mut mods, &mut buttons);
                                Ok(())
                            }
                            Cmd::Event(ev) => apply(en, ev, &target, &mut mods, &mut buttons),
                            Cmd::Target(_) => unreachable!(),
                        };
                        if let Err(e) = res {
                            // Verbindung zum Display neu aufbauen (z. B. nach Sperrbildschirm)
                            crate::log::write("warn", &format!("Eingabe fehlgeschlagen, neu verbinden: {e}"));
                            *err.lock().unwrap() = Some(e.to_string());
                            enigo = None;
                        }
                    }
                }
            })
            .expect("input thread");
        Self { tx: Mutex::new(tx), enabled: AtomicBool::new(false), last_error }
    }

    fn send(&self, cmd: Cmd) {
        let _ = self.tx.lock().unwrap().send(cmd);
    }

    pub fn disable(&self) {
        self.enabled.store(false, Ordering::SeqCst);
        self.send(Cmd::ReleaseAll);
    }
}

fn coalesce(cmds: Vec<Cmd>) -> Vec<Cmd> {
    let mut out: Vec<Cmd> = Vec::with_capacity(cmds.len());
    for cmd in cmds {
        if let (Cmd::Event(InputEvent::Move { .. }), Some(Cmd::Event(InputEvent::Move { .. }))) = (&cmd, out.last()) {
            out.pop();
        }
        out.push(cmd);
    }
    out
}

fn new_enigo() -> Result<Enigo, String> {
    let settings = Settings { linux_delay: 1, ..Settings::default() };
    Enigo::new(&settings).map_err(|e| e.to_string())
}

fn apply(
    en: &mut Enigo,
    ev: InputEvent,
    t: &Rect,
    mods: &mut [bool; 4],
    buttons: &mut [bool; 5],
) -> enigo::InputResult<()> {
    match ev {
        InputEvent::Move { x, y } => {
            if !x.is_finite() || !y.is_finite() {
                return Ok(());
            }
            let px = t.x + (x.clamp(0.0, 1.0) * (t.w - 1).max(0) as f64).round() as i32;
            let py = t.y + (y.clamp(0.0, 1.0) * (t.h - 1).max(0) as f64).round() as i32;
            en.move_mouse(px, py, Coordinate::Abs)
        }
        InputEvent::Btn { b, down } => {
            let Some(btn) = button(b) else { return Ok(()) };
            buttons[b as usize] = down;
            en.button(btn, dir(down))
        }
        InputEvent::Wheel { dx, dy } => {
            if dy != 0 {
                en.scroll(dy.clamp(-20, 20), Axis::Vertical)?;
            }
            if dx != 0 {
                en.scroll(dx.clamp(-20, 20), Axis::Horizontal)?;
            }
            Ok(())
        }
        InputEvent::Mods { m } => sync_mods(en, mods, m),
        InputEvent::Key { key, down, m } => {
            let Some(k) = parse_key(&key) else { return Ok(()) };
            sync_mods(en, mods, m)?;
            en.key(k, dir(down))
        }
        InputEvent::Text { s } => {
            // Text kommt ohne Modifier (z. B. AltGr-Zeichen) – sonst würde Strg+Alt mitgehen.
            sync_mods(en, mods, [false; 4])?;
            let s: String = s.chars().take(64).collect();
            en.text(&s)
        }
        InputEvent::Combo { keys } => {
            let keys: Vec<Key> = keys.iter().take(5).filter_map(|k| parse_key(k)).collect();
            sync_mods(en, mods, [false; 4])?;
            for k in &keys {
                en.key(*k, Direction::Press)?;
            }
            for k in keys.iter().rev() {
                en.key(*k, Direction::Release)?;
            }
            Ok(())
        }
    }
}

fn sync_mods(en: &mut Enigo, held: &mut [bool; 4], want: [bool; 4]) -> enigo::InputResult<()> {
    for i in 0..4 {
        if held[i] != want[i] {
            en.key(MODS[i], dir(want[i]))?;
            held[i] = want[i];
        }
    }
    Ok(())
}

fn release_all(en: &mut Enigo, mods: &mut [bool; 4], buttons: &mut [bool; 5]) {
    let _ = sync_mods(en, mods, [false; 4]);
    for (i, held) in buttons.iter_mut().enumerate() {
        if *held {
            if let Some(b) = button(i as u8) {
                let _ = en.button(b, Direction::Release);
            }
            *held = false;
        }
    }
}

fn dir(down: bool) -> Direction {
    if down { Direction::Press } else { Direction::Release }
}

/// JS `MouseEvent.button` → enigo.
fn button(b: u8) -> Option<Button> {
    Some(match b {
        0 => Button::Left,
        1 => Button::Middle,
        2 => Button::Right,
        3 => Button::Back,
        4 => Button::Forward,
        _ => return None,
    })
}

/// JS `KeyboardEvent.key` → enigo. Unbekanntes wird verworfen (Trust-Boundary).
pub fn parse_key(s: &str) -> Option<Key> {
    let mut chars = s.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return Some(if c == ' ' { Key::Space } else { Key::Unicode(c) });
    }
    Some(match s {
        "Enter" => Key::Return,
        "Tab" => Key::Tab,
        "Backspace" => Key::Backspace,
        "Escape" => Key::Escape,
        "Delete" => Key::Delete,
        #[cfg(not(target_os = "macos"))]
        "Insert" => Key::Insert,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "CapsLock" => Key::CapsLock,
        "Control" => Key::Control,
        "Shift" => Key::Shift,
        "Alt" => Key::Alt,
        "Meta" => Key::Meta,
        "PrintScreen" => Key::PrintScr,
        #[cfg(not(target_os = "macos"))]
        "Pause" => Key::Pause,
        #[cfg(not(target_os = "macos"))]
        "NumLock" => Key::Numlock,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => return None,
    })
}

#[tauri::command]
pub fn input_send(state: tauri::State<InputState>, events: Vec<InputEvent>) {
    if !state.enabled.load(Ordering::SeqCst) {
        return;
    }
    for ev in events.into_iter().take(256) {
        state.send(Cmd::Event(ev));
    }
}

#[tauri::command]
pub fn input_enable(state: tauri::State<InputState>, enabled: bool) {
    if enabled {
        state.enabled.store(true, Ordering::SeqCst);
    } else {
        state.disable();
    }
}

#[tauri::command]
pub fn input_target(state: tauri::State<InputState>, rect: Rect) -> Result<(), String> {
    if rect.w <= 0 || rect.h <= 0 {
        return Err("ungültiger Bereich".into());
    }
    state.send(Cmd::Target(rect));
    Ok(())
}

/// Für den System-Check: kann enigo überhaupt Eingaben erzeugen?
#[tauri::command]
pub fn input_check(state: tauri::State<InputState>) -> Result<String, String> {
    if let Some(e) = state.last_error.lock().unwrap().clone() {
        return Err(e);
    }
    new_enigo()?;
    if std::env::var("XDG_SESSION_TYPE").map(|s| s == "wayland").unwrap_or(false) {
        return Ok("wayland".into());
    }
    Ok("ok".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert!(matches!(parse_key("a"), Some(Key::Unicode('a'))));
        assert!(matches!(parse_key(" "), Some(Key::Space)));
        assert!(matches!(parse_key("Enter"), Some(Key::Return)));
        assert!(matches!(parse_key("F12"), Some(Key::F12)));
        assert!(parse_key("rm -rf").is_none());
        assert!(parse_key("").is_none());
    }

    #[test]
    fn coalesces_consecutive_moves_only() {
        let mv = |x| Cmd::Event(InputEvent::Move { x, y: 0.0 });
        let out = coalesce(vec![mv(0.1), mv(0.2), Cmd::Event(InputEvent::Btn { b: 0, down: true }), mv(0.3), mv(0.4), mv(0.5)]);
        assert_eq!(out.len(), 3);
        assert!(matches!(out[0], Cmd::Event(InputEvent::Move { x, .. }) if x == 0.2));
        assert!(matches!(out[2], Cmd::Event(InputEvent::Move { x, .. }) if x == 0.5));
    }

    #[test]
    fn events_deserialize() {
        let ev: InputEvent = serde_json::from_str(r#"{"k":"key","key":"c","down":true,"m":[true,false,false,false]}"#).unwrap();
        assert!(matches!(ev, InputEvent::Key { down: true, m: [true, false, false, false], .. }));
        let ev: InputEvent = serde_json::from_str(r#"{"k":"move","x":0.5,"y":1.0}"#).unwrap();
        assert!(matches!(ev, InputEvent::Move { .. }));
        assert!(serde_json::from_str::<InputEvent>(r#"{"k":"exec","cmd":"x"}"#).is_err());
    }
}
