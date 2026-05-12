# Screen-Clean v2.0

> **P2P Screen Sharing & Remote Control mit Multi-Viewer Support**

Screen-Clean ist eine Electron-App fuer verlustfreies Screen-Sharing, Fernsteuerung und Zusammenarbeit. Mehrere Personen koennen gleichzeitig zuschauen, der Host waehlt wer steuert, und alle sehen die Cursor der anderen.

![Version](https://img.shields.io/badge/Version-2.0.0-blueviolet?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)
![Platform](https://img.shields.io/badge/Platform-Windows-blue?style=for-the-badge)

---

## Features

**Streaming**
- Bis zu 120 FPS Screen-Sharing via WebRTC (P2P, kein Server)
- H.264 (NVENC) oder VP8 Codec
- Audio-Uebertragung
- Dynamische Qualitaetsanpassung (Aufloesung, FPS, Bitrate)

**Multi-Viewer**
- Mehrere Personen koennen gleichzeitig beitreten
- Teilnehmer-Panel zeigt alle Viewer mit Farben und Namen
- Host sieht wer verbunden ist und kann Viewer trennen

**Fernsteuerung**
- Host waehlt wer den PC steuern darf
- Maus, Tastatur, Scrollrad und Modifier-Keys (Strg+C, Alt+Tab, etc.)
- Steuerungsanfrage: Viewer kann Kontrolle anfordern, Host entscheidet
- Steuerungs-Richtlinie: Immer fragen / Automatisch erlauben / Immer ablehnen

**Cursor-Sharing**
- Alle Viewer sehen die Cursor der anderen in Echtzeit
- Jeder Cursor hat eigene Farbe + Namenslabel
- Wer gerade steuert wird mit Gamepad-Icon markiert

**Namen & Verlauf**
- Host und Viewer koennen eigene Namen eingeben
- Letzte Verbindungen werden gespeichert
- Ein Klick um alte Verbindungen erneut zu joinen

**UI**
- Glassmorphism Design mit Animationen
- Toast-Benachrichtigungen fuer alle Events
- Einstellungen persistent ueber Neustarts
- Tray-Icon, globale Shortcuts, Vollbild-Modus

---

## Shortcuts

| Aktion | Shortcut |
|--------|----------|
| App ein-/ausblenden | `Alt + Shift + S` |
| Stopp / Trennen | `Strg + Shift + X` |

---

## Installation

```bash
git clone <repo-url>
cd Screen-Clean
npm install
```

### Starten
```bash
npm start
```

### .exe bauen
```bash
npm run build
```
Die portable .exe liegt dann in `/dist`.

---

## Technik

| Komponente | Technologie |
|-----------|------------|
| Desktop | Electron 41 |
| Streaming | WebRTC (PeerJS) |
| Fernsteuerung | robotjs |
| Signaling | 0.peerjs.com (STUN/ICE) |
| UI | Vanilla JS + CSS3 |

---

## Verbindungsablauf

1. Host startet App → bekommt 12-stelligen Code
2. Viewer gibt Code ein oder waehlt aus WLAN-Erkennung / Verlauf
3. Host bestaetigt Anfrage, waehlt Monitor
4. Stream startet, Viewer sieht Bildschirm
5. Viewer fordert Steuerung an → Host erlaubt/verweigert
6. Alle sehen Cursor der anderen Teilnehmer

---

## Einstellungen

- **Audio**: System-Audio mitstreamen
- **Fernsteuerung**: Erlauben/Verbieten + Richtlinie (fragen/auto/nie)
- **Cursor**: Remote-Cursor ein/ausblenden
- **Performance**: Voll-Automatik / Slider / Manuell (Aufloesung, FPS, Bitrate)
- **Codec**: H.264 (NVENC) oder VP8
- **Laptop-Modus**: Reduziert auf 480p/15fps
- **GPU-Kompatibilitaet**: Hardware-Beschleunigung deaktivieren bei Blackscreen
- **Verlauf**: Verbindungsverlauf loeschen

---

## Troubleshooting

**Schwarzer Bildschirm**: Einstellungen → Kompatibilitaets-Modus aktivieren (startet App neu ohne GPU)

**Bitrate 0**: Firewall blockiert WebRTC. Windows Firewall → Screen-Clean erlauben.

**Fernsteuerung geht nicht**: robotjs muss installiert sein (`npm install`). Pruefen ob Toggle aktiv.

**Code besetzt**: Code neu generieren mit dem Refresh-Button.

---

MIT License
