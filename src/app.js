/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, BrowserWindow, ipcMain, nativeTheme, Notification, dialog, shell } = require('electron');
const { Microsoft } = require('minecraft-java-core');
const { autoUpdater } = require('electron-updater');
const http = require('http');

try {
    app.setAppUserModelId("RXCORP.Launcher");
} catch (e) {}

try {
    app.setAsDefaultProtocolClient('rxcorp');
} catch (e) {}

const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const UpdateWindow = require("./assets/js/windows/updateWindow.js");
const MainWindow = require("./assets/js/windows/mainWindow.js");
const SplashWindow = require("./assets/js/windows/splashWindow.js");
const discordRpc = require("./assets/js/utils/discordRpc.js");
const trayManager = require("./assets/js/windows/trayManager.js");
const DevTerminalWindow = require("./assets/js/windows/devTerminalWindow.js");

let dev = process.env.NODE_ENV === 'dev' || !app.isPackaged;

if (dev) {
    let appPath = path.resolve('./data/Launcher').replace(/\\/g, '/');
    let appdata = path.resolve('./data').replace(/\\/g, '/');
    if (!fs.existsSync(appPath)) fs.mkdirSync(appPath, { recursive: true });
    if (!fs.existsSync(appdata)) fs.mkdirSync(appdata, { recursive: true });
    app.setPath('userData', appPath);
    app.setPath('appData', appdata)
}

Store.initRenderer();

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', (event, commandLine) => {
        let win = MainWindow.getWindow() || UpdateWindow.getWindow();
        if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
        if (Array.isArray(commandLine)) {
            const deepLink = commandLine.find(arg => arg.startsWith('rxcorp://'));
            if (deepLink) handleProtocolUrl(deepLink);
        }
    });

    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleProtocolUrl(url);
    });

    app.whenReady().then(() => {
        try {
            discordRpc.init();
        } catch (e) {
            console.error('[Discord RPC] Init error:', e);
        }
        try {
            trayManager.createTray(() => MainWindow.getWindow());
        } catch (e) {
            console.error('[Tray] Init error:', e);
        }

        // Show splash first, then main window
        SplashWindow.createSplash();
        
        // Small delay then create main window (hidden initially)
        setTimeout(() => {
            MainWindow.createWindowHidden(() => {
                // Called when main window is ready-to-show
                SplashWindow.closeSplash();
            });
            setTimeout(checkLauncherUpdates, 3000);
            setInterval(checkLauncherUpdates, 15 * 60 * 1000);
        }, 600);
    });
}

