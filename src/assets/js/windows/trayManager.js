const { app, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const path = require('path');

let tray = null;
let mainWindowGetter = null;
let hasShownBalloon = false;

function createTray(getMainWindow) {
    if (tray) return tray;
    mainWindowGetter = getMainWindow;

    const iconPath = path.join(__dirname, '../../images/icon', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    
    let icon;
    try {
        icon = nativeImage.createFromPath(iconPath);
        if (icon.isEmpty()) {
            icon = nativeImage.createFromPath(path.join(__dirname, '../../images/icon/icon.png'));
        }
    } catch (e) {
        console.error('[Tray] Icon load error:', e);
    }

    tray = new Tray(icon);
    tray.setToolTip('RXLauncher');

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'RXLauncher',
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Ouvrir le Launcher',
            click: () => {
                showWindow();
            }
        },
        {
            label: 'Site Officiel (rxcorp.me)',
            click: () => {
                shell.openExternal('https://rxcorp.me');
            }
        },
        {
            label: 'Panel Cloud (panel.rxcorp.me)',
            click: () => {
                shell.openExternal('https://panel.rxcorp.me');
            }
        },
        { type: 'separator' },
        {
            label: 'Quitter RXLauncher',
            click: () => {
                app.isQuitting = true;
                if (mainWindowGetter) {
                    const win = mainWindowGetter();
                    if (win) win.destroy();
                }
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        toggleWindow();
    });

    tray.on('double-click', () => {
        showWindow();
    });

    return tray;
}

function showWindow() {
    const win = mainWindowGetter ? mainWindowGetter() : null;
    if (win) {
        if (!win.isVisible()) win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
    }
}

function hideWindow(showNotif = true) {
    const win = mainWindowGetter ? mainWindowGetter() : null;
    if (win) {
        win.hide();
        if (showNotif && !hasShownBalloon && Notification && Notification.isSupported()) {
            hasShownBalloon = true;
            try {
                const notif = new Notification({
                    title: 'RXLauncher Réduit',
                    body: 'Le launcher reste actif en arrière-plan dans la barre des tâches.',
                    icon: path.join(__dirname, '../../images/icon/icon.png'),
                    silent: true
                });
                notif.on('click', () => showWindow());
                notif.show();
            } catch (e) {}
        }
    }
}

function toggleWindow() {
    const win = mainWindowGetter ? mainWindowGetter() : null;
    if (win) {
        if (win.isVisible()) {
            hideWindow(false);
        } else {
            showWindow();
        }
    }
}

function destroyTray() {
    if (tray) {
        tray.destroy();
        tray = null;
    }
}

module.exports = {
    createTray,
    showWindow,
    hideWindow,
    toggleWindow,
    destroyTray
};
