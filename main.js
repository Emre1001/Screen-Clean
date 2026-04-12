const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences, globalShortcut, Tray, Menu } = require('electron');
const path = require('path');

let mainWindow;
let tray;
let isQuitting = false;

try {
    robot = require('robotjs');
    console.log("robotjs geladen: Fernsteuerung aktiv!");
} catch (e) {
    console.warn("robotjs nicht installiert. Fernsteuerung ist deaktivert.", e.message);
}

function createTray() {
    tray = new Tray(path.join(__dirname, 'icon.png')); // Placeholder for icon
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Öffnen', click: () => mainWindow.show() },
        { label: 'Beenden', click: () => {
            isQuitting = true;
            app.quit();
        }}
    ]);
    tray.setToolTip('Screen-Clean');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => mainWindow.show());
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        frame: false, 
        transparent: true,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

app.whenReady().then(() => {
    createWindow();
    createTray(); 

    // Startup Shortcut: Alt+Shift+S to focus the app
    globalShortcut.register('Alt+Shift+S', () => {
        if (mainWindow) {
            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.show();
                mainWindow.focus();
            }
        }
    });

    globalShortcut.register('CommandOrControl+Shift+X', () => {
        if (BrowserWindow.getAllWindows().length > 0) {
            BrowserWindow.getAllWindows()[0].webContents.send('global-shortcut', 'stop');
        }
    });

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// Window controls
ipcMain.on('window-control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') {
        if (win.isMaximized()) {
            win.unmaximize();
        } else {
            win.maximize();
        }
    }
    if (action === 'close') win.close();
});

// Screen sharing source
ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources;
});

ipcMain.on('input-event', async (event, type, data) => {
    if (!robot) return;
    try {
        if (type === 'mousemove') {
            const screenSize = robot.getScreenSize();
            // data.x and data.y are relative mapping (0 to 1)
            const absoluteX = Math.round(data.x * screenSize.width);
            const absoluteY = Math.round(data.y * screenSize.height);
            robot.moveMouse(absoluteX, absoluteY);
        } else if (type === 'mousedown') {
            const btn = data.button === 0 ? 'left' : (data.button === 2 ? 'right' : 'middle');
            robot.mouseToggle("down", btn);
        } else if (type === 'mouseup') {
            const btn = data.button === 0 ? 'left' : (data.button === 2 ? 'right' : 'middle');
            robot.mouseToggle("up", btn);
        } else if (type === 'keydown') {
            let k = mapRobotKey(data.key);
            if (k) robot.keyToggle(k, "down");
        } else if (type === 'keyup') {
            let k = mapRobotKey(data.key);
            if (k) robot.keyToggle(k, "up");
        }
    } catch (err) {
        console.error("Input Event Error: ", err);
    }
});

function mapRobotKey(key) {
    if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) return key.toLowerCase();
    const map = {
        'Enter': 'enter',
        'Escape': 'escape',
        'Backspace': 'backspace',
        'Tab': 'tab',
        ' ': 'space',
        'Shift': 'shift',
        'Control': 'control',
        'Alt': 'alt',
        'ArrowUp': 'up',
        'ArrowDown': 'down',
        'ArrowLeft': 'left',
        'ArrowRight': 'right'
    };
    return map[key] || null;
}