ipcMain.on('main-window-open', () => MainWindow.createWindow())
ipcMain.on('main-window-dev-tools', () => MainWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('main-window-dev-tools-close', () => MainWindow.getWindow().webContents.closeDevTools())
ipcMain.on('main-window-close', () => MainWindow.destroyWindow())
ipcMain.on('main-window-reload', () => MainWindow.getWindow().reload())
ipcMain.on('main-window-progress', (event, options) => MainWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('main-window-progress-reset', () => MainWindow.getWindow().setProgressBar(-1))
ipcMain.on('main-window-progress-load', () => MainWindow.getWindow().setProgressBar(2))
ipcMain.on('main-window-minimize', () => trayManager.hideWindow(true))

ipcMain.on('update-window-close', () => UpdateWindow.destroyWindow())
ipcMain.on('update-window-dev-tools', () => UpdateWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('update-window-progress', (event, options) => UpdateWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('update-window-progress-reset', () => UpdateWindow.getWindow().setProgressBar(-1))
ipcMain.on('update-window-progress-load', () => UpdateWindow.getWindow().setProgressBar(2))

ipcMain.handle('path-user-data', () => app.getPath('userData'))
ipcMain.handle('appData', e => app.getPath('appData'))

// Dev Terminal Window IPC
ipcMain.on('dev-terminal-open', () => DevTerminalWindow.openTerminal());
ipcMain.on('dev-terminal-toggle', () => DevTerminalWindow.toggleTerminal());
ipcMain.on('dev-terminal-close', () => DevTerminalWindow.closeTerminal());
ipcMain.on('dev-terminal-minimize', () => {
    const win = DevTerminalWindow.getWindow();
    if (win && !win.isDestroyed()) win.minimize();
});
ipcMain.on('dev-terminal-maximize', () => {
    const win = DevTerminalWindow.getWindow();
    if (win && !win.isDestroyed()) {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    }
});
ipcMain.on('dev-terminal-set-always-on-top', (event, flag) => DevTerminalWindow.setAlwaysOnTop(flag));
ipcMain.handle('dev-terminal-get-history', () => DevTerminalWindow.getLogHistory());
ipcMain.on('dev-terminal-clear', () => DevTerminalWindow.clearLogHistory());
ipcMain.on('dev-terminal-broadcast', (event, logEntry) => {
    DevTerminalWindow.broadcastLog(logEntry);
});

ipcMain.on('main-window-maximize', () => {
    if (MainWindow.getWindow().isMaximized()) {
        MainWindow.getWindow().unmaximize();
    } else {
        MainWindow.getWindow().maximize();
    }
})

ipcMain.on('main-window-hide', () => trayManager.hideWindow(false))
ipcMain.on('main-window-show', () => trayManager.showWindow())

ipcMain.on('send-notification', (event, data) => {
    if (Notification && Notification.isSupported()) {
        try {
            const notif = new Notification({
                title: data.title || 'RXLauncher',
                body: data.body || '',
                icon: path.join(__dirname, 'assets/images/icon/icon.png'),
                silent: data.silent === true
            });
            notif.on('click', () => {
                let win = MainWindow.getWindow() || UpdateWindow.getWindow();
                if (win) {
                    if (win.isMinimized()) win.restore();
                    win.show();
                    win.focus();
                }
            });
            notif.show();
        } catch (err) {
            console.error('[Notification Error]:', err);
        }
    }
});

ipcMain.on('discord-rpc-activity', (event, data) => discordRpc.setActivity(data));
ipcMain.on('discord-rpc-idle', () => discordRpc.setIdle());
ipcMain.on('discord-rpc-launching', (event, targetName) => discordRpc.setLaunching(targetName));
ipcMain.on('discord-rpc-playing', (event, instanceName) => discordRpc.setPlaying(instanceName));

ipcMain.handle('Microsoft-window', async (_, client_id = "00000000402b5328") => {
    try {
        const ms = new Microsoft(client_id);
        const redirectUri = "https://login.live.com/oauth20_desktop.srf";
        const authUrl = `https://login.live.com/oauth20_authorize.srf?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=XboxLive.signin%20offline_access&cobrandid=8058f65d-ce06-4c30-9559-473c9275a65d`;

        const authWindow = new BrowserWindow({
            title: "Connexion Compte Microsoft // RXCORP",
            width: 680,
            height: 720,
            minWidth: 480,
            minHeight: 560,
            center: true,
            resizable: true,
            backgroundColor: '#090b10',
            icon: path.join(__dirname, 'assets/images/icon/icon.png'),
            webPreferences: {
                partition: 'persist:minecraft_auth', // Conserve la session & cookies Microsoft
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        authWindow.setMenu(null);

        return await new Promise((resolve, reject) => {
            let isDone = false;

            const handleUrl = (targetUrl) => {
                if (!targetUrl || isDone) return;
                if (targetUrl.startsWith(redirectUri)) {
                    isDone = true;
                    try {
                        const urlObj = new URL(targetUrl);
                        const code = urlObj.searchParams.get('code');
                        const error = urlObj.searchParams.get('error');

                        try {
                            if (!authWindow.isDestroyed()) authWindow.close();
                        } catch (e) {}

                        if (code) {
                            ms.exchangeCodeForToken(code)
                                .then(accountData => resolve(accountData))
                                .catch(err => reject(err));
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        try { if (!authWindow.isDestroyed()) authWindow.close(); } catch (err) {}
                        reject(e);
                    }
                }
            };

            authWindow.webContents.on('will-redirect', (event, newUrl) => handleUrl(newUrl));
            authWindow.webContents.on('did-navigate', (event, newUrl) => handleUrl(newUrl));
            authWindow.webContents.on('did-finish-load', () => {
                if (!authWindow.isDestroyed()) {
                    handleUrl(authWindow.webContents.getURL());
                }
            });

            authWindow.on('closed', () => {
                if (!isDone) {
                    isDone = true;
                    resolve(null);
                }
            });

            authWindow.loadURL(authUrl);
        });
    } catch (err) {
        console.error('[Microsoft Auth Error]:', err);
        throw err;
    }
});

ipcMain.handle('is-dark-theme', (_, theme) => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return nativeTheme.shouldUseDarkColors;
})

app.on('window-all-closed', () => {
    try {
        discordRpc.destroy();
    } catch (e) {}
    try {
        trayManager.destroyTray();
    } catch (e) {}
    app.quit();
});

autoUpdater.logger = console;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
}

autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://rxcorp.me/launcher/update/'
});

let isCheckingManually = false;

function checkLauncherUpdates(manual = false) {
    isCheckingManually = manual;
    console.log(`[AutoUpdater] Checking for updates (manual: ${manual}, isPackaged: ${app.isPackaged})...`);
    const win = MainWindow.getWindow();
    if (win) win.webContents.send('updater-event', { status: 'checking', isManual: manual });

    autoUpdater.checkForUpdates().then(res => {
        console.log('[AutoUpdater] Check complete:', res ? res.updateInfo?.version : 'up to date');
    }).catch(err => {
        console.error('[AutoUpdater] Check error:', err ? err.message : err);
        if (win) win.webContents.send('updater-event', {
            status: 'error',
            error: err ? err.message : 'Erreur inconnue',
            isManual: isCheckingManually
        });
    });
}

ipcMain.on('check-for-update', () => checkLauncherUpdates(true));
ipcMain.on('install-update-now', () => {
    console.log('[AutoUpdater] Applying update now (quitAndInstall)...');
    try {
        setImmediate(() => {
            try {
                autoUpdater.quitAndInstall(false, true);
            } catch (e) {
                app.quit();
            }
        });
    } catch (e) {
        console.error('[AutoUpdater] quitAndInstall error:', e);
        app.quit();
    }
});

autoUpdater.on('checking-for-update', () => {
    const win = MainWindow.getWindow();
    if (win) win.webContents.send('updater-event', { status: 'checking', isManual: isCheckingManually });
});

autoUpdater.on('update-available', (info) => {
    const win = MainWindow.getWindow();
    const ver = info ? info.version : '';
    console.log('[AutoUpdater] Update available:', ver);
    if (win) win.webContents.send('updater-event', { 
        status: 'available', 
        version: ver,
        currentVersion: app.getVersion(),
        isManual: isCheckingManually 
    });
    if (Notification && Notification.isSupported()) {
        try {
            const notif = new Notification({
                title: 'RXCORP // MISE À JOUR DISPONIBLE',
                body: `La version ${ver} est en cours de téléchargement...`,
                icon: path.join(__dirname, 'assets/images/icon/icon.png')
            });
            notif.show();
        } catch (e) {}
    }
});

autoUpdater.on('update-not-available', (info) => {
    const win = MainWindow.getWindow();
    const ver = info ? info.version : app.getVersion();
    console.log('[AutoUpdater] Update not available. Already at latest:', ver);
    if (win) win.webContents.send('updater-event', { 
        status: 'not-available', 
        version: ver,
        currentVersion: app.getVersion(),
        isManual: isCheckingManually 
    });
});

autoUpdater.on('download-progress', (progress) => {
    const win = MainWindow.getWindow();
    if (win) win.webContents.send('updater-event', {
        status: 'downloading',
        percent: Math.round(progress.percent || 0),
        bytesPerSecond: progress.bytesPerSecond || 0
    });
});

autoUpdater.on('update-downloaded', (info) => {
    const win = MainWindow.getWindow();
    const ver = info ? info.version : '';
    if (win) win.webContents.send('updater-event', { status: 'ready', version: ver });

    // Interactive Dialog prompt directly in app
    try {
        dialog.showMessageBox(win || null, {
            type: 'info',
            buttons: ['Redémarrer maintenant', 'Plus tard'],
            defaultId: 0,
            cancelId: 1,
            title: 'RXLauncher - Mise à jour prête',
            message: `Mise à jour v${ver} téléchargée avec succès !`,
            detail: 'Le launcher va redémarrer pour installer la nouvelle version.'
        }).then(({ response }) => {
            if (response === 0) {
                console.log('[AutoUpdater] User accepted restart dialog -> quitAndInstall');
                setImmediate(() => {
                    try {
                        autoUpdater.quitAndInstall(false, true);
                    } catch (e) {
                        app.quit();
                    }
                });
            }
        }).catch(e => console.error('[Dialog Error]', e));
    } catch (e) {
        console.error('[Dialog Error]', e);
    }

    if (Notification && Notification.isSupported()) {
        try {
            const notif = new Notification({
                title: 'RXCORP // MISE À JOUR PRÊTE !',
                body: `Version ${ver} téléchargée. Cliquez ici pour redémarrer et appliquer.`,
                icon: path.join(__dirname, 'assets/images/icon/icon.png')
            });
            notif.on('click', () => {
                console.log('[AutoUpdater] User clicked notification -> quitAndInstall');
                setImmediate(() => {
                    try {
                        autoUpdater.quitAndInstall(false, true);
                    } catch (e) {
                        app.quit();
                    }
                });
            });
            notif.show();
        } catch (e) {
            console.error('[Notification error]:', e);
        }
    }
});

autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err ? err.message : err);
    const win = MainWindow.getWindow();
    if (win) win.webContents.send('updater-event', { status: 'error', error: err ? err.message : 'Unknown', isManual: isCheckingManually });
});

// ==========================================
// RXCORP CLOUD WEB SSO & LOOPBACK SERVER
// ==========================================
let authLoopbackServer = null;

function handleWebAuthSuccess(token, username, email) {
    if (!token) return;
    console.log('[WebAuth] Successfully linked account:', username, 'token:', token.substring(0, 8) + '...');
    const win = MainWindow.getWindow();
    if (win) {
        win.webContents.send('web-auth-success', { token, username, email });
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
}

function handleProtocolUrl(urlStr) {
    try {
        if (!urlStr || !urlStr.startsWith('rxcorp://')) return;
        const u = new URL(urlStr);
        const token = u.searchParams.get('token');
        const username = u.searchParams.get('username') || '';
        const email = u.searchParams.get('email') || '';
        handleWebAuthSuccess(token, username, email);
    } catch (e) {
        console.error('[Protocol Handler Error]', e);
    }
}

ipcMain.on('start-web-auth', () => {
    if (authLoopbackServer) {
        try { authLoopbackServer.close(); } catch(e) {}
    }

    const state = Math.random().toString(36).substring(2, 15);
    authLoopbackServer = http.createServer((req, res) => {
        try {
            const reqUrl = new URL(req.url, 'http://127.0.0.1');
            if (reqUrl.pathname === '/callback') {
                const token = reqUrl.searchParams.get('token');
                const username = reqUrl.searchParams.get('username') || '';
                const email = reqUrl.searchParams.get('email') || '';

                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Access-Control-Allow-Origin': '*'
                });
                const safeUser = username || 'RXCORP';
                res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>RXCORP</title><style>body{background:#08090d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .box{background:#10131a;border:1px solid #f43f5e;border-radius:12px;padding:32px;text-align:center;box-shadow:0 0 30px rgba(244,63,94,0.3);max-width:400px;} h1{color:#f43f5e;font-size:20px;margin-bottom:10px;} p{color:#94a3b8;font-size:14px;}</style></head><body><div class="box"><h1>Connexion réussie</h1><p>Votre compte <strong>${safeUser}</strong> est connecté au Launcher.</p><p style="color:#64748b;font-size:12px;margin-top:16px;">Vous pouvez fermer cet onglet et revenir sur le Launcher.</p></div><script>setTimeout(()=>{try{window.close();}catch(e){}},2500);</script></body></html>`);

                handleWebAuthSuccess(token, username, email);

                setTimeout(() => {
                    try {
                        if (authLoopbackServer) {
                            authLoopbackServer.close();
                            authLoopbackServer = null;
                        }
                    } catch(e) {}
                }, 3000);
            }
        } catch (err) {
            console.error('[WebAuth Callback Error]', err);
        }
    });

    const PREFERRED_PORT = 45823;
    const startListening = (portToTry) => {
        authLoopbackServer.once('error', (err) => {
            if (err.code === 'EADDRINUSE' && portToTry !== 0) {
                console.log('[WebAuth] Port', portToTry, 'busy, trying ephemeral 0...');
                startListening(0);
            } else {
                console.error('[WebAuth Server Error]', err);
            }
        });

        authLoopbackServer.listen(portToTry, '127.0.0.1', () => {
            const actualPort = authLoopbackServer.address().port;
            const targetUrl = `https://panel.rxcorp.me/launcher/connect?port=${actualPort}&state=${state}`;
            console.log('[WebAuth] Loopback listening on port', actualPort, 'Opening URL:', targetUrl);
            shell.openExternal(targetUrl);
        });
    };

    startListening(PREFERRED_PORT);
});