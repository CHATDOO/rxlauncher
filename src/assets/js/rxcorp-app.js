/**
 * RXCORP Launcher - Master Application Controller
 * Handles UI interactions, services coordination and state management
 * Version 2.4.0
 */

const { ipcRenderer, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');

// Services
const servicesDir = fs.existsSync(path.join(__dirname, 'services'))
    ? path.join(__dirname, 'services')
    : (fs.existsSync(path.join(__dirname, 'assets/js/services')) 
        ? path.join(__dirname, 'assets/js/services') 
        : path.join(__dirname, 'src/assets/js/services'));

const pelicanService = require(path.join(servicesDir, 'pelicanService.js'));
const instanceService = require(path.join(servicesDir, 'instanceService.js'));
const modrinthService = require(path.join(servicesDir, 'modrinthService.js'));
const curseforgeService = require(path.join(servicesDir, 'curseforgeService.js'));
const gameLauncher = require(path.join(servicesDir, 'gameLauncher.js'));
const microsoftAuthService = require(path.join(servicesDir, 'microsoftAuthService.js'));
const modPoolService = require(path.join(servicesDir, 'modPoolService.js'));

const utilsDir = fs.existsSync(path.join(__dirname, 'utils'))
    ? path.join(__dirname, 'utils')
    : (fs.existsSync(path.join(__dirname, 'assets/js/utils')) 
        ? path.join(__dirname, 'assets/js/utils') 
        : path.join(__dirname, 'src/assets/js/utils'));
const i18n = require(path.join(utilsDir, 'i18n.js'));

// Local storage
const store = new Store({
    defaults: {
        panelUrl: 'https://panel.rxcorp.me',
        apiKey: '',
        curseforgeApiKey: '',
        activeInstanceId: null,
        activeCloudInstanceId: null,
        activeLocalInstanceId: null,
        activeDribbbleMode: 'cloud',
        ramMax: 6,
        javaPath: '',
        accounts: [
            {
                name: 'Player',
                uuid: '00000000-0000-0000-0000-000000000000',
                meta: { type: 'Mojang', online: false }
            }
        ],
        activeAccountName: 'Player'
    }
});

class RxcorpApp {
    constructor() {
        let appVer = '2.7.0';
        try {
            const pkg = require('../../../package.json');
            if (pkg && pkg.version) appVer = pkg.version;
        } catch (_) {}
        this.appVersion = appVer;

        this.activeView = 'cloud';
        this.activeDribbbleMode = store.get('activeDribbbleMode') || 'cloud';
        this.activeCloudInstanceId = store.get('activeCloudInstanceId') || null;
        this.activeLocalInstanceId = store.get('activeLocalInstanceId') || null;
        this.activeInstance = null;
        this.cloudServers = [];
        this.isSyncing = false;
        this.syncLogsBuffer = [];
        this.activeModSource = 'modrinth'; // 'modrinth' | 'curseforge'
        this.activeModCategory = '';
    }

    /**
     * Get current active domain based on UI mode ('cloud' | 'local')
     */
    getCurrentDomain() {
        return this.activeDribbbleMode === 'cloud' ? 'cloud' : 'local';
    }

    /**
     * Get active instance for a given domain, with auto-fallback and auto-provisioning
     */
    getActiveInstanceForDomain(domain = null) {
        const d = domain || this.getCurrentDomain();
        let targetId = (d === 'cloud') ? this.activeCloudInstanceId : this.activeLocalInstanceId;

        if (targetId) {
            const inst = instanceService.getInstance(targetId);
            if (inst && inst.domain === d) return inst;
        }

        // Fallback: search existing instances for this domain
        const domainList = instanceService.getInstancesByDomain(d);
        if (domainList.length > 0) {
            const chosen = domainList[0];
            this.setActiveInstanceForDomain(d, chosen.id, false);
            return chosen;
        }

        // Auto-provision a default local instance if none exists
        if (d === 'local') {
            const localInst = instanceService.createInstance({
                name: 'Mon Profil Local 1.21.4',
                version: '1.21.4',
                loader: 'fabric',
                domain: 'local'
            });
            this.setActiveInstanceForDomain('local', localInst.id, false);
            return localInst;
        }

        return null;
    }

    /**
     * Set active instance for a specific domain
     */
    setActiveInstanceForDomain(domain, id, updatePill = true) {
        if (domain === 'cloud') {
            this.activeCloudInstanceId = id;
            store.set('activeCloudInstanceId', id);
        } else {
            this.activeLocalInstanceId = id;
            store.set('activeLocalInstanceId', id);
        }

        const inst = instanceService.getInstance(id);
        if (inst) {
            this.activeInstance = inst;
            store.set('activeInstanceId', id);
        }

        if (updatePill) {
            this.updateDockInstancePill();
        }
    }

    async init() {
        console.log('[RXCORP] Initializing Launcher 2.5...');
        this.initDevTerminalLogger();
        this.initWindowControls();
        this.initI18n();
        this.initDribbbleShell();
        this.initModals();
        this.initSettings();
        this.initAccounts();
        this.initPelicanSync();
        this.initCloudToolbar();
        this.initModDownloader();
        this.initLaunchDock();
        this.initUpdater();
        this.initWebAuth();
        this.initOnboardingWizard();
        this.fetchBootstrapData();

        // Populate all version displays dynamically
        document.querySelectorAll('.app-version-display').forEach(el => {
            el.textContent = `v${this.appVersion}`;
        });
        const appVerLabel = document.getElementById('label-app-version');
        if (appVerLabel) appVerLabel.textContent = `v${this.appVersion}`;

        // Load initial instances
        await this.loadInstances();

        // Load cloud servers
        await this.loadCloudServers();

        // Initial telemetry and public servers status
        this.updatePublicServersStatus();
        this.updateTelemetryConsole();

        // Initial Discord RPC state
        ipcRenderer.send('discord-rpc-idle');

        console.log('[RXLauncher] Launcher ready.');
    }

    // ==========================================
    // GLOBAL DEV TERMINAL & ACTIVITY MONITOR
    // ==========================================
    initDevTerminalLogger() {
        // Toggle button in titlebar
        const btnToggleDev = document.getElementById('btn-open-dev-terminal');
        const checkToggleDev = document.getElementById('toggle-dev-terminal-btn');
        const isDevBtnVisible = store.get('showDevTerminalBtn') === true;

        if (btnToggleDev) {
            btnToggleDev.style.display = isDevBtnVisible ? 'inline-flex' : 'none';
            btnToggleDev.addEventListener('click', () => {
                ipcRenderer.send('dev-terminal-toggle');
                this.logDev('UI', 'Bascule de la fenetre Dev Console via la barre de titre');
            });
        }

        if (checkToggleDev) {
            checkToggleDev.checked = isDevBtnVisible;
            checkToggleDev.addEventListener('change', (e) => {
                const checked = e.target.checked;
                store.set('showDevTerminalBtn', checked);
                if (btnToggleDev) {
                    btnToggleDev.style.display = checked ? 'inline-flex' : 'none';
                }
            });
        }

        // Open button in Settings
        const btnSettingsDev = document.getElementById('btn-settings-open-terminal');
        if (btnSettingsDev) {
            btnSettingsDev.addEventListener('click', () => {
                ipcRenderer.send('dev-terminal-open');
                this.logDev('UI', 'Ouverture de la fenetre Dev Console depuis les Parametres');
            });
        }

        // Keyboard shortcuts (F12 or Ctrl+Shift+D)
        window.addEventListener('keydown', (e) => {
            if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd')) {
                e.preventDefault();
                ipcRenderer.send('dev-terminal-toggle');
                this.logDev('UI', 'Bascule du Terminal Dev (raccourci clavier)');
            }
        });

        // Intercept EVERY user click on the entire document
        document.addEventListener('click', (e) => {
            try {
                const target = e.target.closest('button, a, input, select, [data-view], [data-close], [data-server-id], [data-instance-id], .rail-item, .cloud-server-card, .instance-card, .rx-btn, .pill-btn, .ram-pill-btn, .lang-btn-switch') || e.target;
                if (!target || target === document.body || target === document.documentElement) return;

                let label = '';
                if (target.dataset?.view) {
                    label = `Navigation onglet rail: "${target.dataset.view}"`;
                } else if (target.dataset?.close) {
                    label = `Fermeture modale: "${target.dataset.close}"`;
                } else if (target.dataset?.ram) {
                    label = `Selection RAM: ${target.dataset.ram} Go`;
                } else if (target.dataset?.lang) {
                    label = `Changement langue: ${target.dataset.lang}`;
                } else if (target.id) {
                    label = `Bouton / Element: #${target.id}`;
                    if (target.innerText && target.innerText.trim().length < 40) {
                        label += ` ("${target.innerText.trim().replace(/\s+/g, ' ')}")`;
                    }
                } else if (target.getAttribute('title')) {
                    label = `Element: "${target.getAttribute('title')}"`;
                } else if (target.innerText && target.innerText.trim().length > 0 && target.innerText.trim().length < 40) {
                    label = `Clic texte: "${target.innerText.trim().replace(/\s+/g, ' ')}"`;
                } else {
                    label = `Clic sur <${target.tagName.toLowerCase()}${target.className ? '.' + target.className.split(' ').join('.') : ''}>`;
                }

                this.logDev('CLIC', label);
            } catch (_) {}
        }, true);

        // Intercept input / select changes
        document.addEventListener('change', (e) => {
            try {
                const target = e.target;
                const id = target.id ? `#${target.id}` : target.tagName.toLowerCase();
                let val = target.type === 'password' ? '********' : (target.type === 'checkbox' ? (target.checked ? 'coche' : 'decoche') : target.value);
                this.logDev('UI', `Changement de valeur sur ${id} : "${val}"`);
            } catch (_) {}
        }, true);

        // Intercept console.log / info / warn / error
        const origConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error
        };

        console.log = (...args) => {
            origConsole.log.apply(console, args);
            const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            let cat = 'CONSOLE';
            if (msg.startsWith('[Minecraft]') || msg.includes('Minecraft')) cat = 'MINECRAFT';
            else if (msg.startsWith('[RXSync]') || msg.startsWith('[Link-Sync]') || msg.includes('Pelican')) cat = 'PELICAN';
            else if (msg.includes('Microsoft') || msg.includes('Auth')) cat = 'AUTH';
            this.logDev(cat, msg);
        };

        console.info = (...args) => {
            origConsole.info.apply(console, args);
            const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            this.logDev('INFO', msg);
        };

        console.warn = (...args) => {
            origConsole.warn.apply(console, args);
            const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            this.logDev('WARN', msg);
        };

        console.error = (...args) => {
            origConsole.error.apply(console, args);
            const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
            this.logDev('ERROR', msg);
        };

        window.addEventListener('error', (e) => {
            this.logDev('ERROR', `Exception JavaScript : ${e.message} (${e.filename}:${e.lineno})`);
        });

        window.addEventListener('unhandledrejection', (e) => {
            this.logDev('ERROR', `Promesse non geree : ${e.reason}`);
        });

        this.logDev('INIT', 'Moteur de journalisation globale RXCORP active.');
    }

    logDev(category, message, details = null) {
        const now = new Date();
        const time = `[${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
        const logEntry = {
            time,
            timestamp: now.getTime(),
            category: (category || 'INFO').toUpperCase(),
            message: String(message),
            details
        };

        try {
            ipcRenderer.send('dev-terminal-broadcast', logEntry);
        } catch (_) {}
    }

    // ==========================================
    // UNIFIED SHELL NAVIGATION & DASHBOARD
    // ==========================================
    initDribbbleShell() {
        const railItems = document.querySelectorAll('.rail-item[data-view]');
        railItems.forEach(item => {
            item.addEventListener('click', () => {
                const targetView = item.dataset.view;
                this.selectDribbbleMode(targetView);
            });
        });

        // Add instance button on left rail
        document.getElementById('btn-rail-add')?.addEventListener('click', () => {
            document.getElementById('modal-create-instance')?.classList.add('active');
        });

        // User avatar button on left rail -> switch to settings & profile
        document.getElementById('rail-user-pill')?.addEventListener('click', () => {
            this.selectDribbbleMode('settings');
        });

        // Drawer back button
        document.getElementById('btn-back-dashboard')?.addEventListener('click', () => {
            this.closeDrawer();
        });

        // Hero secondary button
        document.getElementById('btn-hero-secondary')?.addEventListener('click', () => {
            const mode = this.activeDribbbleMode || 'cloud';
            if (mode === 'cloud') {
                const curInst = this.getActiveInstanceForDomain('cloud');
                if (curInst && curInst.serverAddress) {
                    const server = this.cloudServers.find(s => `${s.ip}:${s.port}` === curInst.serverAddress);
                    if (server) {
                        this.handleSyncServerMods(server);
                        return;
                    }
                }
                this.openDrawer('cloud', 'SERVEURS PELICAN CLOUD');
            } else {
                document.getElementById('modal-create-instance')?.classList.add('active');
            }
        });

        // Dashboard Real Cards Buttons
        document.getElementById('btn-widget-cloud')?.addEventListener('click', () => {
            this.selectDribbbleMode('cloud');
            this.openDrawer('cloud', 'SERVEURS PELICAN CLOUD');
        });

        document.getElementById('btn-widget-instances')?.addEventListener('click', () => {
            this.selectDribbbleMode('instances');
            this.openDrawer('instances', 'MES PROFILS & MODPACKS');
        });

        // Default mode from store or home
        const hasPelican = store.get('hasPelicanServer') ?? (store.get('apiKey') ? true : false);
        this.updateRailOrder(hasPelican);
        const savedMode = store.get('activeDribbbleMode') || 'home';
        this.selectDribbbleMode(savedMode === 'pvp' ? 'home' : savedMode);

        // Connect 6 Behance Showcase Quick-Play Cards
        document.querySelectorAll('.game-card.card-quick-play').forEach(card => {
            card.addEventListener('click', (e) => {
                const targetType = card.dataset.targetType;
                const isBtnClick = e.target.closest('.card-action-btn');

                // Visual active highlight
                document.querySelectorAll('.game-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');

                if (targetType === 'cloud') {
                    this.selectDribbbleMode('home');
                    const cloudInst = this.getActiveInstanceForDomain('cloud');
                    if (cloudInst) {
                        this.setActiveInstanceForDomain('cloud', cloudInst.id);
                    }
                } else {
                    const loader = card.dataset.targetLoader || 'fabric';
                    const version = card.dataset.targetVersion || '1.21.4';
                    
                    // Find or create local instance matching this configuration
                    let matching = instanceService.getInstancesByDomain('local').find(i => 
                        (i.loader || '').toLowerCase() === loader.toLowerCase() && 
                        (i.version || '').includes(version)
                    );

                    if (!matching) {
                        matching = instanceService.createInstance({
                            name: `Profil ${loader.toUpperCase()} ${version}`,
                            version: version,
                            loader: loader,
                            domain: 'local'
                        });
                    }

                    this.selectDribbbleMode('home');
                    this.setActiveInstanceForDomain('local', matching.id);
                }

                this.updateDockInstancePill();

                // If user clicked directly on "JOUER" / "LANCER" button, launch the game!
                if (isBtnClick) {
                    document.getElementById('btn-launch-game')?.click();
                }
            });
        });

        // Card 6: Open mods store
        document.querySelector('.game-card.card-quick-mods')?.addEventListener('click', () => {
            this.selectDribbbleMode('modrinth');
        });
    }

    selectDribbbleMode(mode) {
        if (mode === 'pvp') mode = 'home';
        this.activeDribbbleMode = mode;
        store.set('activeDribbbleMode', mode);

        // Update active class on rail items
        document.querySelectorAll('.rail-item[data-view]').forEach(item => {
            item.classList.toggle('active', item.dataset.view === mode);
        });

        // Switch active view container
        this.switchView(mode);

        const hero = document.getElementById('dribbble-hero');
        const tagText = document.getElementById('hero-tag-text');
        const heroDot = document.querySelector('.hero-dot');
        const heroTitle = document.getElementById('hero-title');
        const heroDesc = document.getElementById('hero-desc');
        const playLabel = document.getElementById('hero-play-label');
        const secText = document.getElementById('hero-sec-text');

        if (mode === 'home') {
            const domain = this.getCurrentDomain();
            const inst = this.getActiveInstanceForDomain(domain);
            if (heroTitle) heroTitle.innerText = inst ? inst.name : (domain === 'cloud' ? 'RXCORP CLOUD' : 'MINECRAFT LOCAL');
            if (heroDesc) heroDesc.innerText = domain === 'cloud' 
                ? 'Infrastructure Cloud Pelican officielle avec synchronisation automatique de la whitelist et connexion 1-clic.'
                : 'Profil Minecraft local autonome haute performance (Fabric, Forge, NeoForge, Vanilla).';
            if (playLabel) playLabel.innerText = domain === 'cloud' ? 'JOUER (SERVEUR)' : 'LANCER (LOCAL)';
            if (secText) secText.innerText = domain === 'cloud' ? 'Synchroniser les Mods' : '+ Nouveau Profil';
            this.updateDockInstancePill();
            this.renderDashboardLists();
        } else if (mode === 'cloud') {
            if (playLabel) playLabel.innerText = 'JOUER (SERVEUR)';
            this.loadCloudServers();
        } else if (mode === 'instances') {
            if (playLabel) playLabel.innerText = 'JOUER (LOCAL)';
            this.loadInstances();
        } else if (mode === 'modrinth') {
            if (typeof this.triggerModSearch === 'function') {
                this.triggerModSearch();
            }
        } else if (mode === 'settings' || mode === 'profile') {
            this.initSettings();
        }
    }

    renderDashboardLists() {
        // 1. Official Cloud Servers list
        const cloudList = document.getElementById('dashboard-cloud-list');
        if (cloudList) {
            if (!this.cloudServers || this.cloudServers.length === 0) {
                const hasPelican = store.get('hasPelicanServer') ?? (store.get('apiKey') ? true : false);
                cloudList.innerHTML = hasPelican ? `
                    <div style="font-size: 12px; color: var(--text-dim); text-align: center; padding: 24px 10px;">
                        Aucun serveur Pelican détecté sur votre compte.<br>
                        <a href="#" id="link-connect-cloud-dash" style="color: var(--primary); text-decoration: underline; font-weight: 600;">Se connecter au Panel Pelican ↗</a>
                    </div>
                ` : `
                    <div style="font-size: 12px; color: var(--text-dim); text-align: center; padding: 24px 10px;">
                        Mode Joueur Local actif.<br>
                        <span style="font-size: 11px; opacity: 0.85;">Le mode Cloud est en arrière-plan. Gérez vos profils locaux et mods librement.</span>
                    </div>
                `;
                document.getElementById('link-connect-cloud-dash')?.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.openDrawer('cloud', 'SERVEURS PELICAN CLOUD');
                });
            } else {
                const mcServers = (this.cloudServers || []).filter(s => s.isMinecraft);
                if (mcServers.length === 0) {
                    cloudList.innerHTML = `
                        <div style="font-size: 12px; color: var(--text-dim); text-align: center; padding: 24px 10px;">
                            Aucun serveur Minecraft actif sur votre compte.<br>
                            <a href="#" id="link-connect-cloud-dash" style="color: var(--primary); text-decoration: underline; font-weight: 600;">Gérer dans l'onglet Cloud ↗</a>
                        </div>
                    `;
                } else {
                    cloudList.innerHTML = mcServers.map(srv => {
                        const isSelected = this.activeInstance?.serverAddress === `${srv.ip}:${srv.port}` || 
                                           (this.activeInstance?.name && this.activeInstance.name.includes(srv.name));
                        const isOnline = srv.isOnline !== undefined ? srv.isOnline : (srv.status === 'online' || srv.status === 'running');
                        const ping = srv.ping || 18;
                        const loaderBadge = (srv.loader && srv.loader !== 'vanilla') ? srv.loader.toUpperCase() : 'MC';
                        const playerInfo = (srv.playersOnline !== undefined && srv.playersOnline !== null) 
                            ? `${srv.playersOnline}/${srv.playersMax || 20} joueurs • `
                            : '';
                        return `
                            <div class="dash-item-row ${isSelected ? 'active' : ''}">
                                <div class="dash-item-left">
                                    <span class="srv-dot ${isOnline ? 'online' : 'offline'}"></span>
                                    <div class="dash-item-info">
                                        <span class="dash-item-name">${srv.name} <span class="rx-tag" style="font-size: 9px; padding: 1px 5px; margin-left: 5px; background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.3);">${loaderBadge} ${srv.version || '1.20.1'}</span></span>
                                        <span class="dash-item-sub">${playerInfo}${isOnline ? `${ping}ms` : 'Hors-ligne'} • ${srv.ip}:${srv.port}</span>
                                    </div>
                                </div>
                                <div class="dash-item-actions">
                                    <button class="dash-quick-btn btn-dash-select-server" data-name="${srv.name}">
                                        ${isSelected ? 'Actif' : 'Sélectionner'}
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('');

                    cloudList.querySelectorAll('.btn-dash-select-server').forEach(btn => {
                        btn.addEventListener('click', async (e) => {
                            const srvName = e.currentTarget.dataset.name;
                            const srv = mcServers.find(s => s.name === srvName);
                            if (srv) {
                                await this.selectCloudServer(srv);
                            }
                        });
                    });
                }
            }
        }

        // 2. Local Instances list
        const instList = document.getElementById('dashboard-instances-list');
        if (instList) {
            const locals = instanceService.getLocalInstances();
            if (locals.length === 0) {
                instList.innerHTML = `
                    <div style="font-size: 12px; color: var(--text-dim); text-align: center; padding: 24px 10px;">
                        Aucun profil local pour l'instant.<br>
                        <a href="#" id="link-create-inst-dash" style="color: var(--cyan); text-decoration: underline; font-weight: 600;">+ Créer un profil local ↗</a>
                    </div>
                `;
                document.getElementById('link-create-inst-dash')?.addEventListener('click', (e) => {
                    e.preventDefault();
                    document.getElementById('modal-create-instance')?.classList.add('active');
                });
            } else {
                instList.innerHTML = locals.map(inst => {
                    const isSelected = this.activeInstance?.id === inst.id;
                    const meta = this.getLoaderMeta(inst.loader, inst.name);
                    return `
                        <div class="dash-item-row ${isSelected ? 'active' : ''}">
                            <div class="dash-item-left">
                                <div style="width: 32px; height: 32px; min-width: 32px; border-radius: 6px; background: ${meta.bg}; border: 1px solid ${meta.border}; display: flex; align-items: center; justify-content: center;">
                                    <img src="${meta.icon}" alt="${meta.name}" style="width: 20px; height: 20px; object-fit: contain;">
                                </div>
                                <div class="dash-item-info">
                                    <span class="dash-item-name">${inst.name}</span>
                                    <span class="dash-item-sub">MC ${inst.version || '1.21.4'} • <span style="color: ${meta.color}; font-weight: 600;">${meta.name}</span> • ${inst.modCount || 0} mod(s)</span>
                                </div>
                            </div>
                            <div class="dash-item-actions">
                                <button class="dash-quick-btn btn-dash-select-instance" data-id="${inst.id}">
                                    ${isSelected ? 'Actif' : 'Choisir'}
                                </button>
                            </div>
                        </div>
                    `;
                }).join('');

                instList.querySelectorAll('.btn-dash-select-instance').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const id = e.currentTarget.dataset.id;
                        this.selectDribbbleMode('instances');
                        this.setActiveInstanceForDomain('local', id);
                        this.renderDashboardLists();
                    });
                });
            }
        }
    }

    openDrawer(viewName, title = '') {
        const drawer = document.getElementById('dribbble-views-drawer');
        const drawerTitle = document.getElementById('drawer-title');
        if (drawer) drawer.style.display = 'flex';
        if (drawerTitle && title) drawerTitle.innerText = title;

        this.switchView(viewName);
    }

    closeDrawer() {
        const drawer = document.getElementById('dribbble-views-drawer');
        if (drawer) drawer.style.display = 'none';
        this.renderDashboardLists();
    }

    // ==========================================
    // WINDOW CONTROLS & TITLEBAR
    // ==========================================
    initWindowControls() {
        document.getElementById('btn-minimize')?.addEventListener('click', () => {
            ipcRenderer.send('main-window-minimize');
        });

        document.getElementById('btn-maximize')?.addEventListener('click', () => {
            ipcRenderer.send('main-window-maximize');
        });

        document.getElementById('btn-close')?.addEventListener('click', () => {
            ipcRenderer.send('main-window-close');
        });

        document.getElementById('user-pill')?.addEventListener('click', () => {
            this.openDrawer('settings', 'CONFIGURATION & COMPTES');
        });

        document.getElementById('link-create-key')?.addEventListener('click', (e) => {
            e.preventDefault();
            shell.openExternal('https://panel.rxcorp.me/account/api');
        });
    }

    // ==========================================
    // MULTI-LANGUAGE I18N SYSTEM
    // ==========================================
    initI18n() {
        // Initial application of active language
        i18n.applyTranslations();
        this.initLanguageSelector();
    }

    // ==========================================
    // AUTO-UPDATER UI INTEGRATION
    // ==========================================
    initUpdater() {
        const updatePill = document.getElementById('update-pill');
        const updateText = document.getElementById('update-pill-text');
        const floatingBanner = document.getElementById('floating-update-pill');
        const floatingText = document.getElementById('floating-update-text');
        const floatingBtn = document.getElementById('btn-floating-update-action');
        const btnCheckUpdate = document.getElementById('btn-check-update');
        const feedbackCheck = document.getElementById('update-check-feedback');

        if (btnCheckUpdate) {
            btnCheckUpdate.addEventListener('click', () => {
                btnCheckUpdate.disabled = true;
                btnCheckUpdate.innerHTML = '<span>Recherche...</span>';
                if (feedbackCheck) feedbackCheck.textContent = 'Connexion au serveur...';
                ipcRenderer.send('check-for-update');
                setTimeout(() => {
                    if (btnCheckUpdate.disabled) {
                        btnCheckUpdate.disabled = false;
                        btnCheckUpdate.innerHTML = '<span>Vérifier les Mises à Jour</span>';
                    }
                }, 8000);
            });
        }

        if (floatingBtn) {
            floatingBtn.addEventListener('click', () => {
                ipcRenderer.send('install-update-now');
            });
        }

        ipcRenderer.on('updater-event', (event, data) => {
            console.log('[RXCORP Updater Event]', data);

            if (data.status === 'checking') {
                if (feedbackCheck) feedbackCheck.textContent = 'Vérification du cloud...';
            } else if (data.status === 'available') {
                const targetVer = data.version || '';
                if (updatePill) {
                    updatePill.style.display = 'inline-flex';
                    updatePill.style.borderColor = 'var(--cyan)';
                    updatePill.style.background = 'rgba(14, 165, 233, 0.15)';
                }
                if (updateText) {
                    updateText.style.color = 'var(--cyan)';
                    updateText.textContent = `Téléchargement v${targetVer}...`;
                }

                if (floatingBanner && floatingText && floatingBtn) {
                    floatingBanner.style.display = 'flex';
                    floatingBanner.style.borderColor = 'var(--cyan)';
                    floatingText.textContent = `Version v${targetVer} détectée ! Téléchargement en cours...`;
                    floatingBtn.textContent = 'Téléchargement...';
                    floatingBtn.disabled = true;
                }

                if (feedbackCheck) feedbackCheck.textContent = `Mise à jour v${targetVer} détectée !`;
                this.showNotification('Mise à jour disponible !', `Téléchargement de la version ${targetVer} en arrière-plan.`);
            } else if (data.status === 'downloading') {
                const pct = data.percent || 0;
                if (updatePill) updatePill.style.display = 'inline-flex';
                if (updateText) updateText.textContent = `${pct}%`;

                if (floatingBanner && floatingText) {
                    floatingBanner.style.display = 'flex';
                    floatingText.textContent = `Téléchargement de la mise à jour : ${pct}%`;
                }
                if (feedbackCheck) feedbackCheck.textContent = `Téléchargement : ${pct}%`;
            } else if (data.status === 'ready') {
                const readyVer = data.version || '';
                if (updatePill) {
                    updatePill.style.display = 'inline-flex';
                    updatePill.style.borderColor = 'var(--emerald)';
                    updatePill.style.background = 'rgba(16, 185, 129, 0.2)';
                    updatePill.onclick = () => ipcRenderer.send('install-update-now');
                }
                if (updateText) {
                    updateText.style.color = 'var(--emerald)';
                    updateText.textContent = `Relancer pour v${readyVer}`;
                }

                if (floatingBanner && floatingText && floatingBtn) {
                    floatingBanner.style.display = 'flex';
                    floatingBanner.style.borderColor = 'var(--emerald)';
                    floatingText.textContent = `Version v${readyVer} prête ! Redémarrez pour installer.`;
                    floatingBtn.textContent = 'Redémarrer';
                    floatingBtn.disabled = false;
                    floatingBtn.style.background = 'var(--emerald)';
                    floatingBtn.style.borderColor = 'var(--emerald-light)';
                }

                if (feedbackCheck) feedbackCheck.textContent = `Version v${readyVer} prête !`;
                this.showNotification('Mise à jour prête !', `La version ${readyVer} a été téléchargée. Cliquez pour redémarrer.`);
            } else if (data.status === 'not-available') {
                const currentV = data.version || data.currentVersion || this.appVersion;
                if (data.isManual) {
                    this.showNotification('À jour !', `Votre launcher est à la version la plus récente (v${currentV}).`);
                }
                if (feedbackCheck) feedbackCheck.textContent = `À jour (v${currentV})`;
                if (btnCheckUpdate) {
                    btnCheckUpdate.disabled = false;
                    btnCheckUpdate.innerHTML = '<span>Vous êtes à jour</span>';
                    setTimeout(() => {
                        btnCheckUpdate.innerHTML = '<span>Vérifier les Mises à Jour</span>';
                    }, 4000);
                }
            } else if (data.status === 'error') {
                console.warn('[Updater Error]', data.error);
                if (feedbackCheck) feedbackCheck.textContent = `Erreur: ${data.error}`;
                if (data.isManual) {
                    this.showNotification('Erreur de mise à jour', `${data.error}`);
                }
                if (btnCheckUpdate) {
                    btnCheckUpdate.disabled = false;
                    btnCheckUpdate.innerHTML = '<span>Réessayer</span>';
                }
            }
        });
    }

    // ==========================================
    // NAVIGATION (VIEW SWITCHING)
    // ==========================================
    initNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', () => {
                const targetView = item.dataset.view;
                this.switchView(targetView);
            });
        });
    }

    switchView(viewName) {
        this.activeView = viewName;

        // Update sidebar and rail active classes
        document.querySelectorAll('.nav-item, .rail-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === viewName);
        });

        // Update view containers
        document.querySelectorAll('.view-container').forEach(view => {
            view.classList.toggle('active', view.id === `view-${viewName}`);
        });

        // Trigger view-specific refreshes
        if (viewName === 'home') {
            this.renderDashboardLists();
            this.updateDockInstancePill();
        } else if (viewName === 'cloud') {
            this.loadCloudServers();
        } else if (viewName === 'instances') {
            this.loadInstances();
        } else if (viewName === 'modrinth') {
            if (typeof this.triggerModSearch === 'function') {
                this.triggerModSearch();
            }
        } else if (viewName === 'settings' || viewName === 'profile') {
            this.initSettings();
        }
    }

    // ==========================================
    // RXCORP CLOUD (PELICAN INTEGRATION)
    // ==========================================
    initCloudToolbar() {
        // Game filter pills
        document.querySelectorAll('.cloud-filter-pill').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const pill = e.currentTarget;
                const filter = pill.getAttribute('data-filter');
                document.querySelectorAll('.cloud-filter-pill').forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this.activeGameFilter = filter;
                this.renderFilteredCloudServers();
            });
        });

        // Admin scope buttons (Mes serveurs vs Tous les serveurs)
        const btnUser = document.getElementById('btn-scope-user');
        const btnAdmin = document.getElementById('btn-scope-admin');

        btnUser?.addEventListener('click', async () => {
            if (this.adminScope === 'user') return;
            this.adminScope = 'user';
            store.set('pelicanAdminScope', 'user');
            btnUser.classList.add('active');
            btnAdmin?.classList.remove('active');
            await this.loadCloudServers();
        });

        btnAdmin?.addEventListener('click', async () => {
            if (this.adminScope === 'admin') return;
            this.adminScope = 'admin';
            store.set('pelicanAdminScope', 'admin');
            btnAdmin.classList.add('active');
            btnUser?.classList.remove('active');
            await this.loadCloudServers();
        });

        // Refresh button on cloud tab
        const btnRefresh = document.getElementById('btn-refresh-cloud');
        btnRefresh?.addEventListener('click', async (e) => {
            e.preventDefault();
            btnRefresh.disabled = true;
            const origHtml = btnRefresh.innerHTML;
            btnRefresh.innerHTML = '<span>Actualisation...</span>';
            this.updatePublicServersStatus();
            this.updateTelemetryConsole();
            await this.loadCloudServers();
            setTimeout(() => {
                btnRefresh.disabled = false;
                btnRefresh.innerHTML = origHtml;
            }, 600);
        });

        // Periodic auto-refresh of server status every 15 seconds
        if (!this.serverStatusInterval) {
            this.serverStatusInterval = setInterval(() => {
                this.updatePublicServersStatus();
                this.updateTelemetryConsole();
                if (this.cloudServers && this.cloudServers.length > 0) {
                    for (const srv of this.cloudServers) {
                        const card = document.getElementById(`server-card-${srv.id}`);
                        if (card) {
                            this.fetchServerLiveStatus(srv, card);
                        }
                    }
                    this.renderDashboardLists();
                }
            }, 15000);
        }
    }

    async loadCloudServers() {
        const apiKey = store.get('apiKey');
        const panelUrl = store.get('panelUrl') || 'https://panel.rxcorp.me';
        let pelicanUser = store.get('pelicanUser');

        const authCard = document.getElementById('cloud-auth-card');
        const userHeader = document.getElementById('cloud-user-header');
        const toolbar = document.getElementById('cloud-filter-toolbar');
        const adminScopeBox = document.getElementById('cloud-admin-scope-box');
        const grid = document.getElementById('cloud-servers-grid');
        const counterEl = document.getElementById('cloud-server-counter-text');
        const pillText = document.getElementById('cloud-pill-text');
        const pillDot = document.querySelector('#cloud-pill .status-dot');

        if (!apiKey) {
            if (authCard) authCard.style.display = 'block';
            if (userHeader) userHeader.style.display = 'none';
            if (toolbar) toolbar.style.display = 'none';
            if (grid) grid.innerHTML = '';
            if (pillText) pillText.innerText = 'Non connecté';
            if (pillDot) pillDot.className = 'status-dot offline';
            this.cloudServers = [];
            this.renderDashboardLists();
            return;
        }

        if (authCard) authCard.style.display = 'none';
        if (userHeader) userHeader.style.display = 'flex';

        // Refresh or fetch admin privileges if not yet resolved
        if (!pelicanUser || typeof pelicanUser.admin !== 'boolean') {
            try {
                const testRes = await pelicanService.testConnection(apiKey, panelUrl);
                if (testRes.success && testRes.user) {
                    pelicanUser = {
                        username: testRes.user.username,
                        email: testRes.user.email,
                        admin: !!testRes.user.admin
                    };
                    store.set('pelicanUser', pelicanUser);
                }
            } catch (_) {}
        }

        // Update Pelican user display in header
        if (pelicanUser?.username) {
            const userNameEl = document.getElementById('cloud-user-name');
            const userEmailEl = document.getElementById('cloud-user-email');
            if (userNameEl) userNameEl.innerText = pelicanUser.username;
            if (userEmailEl) userEmailEl.innerText = pelicanUser.email || '';
        }

        const isAdmin = pelicanUser?.admin === true;

        // Admin scope box display
        if (adminScopeBox) {
            adminScopeBox.style.display = isAdmin ? 'flex' : 'none';
        }

        if (!isAdmin) {
            this.adminScope = 'user';
        } else {
            this.adminScope = store.get('pelicanAdminScope') || 'admin';
        }

        const btnScopeUser = document.getElementById('btn-scope-user');
        const btnScopeAdmin = document.getElementById('btn-scope-admin');
        if (btnScopeUser && btnScopeAdmin) {
            btnScopeUser.classList.toggle('active', this.adminScope === 'user');
            btnScopeAdmin.classList.toggle('active', this.adminScope === 'admin');
        }

        if (pillText) pillText.innerText = 'Connexion...';
        if (pillDot) pillDot.className = 'status-dot';

        if (grid) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">
                    <span>Chargement de vos serveurs Minecraft...</span>
                </div>
            `;
        }

        const fetchAdminAll = isAdmin && (this.adminScope === 'admin');
        const res = await pelicanService.getServers(apiKey, panelUrl, fetchAdminAll);
        if (!res.success) {
            if (authCard) authCard.style.display = 'block';
            if (userHeader) userHeader.style.display = 'none';
            if (toolbar) toolbar.style.display = 'none';
            if (grid) {
                grid.innerHTML = `
                    <div class="rx-card" style="grid-column: 1/-1; border: 1px solid rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.08); margin-bottom: 20px; text-align: center; padding: 20px;">
                        <p style="color: var(--danger); font-weight: 700; margin-bottom: 6px;">Session expirée ou clé invalide</p>
                        <p style="font-size: 13px; color: var(--text-dim); margin-bottom: 0;">Veuillez vous reconnecter au Panel Pelican ci-dessus.</p>
                    </div>
                `;
            }
            if (pillText) pillText.innerText = 'Non connecté';
            if (pillDot) pillDot.className = 'status-dot offline';
            this.cloudServers = [];
            this.renderDashboardLists();
            return;
        }

        // Filter strictly to Minecraft servers (FiveM and other games deferred as requested)
        this.cloudServers = (res.servers || []).filter(s => s.isMinecraft);

        // Show toolbar
        if (toolbar) toolbar.style.display = 'flex';

        if (counterEl) {
            counterEl.innerText = `${this.cloudServers.length} serveur(s) disponible(s)`;
        }

        if (pillText) pillText.innerText = `${this.cloudServers.length} Serveur(s)`;
        if (pillDot) pillDot.className = 'status-dot online';

        this.renderFilteredCloudServers();
        this.renderDashboardLists();
        this.updatePelicanSyncUI();
    }

    renderFilteredCloudServers() {
        const grid = document.getElementById('cloud-servers-grid');
        if (!grid) return;

        const servers = this.cloudServers || [];

        if (servers.length === 0) {
            grid.innerHTML = `
                <div class="rx-card" style="grid-column: 1/-1; text-align: center; padding: 36px 24px; background: var(--rx-chassis-panel); border: 1px solid var(--rx-edge-rim); border-radius: var(--radius-md);">
                    <h3 style="font-family: var(--font-display); font-size: 16px; font-weight: 700; color: var(--rx-type-readout); margin-bottom: 8px;">Aucun serveur Pelican détecté</h3>
                    <p style="color: var(--rx-type-dim); margin-bottom: 16px; font-size: 12.5px; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.5;">
                        Associez votre compte Panel dans les paramètres ou déployez une infrastructure de jeu pour synchroniser automatiquement vos instances et whitelists.
                    </p>
                    <div style="display: flex; justify-content: center; gap: 10px;">
                        <button class="rx-btn rx-btn-secondary" id="btn-empty-open-settings" style="font-size: 12px;">
                            Configurer l'accès Pelican
                        </button>
                        <button class="rx-btn rx-btn-primary" onclick="require('electron').shell.openExternal('https://rxcorp.me')">
                            Déployer un serveur
                        </button>
                    </div>
                </div>
            `;
            document.getElementById('btn-empty-open-settings')?.addEventListener('click', () => {
                document.querySelector('.rail-item[data-view="settings"]')?.click();
            });
            return;
        }

        grid.innerHTML = '';
        for (const server of servers) {
            const card = this.createServerCard(server);
            grid.appendChild(card);
            this.fetchServerLiveStatus(server, card);
        }
    }

    createServerCard(server) {
        const card = document.createElement('div');
        card.className = 'server-card';
        card.id = `server-card-${server.id}`;

        const loaderText = (server.loader && server.loader !== 'vanilla') ? server.loader.toUpperCase() : 'VANILLA';

        card.innerHTML = `
            <div class="server-card-top">
                <div class="server-name-box">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <h3 class="server-name" style="margin: 0;">${server.name}</h3>
                        <span class="rx-tag" style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); font-weight: 700;">${loaderText} ${server.version || '1.20.1'}</span>
                    </div>
                    <div class="server-address" title="Cliquer pour copier l'adresse" style="cursor: pointer;">
                        <span>${server.ip}:${server.port}</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px; height:11px; opacity:0.7;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </div>
                </div>
                <div class="server-badge online" id="badge-${server.id}">
                    <span class="rx-signal-dot"></span>
                    <span class="badge-text">Sonde active...</span>
                </div>
            </div>

            <div class="server-stats-row">
                <div class="stat-item">
                    <span class="stat-label">RAM ALLOUÉE</span>
                    <span class="stat-value">${server.limits.memory > 0 ? (server.limits.memory / 1024).toFixed(1) + ' GB' : 'Illimitée'}</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">RAM UTILISÉE</span>
                    <span class="stat-value" id="ram-used-${server.id}">-</span>
                </div>
                <div class="stat-item">
                    <span class="stat-label">CHARGE CPU</span>
                    <span class="stat-value" id="cpu-used-${server.id}">-</span>
                </div>
            </div>

            <div class="server-mods-preview" id="mods-preview-${server.id}" style="margin-top: 6px; margin-bottom: 6px; padding: 10px 14px; background: rgba(0,0,0,0.25); border-radius: 8px; border: 1px solid var(--border-subtle); font-size: 11px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; stroke: var(--primary); flex-shrink: 0;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                    <span id="mods-summary-${server.id}" style="color: var(--text-dim); overflow: hidden; text-overflow: ellipsis;">Détection des mods...</span>
                </div>
                <span class="rx-tag" id="mods-count-${server.id}" style="font-size: 10px; padding: 3px 8px; border-radius: 4px; flex-shrink: 0; background: rgba(255,255,255,0.06); color: var(--text-muted); border: 1px solid var(--border-subtle);">-</span>
            </div>

            <div class="server-actions">
                <button class="rx-btn rx-btn-primary btn-join-server" style="flex: 1.3; font-weight: 700;" data-id="${server.id}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
                    <span>Rejoindre</span>
                </button>
                <button class="rx-btn rx-btn-secondary btn-sync-mods" title="Télécharger et lier les mods via RXSync" style="flex: 1; font-weight: 600;" data-id="${server.id}">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                    <span>RXSync</span>
                </button>
                <button class="rx-btn rx-btn-secondary btn-open-panel" title="Gérer sur le Panel" style="padding: 9px 12px;" data-id="${server.id}">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </button>
            </div>
        `;

        const addrEl = card.querySelector('.server-address');
        if (addrEl) {
            addrEl.addEventListener('click', () => {
                const text = `${server.ip}:${server.port}`;
                clipboard.writeText(text);
                this.showNotification('Adresse Copiée', `${text} est copié dans le presse-papier.`);
            });
        }

        card.querySelector('.btn-join-server')?.addEventListener('click', () => {
            this.handleJoinServer(server);
        });

        card.querySelector('.btn-sync-mods')?.addEventListener('click', () => {
            this.handleSyncServerMods(server, false);
        });

        card.querySelector('.btn-open-panel')?.addEventListener('click', () => {
            const panelUrl = store.get('panelUrl') || 'https://panel.rxcorp.me';
            const serverId = server.identifier || server.id;
            shell.openExternal(`${panelUrl}/server/${serverId}`);
        });

        return card;
    }

    async fetchServerLiveStatus(server, card) {
        const apiKey = store.get('apiKey');
        const panelUrl = store.get('panelUrl');
        const badge = card.querySelector(`#badge-${server.id}`);
        const ramValue = card.querySelector(`#ram-used-${server.id}`);
        const cpuValue = card.querySelector(`#cpu-used-${server.id}`);
        const joinBtn = card.querySelector('.btn-join-server');

        try {
            const srvId = server.identifier || server.id;
            // Dual-detection: Query Pelican API and Direct Minecraft TCP/SLP Ping in parallel
            const [pelicanRes, pingRes] = await Promise.all([
                pelicanService.getServerResources(srvId, apiKey, panelUrl).catch(() => ({ success: false, state: 'offline' })),
                pelicanService.pingMinecraftServer(server.ip, server.port, 2800).catch(() => ({ online: false, latency: 0 }))
            ]);

            const pelicanState = pelicanRes?.state || pelicanRes?.current_state || 'offline';
            const isOnline = (pelicanState === 'running') || (pingRes && pingRes.online === true);
            const isStarting = (pelicanState === 'starting') && !isOnline;

            // Cache status on server object for dashboard views
            server.isOnline = isOnline;
            server.status = isOnline ? 'running' : (isStarting ? 'starting' : 'offline');
            if (pingRes?.latency) server.ping = pingRes.latency;
            if (pingRes?.playersOnline !== null && pingRes?.playersOnline !== undefined) {
                server.playersOnline = pingRes.playersOnline;
                server.playersMax = pingRes.playersMax || 20;
            }

            if (isOnline) {
                badge.className = 'server-badge online';
                let extraText = '';
                if (pingRes && pingRes.playersOnline !== null && pingRes.playersOnline !== undefined) {
                    extraText = ` (${pingRes.playersOnline}/${pingRes.playersMax || 20})`;
                } else if (pingRes && pingRes.latency) {
                    extraText = ` (${pingRes.latency}ms)`;
                }
                badge.innerHTML = `<span class="rx-signal-dot"></span><span class="badge-text">En Ligne${extraText}</span>`;

                if (joinBtn) {
                    joinBtn.disabled = false;
                    joinBtn.classList.remove('disabled', 'rx-btn-disabled', 'rx-btn-secondary');
                    joinBtn.classList.add('rx-btn-primary');
                    joinBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>
                        <span>Rejoindre</span>
                    `;
                    joinBtn.title = 'Rejoindre et auto-connecter à ce serveur';
                }
            } else if (isStarting) {
                badge.className = 'server-badge starting';
                badge.innerHTML = '<span class="rx-signal-dot"></span><span class="badge-text">Démarrage...</span>';
                if (joinBtn) {
                    joinBtn.disabled = true;
                    joinBtn.classList.add('disabled', 'rx-btn-disabled', 'rx-btn-secondary');
                    joinBtn.classList.remove('rx-btn-primary');
                    joinBtn.innerHTML = '<span>Démarrage...</span>';
                    joinBtn.title = 'Le serveur est en cours de démarrage';
                }
            } else {
                badge.className = 'server-badge offline';
                badge.innerHTML = '<span class="rx-signal-dot"></span><span class="badge-text">Hors-Ligne</span>';
                if (joinBtn) {
                    joinBtn.disabled = true;
                    joinBtn.classList.add('disabled', 'rx-btn-disabled', 'rx-btn-secondary');
                    joinBtn.classList.remove('rx-btn-primary');
                    joinBtn.innerHTML = '<span>Hors-Ligne</span>';
                    joinBtn.title = 'Ce serveur est actuellement éteint ou inaccessible';
                }
            }

            // Display RAM / CPU stats or Latency fallback
            if (pelicanRes && pelicanRes.resources) {
                const mem = pelicanRes.resources.memory_bytes || pelicanRes.resources.memoryBytes || 0;
                const ramMb = (mem / (1024 * 1024)).toFixed(0);
                const cpu = pelicanRes.resources.cpu_absolute || pelicanRes.resources.cpuAbsolute || '0.0';
                if (ramValue) ramValue.innerText = `${ramMb} MB`;
                if (cpuValue) cpuValue.innerText = `${cpu}%`;
            } else if (isOnline && pingRes) {
                if (ramValue) ramValue.innerText = pingRes.latency ? `${pingRes.latency} ms` : 'En ligne';
                if (cpuValue) cpuValue.innerText = pingRes.version ? `${pingRes.version}` : '-';
            } else {
                if (ramValue) ramValue.innerText = '-';
                if (cpuValue) cpuValue.innerText = '0%';
            }
        } catch (err) {
            console.warn(`[LiveStatus] Erreur pour ${server.name}:`, err);
            if (badge) {
                badge.className = 'server-badge offline';
                badge.innerHTML = '<span class="rx-signal-dot"></span><span class="badge-text">Hors-Ligne</span>';
            }
            if (joinBtn) {
                joinBtn.disabled = true;
                joinBtn.classList.add('disabled', 'rx-btn-disabled', 'rx-btn-secondary');
                joinBtn.classList.remove('rx-btn-primary');
                joinBtn.innerHTML = '<span>Hors-Ligne</span>';
                joinBtn.title = 'Ce serveur est actuellement éteint ou inaccessible';
            }
            if (ramValue) ramValue.innerText = '-';
            if (cpuValue) cpuValue.innerText = '0%';
        }

        this.updateTelemetryConsole();

        // Live mods detection only for Minecraft servers
        if (server.isMinecraft) {
            try {
                const srvId = server.identifier || server.id;
                const modsRes = await pelicanService.listServerMods(srvId, apiKey, panelUrl);
                const modsSummary = card.querySelector(`#mods-summary-${server.id}`);
                const modsCount = card.querySelector(`#mods-count-${server.id}`);
                if (modsSummary && modsCount) {
                    if (modsRes.success && modsRes.mods && modsRes.mods.length > 0) {
                        const cleanNames = modsRes.mods.map(m => m.name.replace(/\.jar$/i, '').replace(/[-_]mc.*$/i, '')).join(', ');
                        modsSummary.innerText = cleanNames;
                        modsSummary.title = modsRes.mods.map(m => m.name).join('\n');
                        modsCount.innerText = `${modsRes.mods.length} mod(s)`;
                        modsCount.style.background = 'rgba(244, 63, 94, 0.15)';
                        modsCount.style.borderColor = 'rgba(244, 63, 94, 0.3)';
                        modsCount.style.color = '#f43f5e';
                    } else {
                        modsSummary.innerText = 'Aucun mod requis (Vanilla)';
                        modsCount.innerText = 'Vanilla';
                        modsCount.style.background = 'rgba(255, 255, 255, 0.05)';
                        modsCount.style.borderColor = 'var(--border)';
                        modsCount.style.color = 'var(--text-muted)';
                    }
                }
            } catch (_) {}
        }
    }

    _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    logToSyncTerminal(tag, message) {
        const terminalEl = document.getElementById('sync-terminal-output');
        if (!this.syncLogsBuffer) {
            this.syncLogsBuffer = [];
        }

        const now = new Date();
        const timeStr = `[${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}]`;
        const cleanTag = (tag || 'INFO').toUpperCase();
        const logEntry = `${timeStr} [${cleanTag}] ${message}`;
        this.syncLogsBuffer.push(logEntry);

        if (terminalEl) {
            const line = document.createElement('div');
            line.className = 'term-line';

            let tagClass = 'term-tag-info';
            if (cleanTag === 'SCAN') tagClass = 'term-tag-scan';
            else if (cleanTag === 'LINK') tagClass = 'term-tag-link';
            else if (cleanTag === 'DOWNLOAD') tagClass = 'term-tag-dl';
            else if (cleanTag === 'VERIFY') tagClass = 'term-tag-verify';
            else if (cleanTag === 'CLEAN') tagClass = 'term-tag-warn';
            else if (cleanTag === 'WARN') tagClass = 'term-tag-warn';
            else if (cleanTag === 'ERROR') tagClass = 'term-tag-error';
            else if (cleanTag === 'SUCCESS') tagClass = 'term-tag-success';

            line.innerHTML = `<span class="term-time">${timeStr}</span> <span class="${tagClass}">[${cleanTag}]</span> ${this._escapeHtml(message)}`;
            terminalEl.appendChild(line);
            terminalEl.scrollTop = terminalEl.scrollHeight;
        }

        this.logDev('PELICAN', `[${cleanTag}] ${message}`);
    }

    clearSyncTerminal() {
        this.syncLogsBuffer = [];
        const terminalEl = document.getElementById('sync-terminal-output');
        if (terminalEl) {
            terminalEl.innerHTML = '';
        }
    }

    copySyncLogs() {
        if (!this.syncLogsBuffer || this.syncLogsBuffer.length === 0) {
            this.showNotification('Logs Terminal', 'Aucun log a copier.');
            return;
        }
        const text = this.syncLogsBuffer.join('\n');
        try {
            clipboard.writeText(text);
            this.showNotification('Logs Copies', 'Tous les logs de synchronisation ont ete copies dans le presse-papier.');
        } catch (_) {
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text);
                this.showNotification('Logs Copies', 'Tous les logs de synchronisation ont ete copies dans le presse-papier.');
            }
        }
    }

    async handleSyncServerMods(server, autoLaunch = false) {
        if (this.isSyncing) return;
        this.isSyncing = true;

        const apiKey = store.get('apiKey');
        const panelUrl = store.get('panelUrl') || 'https://panel.rxcorp.me';
        const instance = instanceService.getOrCreateServerInstance(server);
        const modsPath = instance.modsPath || (instance.path ? path.join(instance.path, 'mods') : path.join(instanceService.getBaseDir(), instance.id, 'mods'));

        // Open RXSync Modal
        this.openModal('modal-mods-sync');

        const titleEl = document.getElementById('sync-server-title');
        const statTotal = document.getElementById('sync-stat-total');
        const statPool = document.getElementById('sync-stat-pool');
        const statDownload = document.getElementById('sync-stat-download');
        const statSaved = document.getElementById('sync-stat-saved');
        const progressLabel = document.getElementById('sync-progress-label');
        const progressPercent = document.getElementById('sync-progress-percent');
        const progressBar = document.getElementById('sync-progress-bar');
        const currentModEl = document.getElementById('sync-current-mod');
        const countStepEl = document.getElementById('sync-count-step');
        const btnPlay = document.getElementById('btn-sync-and-play');

        // Reset UI & prepare terminal
        this.clearSyncTerminal();
        this.logToSyncTerminal('init', `Initialisation RXSync pour "${server.name}" (${server.ip}:${server.port})`);

        if (titleEl) titleEl.innerText = `${server.name} (${server.ip}:${server.port})`;
        if (statTotal) statTotal.innerText = '-';
        if (statPool) statPool.innerText = '-';
        if (statDownload) statDownload.innerText = '-';
        if (statSaved) statSaved.innerText = '0 Mo';
        if (progressLabel) progressLabel.innerText = 'Connexion a Pelican...';
        if (progressPercent) progressPercent.innerText = '0%';
        if (progressBar) progressBar.style.width = '0%';
        if (currentModEl) currentModEl.innerText = 'Analyse des mods du serveur...';
        if (countStepEl) countStepEl.innerText = '-';
        if (btnPlay) {
            btnPlay.style.display = 'none';
            btnPlay.onclick = async () => {
                this.closeModal('modal-mods-sync');
                this.setActiveInstanceForDomain('cloud', instance.id);
                this.selectDribbbleMode('cloud');
                await this.launchCurrentInstance();
            };
        }

        this.updateDockStatus(`Synchronisation avec ${server.name}...`, 0);

        try {
            const result = await pelicanService.syncModsToInstance(
                server.id,
                modsPath,
                apiKey,
                panelUrl,
                (progress) => {
                    if (progress.percent !== undefined) {
                        this.updateDockStatus(progress.message, progress.percent);
                        if (progressPercent) progressPercent.innerText = `${progress.percent}%`;
                        if (progressBar) progressBar.style.width = `${progress.percent}%`;
                    }

                    if (progress.savedSpaceMo && statSaved) {
                        statSaved.innerText = `${progress.savedSpaceMo} Mo`;
                    }

                    if (progress.status === 'scan') {
                        if (progressLabel) progressLabel.innerText = 'Analyse des mods distants...';
                        if (currentModEl) currentModEl.innerText = progress.message;
                    } else if (progress.status === 'plan') {
                        if (statTotal) statTotal.innerText = progress.totalServerMods || 0;
                        if (statPool) statPool.innerText = `${progress.linkedFromPool || 0}`;
                        if (statDownload) statDownload.innerText = `${progress.toDownloadCount || 0}`;
                        if (progressLabel) progressLabel.innerText = progress.message;
                    } else if (progress.status === 'linking') {
                        if (currentModEl) currentModEl.innerText = progress.message;
                    } else if (progress.status === 'downloading') {
                        if (progressLabel) progressLabel.innerText = `Telechargement (${progress.current}/${progress.total})`;
                        if (currentModEl) currentModEl.innerText = progress.modName || '';
                        if (countStepEl) countStepEl.innerText = `${progress.filePercent || 0}%`;
                    } else if (progress.status === 'completed') {
                        if (progressLabel) progressLabel.innerText = 'Synchronisation terminee !';
                        if (currentModEl) currentModEl.innerText = `${progress.downloadedCount || 0} nouveau(x) mod(s) telecharge(s), ${progress.linkedFromPool || 0} lie(s) en RXSync.`;
                        if (countStepEl) countStepEl.innerText = 'Pret';
                    }
                },
                (tag, message) => {
                    this.logToSyncTerminal(tag, message);
                }
            );

            if (statTotal) statTotal.innerText = result.totalServerMods || 0;
            if (statPool) statPool.innerText = `${result.linkedFromPool || 0}`;
            if (statDownload) statDownload.innerText = `${result.downloadedCount || 0}`;
            if (statSaved && result.savedSpaceMo) statSaved.innerText = `${result.savedSpaceMo} Mo`;
            if (progressPercent) progressPercent.innerText = '100%';
            if (progressBar) progressBar.style.width = '100%';
            if (progressLabel) progressLabel.innerText = 'Instance prete !';
            if (currentModEl) currentModEl.innerText = `${result.downloadedCount} telecharge(s), ${result.linkedFromPool} lie(s) depuis le cache (0 Mo).`;
            if (btnPlay) btnPlay.style.display = 'inline-flex';

            this.showNotification(
                'RXSync Termine',
                `${result.downloadedCount} mod(s) telecharge(s), ${result.linkedFromPool} lie(s) sans duplication d'espace.`
            );
            this.setActiveInstanceForDomain('cloud', instance.id);
            this.loadInstances();

            if (autoLaunch) {
                setTimeout(async () => {
                    this.closeModal('modal-mods-sync');
                    this.selectDribbbleMode('cloud');
                    await this.launchCurrentInstance();
                }, 1200);
            }
        } catch (err) {
            console.error('[Sync error]:', err);
            this.logToSyncTerminal('error', `Erreur fatale de synchronisation : ${err.message}`);
            if (progressLabel) progressLabel.innerText = 'Erreur de synchronisation';
            if (currentModEl) currentModEl.innerText = err.message;
            this.showNotification('Erreur de synchronisation', err.message);
        } finally {
            this.isSyncing = false;
            setTimeout(() => this.updateDockStatus('Pret a jouer', 0), 3000);
        }
    }

    async selectCloudServer(server) {
        const instance = instanceService.getOrCreateServerInstance(server);
        this.setActiveInstanceForDomain('cloud', instance.id);
        this.selectDribbbleMode('cloud');
        this.showNotification('Serveur Sélectionné', `${server.name} est maintenant actif.`);
    }

    async handleJoinServer(server) {
        const account = this.getActiveAccount();
        const apiKey = store.get('apiKey');
        const panelUrl = store.get('panelUrl') || 'https://panel.rxcorp.me';

        // Auto-sync player to server whitelist before joining if credentials available
        if (account && apiKey) {
            try {
                await pelicanService.syncPlayerToServer(server.identifier || server.id, account, apiKey, panelUrl);
            } catch (_) {}
        }

        // 1. Sync mods via RXSync and automatically launch when done
        await this.handleSyncServerMods(server, true);
    }

    // ==========================================
    // PELICAN ⟷ MICROSOFT SYNC SYSTEM
    // ==========================================
    initPelicanSync() {
        const btnDashboardSync = document.getElementById('btn-sync-microsoft-pelican');
        const btnCloudSync = document.getElementById('btn-sync-cloud-account');
        const btnSettingsSync = document.getElementById('btn-sync-settings-action');

        const triggerSync = () => this.handlePelicanSync(false);

        btnDashboardSync?.addEventListener('click', triggerSync);
        btnCloudSync?.addEventListener('click', triggerSync);
        btnSettingsSync?.addEventListener('click', triggerSync);

        this.updatePelicanSyncUI();
    }

    async handlePelicanSync(silent = false) {
        const account = this.getActiveAccount();
        if (!account || !account.name) {
            if (!silent) this.showNotification('Compte requis', 'Sélectionnez un compte Minecraft actif avant de synchroniser.');
            return;
        }

        const isMicrosoft = account.meta?.type === 'Xbox' || (account.access_token && account.access_token !== 'null');
        if (!isMicrosoft && !silent) {
            const proceed = confirm(`Le compte actif "${account.name}" est un compte hors-ligne. Les serveurs Pelican officiels requièrent un compte Microsoft.\n\nVoulez-vous quand même synchroniser ce pseudo sur vos serveurs Pelican ?`);
            if (!proceed) return;
        }

        const apiKey = store.get('apiKey');
        const panelUrl = store.get('panelUrl') || 'https://panel.rxcorp.me';

        if (!apiKey) {
            if (!silent) {
                this.showNotification('Clé API manquante', 'Renseignez votre Clé API Pelican dans les Paramètres.');
                this.selectDribbbleMode('settings');
            }
            return;
        }

        const syncBtns = [
            document.getElementById('btn-sync-microsoft-pelican'),
            document.getElementById('btn-sync-cloud-account'),
            document.getElementById('btn-sync-settings-action')
        ];

        syncBtns.forEach(btn => {
            if (btn) {
                btn.disabled = true;
                btn.dataset.prevHtml = btn.innerHTML;
                btn.innerHTML = '<span>Synchronisation...</span>';
            }
        });

        try {
            this.updateDockStatus(`Synchronisation de ${account.name} avec Pelican...`);
            const res = await pelicanService.syncMicrosoftAccountToAllServers(account, apiKey, panelUrl, (prog) => {
                this.updateDockStatus(prog.message || 'Synchronisation Pelican...');
            });

            if (res.success) {
                store.set('pelicanMicrosoftSync', {
                    playerName: account.name,
                    playerUuid: account.uuid,
                    syncedAt: Date.now(),
                    syncedServers: res.syncedCount
                });
                this.showNotification('Synchronisation Réussie', `Compte ${account.name} synchronisé sur ${res.syncedCount} serveur(s) Pelican !`);
            } else {
                if (!silent) this.showNotification('Erreur Pelican', res.error || 'Aucun serveur synchronisé');
            }
        } catch (err) {
            console.error('[Pelican Sync Error]:', err);
            if (!silent) this.showNotification('Erreur de synchronisation', err.message);
        } finally {
            syncBtns.forEach(btn => {
                if (btn) {
                    btn.disabled = false;
                    if (btn.dataset.prevHtml) btn.innerHTML = btn.dataset.prevHtml;
                }
            });
            this.updateDockStatus('Prêt à jouer', 0);
            this.updatePelicanSyncUI();
        }
    }

    updatePelicanSyncUI() {
        const account = this.getActiveAccount();
        const syncData = store.get('pelicanMicrosoftSync');

        const isSynced = syncData && account && syncData.playerName && syncData.playerName.toLowerCase() === account.name.toLowerCase();

        // 1. Dashboard Banner Card 1
        const bannerText = document.getElementById('sync-banner-text');
        const bannerDot = document.getElementById('sync-banner-dot');
        const btnBannerText = document.getElementById('btn-sync-text');

        if (bannerText && bannerDot) {
            if (isSynced) {
                bannerDot.style.background = 'var(--emerald)';
                bannerDot.style.boxShadow = '0 0 8px var(--emerald)';
                const dateStr = syncData.syncedAt ? new Date(syncData.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                bannerText.innerHTML = `Compte <strong>${account.name}</strong> synchronisé (${syncData.syncedServers || 0} serveurs • ${dateStr})`;
                if (btnBannerText) btnBannerText.innerText = 'Re-sync';
            } else if (account) {
                bannerDot.style.background = 'var(--amber)';
                bannerDot.style.boxShadow = '0 0 8px var(--amber)';
                bannerText.innerHTML = `Compte <strong>${account.name}</strong> non synchronisé sur Pelican`;
                if (btnBannerText) btnBannerText.innerText = 'Synchroniser';
            } else {
                bannerDot.style.background = 'var(--text-dim)';
                bannerDot.style.boxShadow = 'none';
                bannerText.innerText = 'Connectez un compte pour synchroniser avec Pelican';
                if (btnBannerText) btnBannerText.innerText = 'Connexion';
            }
        }

        // 2. View Cloud Box
        const avatarElem = document.getElementById('sync-player-avatar');
        const titleElem = document.getElementById('sync-box-title');
        const subElem = document.getElementById('sync-box-sub');
        const statusBadge = document.getElementById('sync-badge-status');
        const btnCloudText = document.getElementById('btn-sync-cloud-text');

        if (avatarElem && account) {
            avatarElem.src = `https://mc-heads.net/avatar/${account.name}/36`;
            avatarElem.onerror = () => { avatarElem.src = 'assets/images/icon/icon.png'; };
        }

        if (titleElem && subElem) {
            if (isSynced) {
                titleElem.innerHTML = `Compte Microsoft <span style="color: var(--emerald);">Synchronisé</span> : ${account.name}`;
                subElem.innerText = `Votre joueur est autorisé sur la whitelist de vos serveurs Pelican Cloud (${syncData.syncedServers || 0} serveurs).`;
                if (statusBadge) statusBadge.style.background = 'var(--emerald)';
                if (btnCloudText) btnCloudText.innerText = 'Re-synchroniser Whitelist';
            } else if (account) {
                titleElem.innerHTML = `Compte Microsoft Détecté : ${account.name}`;
                subElem.innerText = `Cliquez pour propager automatiquement la whitelist de ${account.name} sur tous vos serveurs Pelican.`;
                if (statusBadge) statusBadge.style.background = 'var(--amber)';
                if (btnCloudText) btnCloudText.innerText = 'Synchroniser Whitelist';
            } else {
                titleElem.innerText = 'Aucun compte Minecraft actif';
                subElem.innerText = 'Connectez votre compte Microsoft pour synchroniser automatiquement vos serveurs.';
                if (statusBadge) statusBadge.style.background = 'var(--text-dim)';
            }
        }

        // 3. Settings Card
        const settingsIndicator = document.getElementById('sync-settings-indicator');
        const settingsDesc = document.getElementById('sync-settings-desc');
        const btnSettings = document.getElementById('btn-sync-settings-action');

        if (settingsIndicator && settingsDesc) {
            if (isSynced) {
                settingsIndicator.style.background = 'var(--emerald)';
                settingsIndicator.style.boxShadow = '0 0 6px var(--emerald)';
                settingsDesc.innerHTML = `Compte <strong>${account.name}</strong> synchronisé avec succès sur Pelican Cloud.`;
                if (btnSettings) btnSettings.innerText = 'Re-sync';
            } else if (account) {
                settingsIndicator.style.background = 'var(--amber)';
                settingsIndicator.style.boxShadow = '0 0 6px var(--amber)';
                settingsDesc.innerHTML = `Compte <strong>${account.name}</strong> prêt à être synchronisé sur vos serveurs Pelican.`;
                if (btnSettings) btnSettings.innerText = 'Synchroniser';
            } else {
                settingsIndicator.style.background = 'var(--text-dim)';
                settingsIndicator.style.boxShadow = 'none';
                settingsDesc.innerText = 'Connectez un compte Microsoft pour activer la liaison automatique Pelican.';
            }
        }
    }

    // ==========================================
    // LOADER METADATA & BRANDING (OFFICIAL ASSETS)
    // ==========================================
    getLoaderMeta(loader = 'fabric', name = '') {
        const l = (loader || '').toLowerCase();
        const n = (name || '').toLowerCase();
        if (l.includes('vanilla') || n.includes('vanilla')) {
            return {
                name: 'VANILLA',
                icon: 'assets/images/loaders/vanilla.svg',
                color: '#22c55e',
                bg: 'rgba(34, 197, 94, 0.12)',
                border: 'rgba(34, 197, 94, 0.25)'
            };
        }
        if (l.includes('neoforge') || n.includes('neoforge')) {
            return {
                name: 'NEOFORGE',
                icon: 'assets/images/loaders/neoforge.svg',
                color: '#f97316',
                bg: 'rgba(249, 115, 22, 0.12)',
                border: 'rgba(249, 115, 22, 0.25)'
            };
        }
        if (l.includes('forge') || n.includes('forge')) {
            return {
                name: 'FORGE',
                icon: 'assets/images/loaders/forge.png',
                color: '#ef4444',
                bg: 'rgba(239, 68, 68, 0.12)',
                border: 'rgba(239, 68, 68, 0.25)'
            };
        }
        if (l.includes('quilt') || n.includes('quilt')) {
            return {
                name: 'QUILT',
                icon: 'assets/images/loaders/quilt.svg',
                color: '#a855f7',
                bg: 'rgba(168, 85, 247, 0.12)',
                border: 'rgba(168, 85, 247, 0.25)'
            };
        }
        return {
            name: 'FABRIC',
            icon: 'assets/images/loaders/fabric.svg',
            color: '#6366f1',
            bg: 'rgba(99, 102, 241, 0.12)',
            border: 'rgba(99, 102, 241, 0.25)'
        };
    }

    // ==========================================
    // INSTANCES MANAGEMENT (LOCAL PROFILES)
    // ==========================================
    async loadInstances() {
        // Ensure standard starter instances exist so the grid is populated naturally
        instanceService.ensureDefaultProfiles();

        const localInstances = instanceService.getLocalInstances();
        const grid = document.getElementById('instances-grid');
        const selectTarget = document.getElementById('select-target-instance');

        // Mod target select dropdown:
        if (selectTarget) {
            let options = '';
            if (localInstances.length > 0) {
                options = localInstances.map(i => {
                    const m = this.getLoaderMeta(i.loader, i.name);
                    return `<option value="${i.id}">${i.name} (${i.version} ${m.name})</option>`;
                }).join('');
            } else {
                options = `<option value="">Aucun profil local</option>`;
            }
            selectTarget.innerHTML = options;
        }

        // Active instance update
        const curDomain = this.getCurrentDomain();
        this.activeInstance = this.getActiveInstanceForDomain(curDomain);
        this.updateDockInstancePill();

        // Populate Local Instances Grid (view-instances)
        if (grid) {
            grid.innerHTML = '';
            if (localInstances.length === 0) {
                grid.innerHTML = `
                    <div class="rx-card" style="grid-column: 1/-1; text-align: center; padding: 36px 24px; background: var(--rx-chassis-panel); border: 1px solid var(--rx-edge-rim); border-radius: var(--radius-md);">
                        <h3 style="font-family: var(--font-display); font-size: 16px; font-weight: 700; color: var(--rx-type-readout); margin-bottom: 8px;">Aucun profil local configuré</h3>
                        <p style="color: var(--rx-type-dim); margin-bottom: 16px; font-size: 12.5px; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.5;">
                            Créez votre première installation autonome (NeoForge, Fabric, Forge ou Vanilla) pour lancer vos modpacks et personnaliser vos shaders.
                        </p>
                        <button class="rx-btn rx-btn-primary" id="btn-create-first-instance" style="font-family: var(--font-display); font-weight: 800; font-stretch: semi-condensed;">
                            Créer mon premier profil
                        </button>
                    </div>
                `;
                document.getElementById('btn-create-first-instance')?.addEventListener('click', () => {
                    this.openModal('modal-create-instance');
                });
            } else {
                for (const inst of localInstances) {
                    const card = document.createElement('div');
                    card.className = 'server-card';
                    const isCurrentLocal = (inst.id === this.activeLocalInstanceId);
                    if (isCurrentLocal) {
                        card.classList.add('active-local-card');
                    }

                    const meta = this.getLoaderMeta(inst.loader, inst.name);
                    const iconMarkup = `
                        <div style="width: 44px; height: 44px; min-width: 44px; border-radius: 10px; background: ${meta.bg}; border: 1px solid ${meta.border}; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.35);">
                            <img src="${meta.icon}" alt="${meta.name}" style="width: 28px; height: 28px; object-fit: contain;">
                        </div>
                    `;

                    card.innerHTML = `
                        <div class="server-card-top">
                            <div style="display: flex; align-items: center; gap: 12px; overflow: hidden;">
                                ${iconMarkup}
                                <div class="server-name-box">
                                    <h3 class="server-name" title="${inst.name}">${inst.name}</h3>
                                    <span style="font-size: 11px; color: var(--text-dim);">Minecraft ${inst.version || '1.21.4'} • <span style="color: ${meta.color}; font-weight: 600;">${meta.name}</span></span>
                                </div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                ${isCurrentLocal ? '<span class="instance-active-badge">Actif</span>' : ''}
                                <button class="icon-tool-btn btn-rename-instance" data-id="${inst.id}" data-name="${inst.name}" title="Renommer">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </button>
                                <button class="icon-tool-btn btn-delete-instance" data-id="${inst.id}" title="Supprimer">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                </button>
                            </div>
                        </div>

                        <div class="server-stats-row">
                            <div class="stat-item">
                                <span class="stat-label">VERSION</span>
                                <span class="stat-value" style="color: var(--emerald-light);">${inst.version || '1.21.4'}</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">MODLOADER</span>
                                <span class="stat-value" style="color: ${meta.color}; font-weight: 700;">${meta.name}</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">MODS</span>
                                <span class="stat-value">${inst.modCount || 0} actif(s)</span>
                            </div>
                        </div>

                        <div class="server-actions">
                            <button class="rx-btn ${isCurrentLocal ? 'rx-btn-secondary' : 'rx-btn-primary'} btn-select-instance" style="flex: 1.2; font-weight: 700;" data-id="${inst.id}">
                                <span>${isCurrentLocal ? 'Profil Actif' : 'Sélectionner'}</span>
                            </button>
                            <button class="rx-btn rx-btn-secondary btn-folder-instance" title="Ouvrir le dossier dans l'explorateur" style="flex: 1; font-weight: 600;" data-id="${inst.id}">
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                                <span>Ouvrir ↗</span>
                            </button>
                        </div>
                    `;

                    card.querySelector('.btn-select-instance').addEventListener('click', () => {
                        this.setActiveInstanceForDomain('local', inst.id);
                        this.loadInstances();
                        this.renderDashboardLists();
                    });

                    card.querySelector('.btn-folder-instance').addEventListener('click', () => {
                        instanceService.openFolder(inst.id);
                    });

                    card.querySelector('.btn-rename-instance').addEventListener('click', () => {
                        const currentName = inst.name;
                        const newName = prompt('Entrez le nouveau nom pour ce profil :', currentName);
                        if (newName && newName.trim() && newName.trim() !== currentName) {
                            instanceService.renameInstance(inst.id, newName.trim());
                            this.loadInstances();
                            this.renderDashboardLists();
                            this.showNotification('Profil renommé', `Nouveau nom : ${newName.trim()}`);
                        }
                    });

                    card.querySelector('.btn-delete-instance').addEventListener('click', () => {
                        if (confirm(`Voulez-vous vraiment supprimer le profil local "${inst.name}" ?`)) {
                            instanceService.deleteInstance(inst.id);
                            if (this.activeLocalInstanceId === inst.id) {
                                this.activeLocalInstanceId = null;
                                store.delete('activeLocalInstanceId');
                            }
                            this.loadInstances();
                            this.renderDashboardLists();
                            this.showNotification('Profil supprimé', `Le profil "${inst.name}" a été supprimé.`);
                        }
                    });

                    grid.appendChild(card);
                }
            }
        }
        this.renderDashboardLists();
    }

    updateDockInstancePill() {
        const nameElem = document.getElementById('dock-instance-name');
        const subElem = document.getElementById('dock-instance-sub');
        const iconElem = document.getElementById('dock-instance-icon');
        if (!nameElem || !subElem) return;

        const curDomain = this.getCurrentDomain();
        const inst = this.getActiveInstanceForDomain(curDomain);

        if (inst) {
            nameElem.innerText = inst.name;
            const meta = this.getLoaderMeta(inst.loader, inst.name);
            if (iconElem) {
                iconElem.src = inst.domain === 'cloud' ? 'assets/images/loaders/vanilla.svg' : meta.icon;
                iconElem.alt = meta.name;
                iconElem.style.display = 'block';
            }
            if (inst.domain === 'cloud') {
                subElem.innerText = `Serveur Cloud RXCORP • ${inst.loader ? inst.loader.toUpperCase() : 'SURVIE'}`;
            } else {
                subElem.innerText = `Profil Local • MC ${inst.version || '1.21.4'} • ${meta.name}`;
            }
        } else {
            if (iconElem) iconElem.style.display = 'none';
            if (curDomain === 'cloud') {
                nameElem.innerText = 'Aucun serveur Cloud';
                subElem.innerText = 'Sélectionnez un serveur Pelican';
            } else {
                nameElem.innerText = 'Aucun profil local';
                subElem.innerText = 'Cliquez pour créer un profil';
            }
        }

        this.updateTelemetryConsole();
    }

    updateTelemetryConsole() {
        const infraStatus = document.getElementById('telemetry-infra-status');
        const infraSub = document.getElementById('telemetry-infra-sub');
        const infraDot = document.getElementById('telemetry-infra-dot');
        const pingVal = document.getElementById('telemetry-network-ping');
        const pingSub = document.getElementById('telemetry-network-sub');
        const heroPing = document.getElementById('hero-ping-val');
        const ramAlloc = document.getElementById('telemetry-ram-alloc');
        const ramSub = document.getElementById('telemetry-ram-sub');
        const whitelistStatus = document.getElementById('telemetry-whitelist-status');
        const whitelistSub = document.getElementById('telemetry-whitelist-sub');

        // 1. RAM Allocation
        const ramGb = store.get('ramMax') || 6;
        if (ramAlloc) ramAlloc.innerHTML = `<span>${ramGb}.0 Go</span>`;
        if (ramSub) ramSub.innerText = `Heap JVM (Min ${Math.max(1, Math.floor(ramGb / 2))} Go / Max ${ramGb} Go)`;

        // 2. Pelican Server Status & Ping
        const firstServer = this.cloudServers && this.cloudServers[0];
        const targetIp = firstServer?.ip || 'node.rxcorp.me';
        const targetPort = firstServer?.port || 25566;

        if (firstServer && firstServer.isOnline !== undefined) {
            const isOnline = firstServer.isOnline || firstServer.status === 'running';
            if (infraStatus) {
                infraStatus.innerHTML = isOnline 
                    ? `<span style="color: var(--rx-signal-live);">En Ligne (${firstServer.playersOnline !== undefined && firstServer.playersOnline !== null ? firstServer.playersOnline : '0'}/${firstServer.playersMax || 20})</span>`
                    : `<span style="color: var(--rx-signal-danger);">Hors-Ligne</span>`;
            }
            if (infraDot) {
                infraDot.style.backgroundColor = isOnline ? 'var(--rx-signal-live)' : 'var(--rx-signal-danger)';
            }
            if (infraSub) {
                infraSub.innerText = `${targetIp}:${targetPort}`;
            }

            const latency = firstServer.ping || 9;
            if (pingVal) pingVal.innerHTML = `<span>${latency} ms</span>`;
            if (heroPing) heroPing.innerText = `${latency} ms`;
            if (pingSub) pingSub.innerText = latency < 50 ? 'Excellente connexion' : 'Connexion stable';
        } else {
            // Actively ping primary node directly
            pelicanService.pingMinecraftServer(targetIp, targetPort, 2500).then(res => {
                const isOnline = !!res?.online;
                if (infraStatus) {
                    infraStatus.innerHTML = isOnline 
                        ? `<span style="color: var(--rx-signal-live);">En Ligne (${res.playersOnline !== null && res.playersOnline !== undefined ? res.playersOnline : '0'}/${res.playersMax || 20})</span>`
                        : `<span style="color: var(--rx-signal-danger);">Hors-Ligne</span>`;
                }
                if (infraDot) {
                    infraDot.style.backgroundColor = isOnline ? 'var(--rx-signal-live)' : 'var(--rx-signal-danger)';
                }
                if (infraSub) {
                    infraSub.innerText = `${targetIp}:${targetPort}`;
                }
                const latency = (res && res.latency) ? res.latency : 9;
                if (pingVal) pingVal.innerHTML = `<span>${latency} ms</span>`;
                if (heroPing) heroPing.innerText = `${latency} ms`;
                if (pingSub) pingSub.innerText = latency < 50 ? 'Excellente connexion' : 'Connexion stable';
            }).catch(() => {
                if (infraStatus) infraStatus.innerHTML = `<span>Sonde active</span>`;
                if (infraSub) infraSub.innerText = `${targetIp}:${targetPort}`;
                if (pingVal) pingVal.innerHTML = `<span>9 ms</span>`;
                if (pingSub) pingSub.innerText = `Sonde SLP active`;
            });
        }

        // 3. Whitelist & Security
        const isPelicanLinked = !!store.get('apiKey');
        const activeAccount = this.getActiveAccount();
        if (whitelistStatus) {
            if (isPelicanLinked && activeAccount) {
                whitelistStatus.innerHTML = `<span style="color: var(--rx-signal-live);">Synchronisée</span>`;
                if (whitelistSub) whitelistSub.innerText = `${activeAccount.name} lié`;
            } else if (activeAccount) {
                whitelistStatus.innerHTML = `<span>Compte détecté</span>`;
                if (whitelistSub) whitelistSub.innerText = `${activeAccount.name} (Local)`;
            } else {
                whitelistStatus.innerHTML = `<span>En attente</span>`;
                if (whitelistSub) whitelistSub.innerText = `Aucun joueur lié`;
            }
        }
    }

    updatePublicServersStatus() {
        // Ping play.rxcorp.me:25565 (Survie)
        pelicanService.pingMinecraftServer('play.rxcorp.me', 25565, 3000).then(res => {
            const badge = document.getElementById('badge-public-survie');
            if (!badge) return;
            if (res && res.online) {
                badge.className = 'server-badge online';
                const players = (res.playersOnline !== null && res.playersOnline !== undefined) ? ` (${res.playersOnline}/${res.playersMax || 20})` : '';
                badge.innerHTML = `<span class="rx-signal-dot"></span><span class="badge-text">En Ligne${players}</span>`;
            } else {
                badge.className = 'server-badge offline';
                badge.innerHTML = `<span class="rx-signal-dot"></span><span class="badge-text">Hors-Ligne</span>`;
            }
        }).catch(() => {});

        // Ping node.rxcorp.me:25566 (Modded)
        pelicanService.pingMinecraftServer('node.rxcorp.me', 25566, 3000).then(res => {
            const badge = document.getElementById('badge-public-modded');
            if (!badge) return;
            if (res && res.online) {
                badge.className = 'server-badge online';
                const players = (res.playersOnline !== null && res.playersOnline !== undefined) ? ` (${res.playersOnline}/${res.playersMax || 20})` : '';
                badge.innerHTML = `<span class="rx-signal-dot"></span><span class="badge-text">En Ligne${players}</span>`;
            } else {
                badge.className = 'server-badge offline';
                badge.innerHTML = `<span class="rx-signal-dot"></span><span class="badge-text">Hors-Ligne</span>`;
            }
        }).catch(() => {});
    }

    // ==========================================
    // MOD DOWNLOADER (MODRINTH & CURSEFORGE)
    // ==========================================
    initModDownloader() {
        const searchInput = document.getElementById('input-mod-search');
        const searchBtn = document.getElementById('btn-search-mods');
        const btnModrinth = document.getElementById('btn-source-modrinth');
        const btnCurseForge = document.getElementById('btn-source-curseforge');

        btnModrinth?.addEventListener('click', () => {
            this.activeModSource = 'modrinth';
            btnModrinth.classList.add('active');
            btnCurseForge?.classList.remove('active');
            this.triggerModSearch();
        });

        btnCurseForge?.addEventListener('click', () => {
            this.activeModSource = 'curseforge';
            btnCurseForge.classList.add('active');
            btnModrinth?.classList.remove('active');
            this.triggerModSearch();
        });

        const chips = document.querySelectorAll('.mod-chip');
        chips.forEach(chip => {
            chip.addEventListener('click', () => {
                chips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this.activeModCategory = chip.dataset.cat || '';
                this.triggerModSearch();
            });
        });

        searchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.triggerModSearch();
            }
        });

        searchBtn?.addEventListener('click', () => {
            this.triggerModSearch();
        });

        // Trigger initial mod list
        this.triggerModSearch();
    }

    async triggerModSearch() {
        const searchInput = document.getElementById('input-mod-search');
        const query = searchInput ? searchInput.value.trim() : '';
        const targetInstId = document.getElementById('select-target-instance')?.value;
        const targetInst = targetInstId ? instanceService.getInstance(targetInstId) : this.getActiveInstanceForDomain('local');

        const grid = document.getElementById('modrinth-mods-grid');
        if (!grid) return;

        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">
                Recherche de mods sur ${this.activeModSource === 'curseforge' ? 'CurseForge' : 'Modrinth'}...
            </div>
        `;

        let res = null;

        if (this.activeModSource === 'curseforge') {
            res = await curseforgeService.searchMods({
                query: query,
                version: targetInst?.version,
                loader: targetInst?.loader,
                limit: 24
            });

            if (res.needApiKey) {
                grid.innerHTML = `
                    <div class="rx-card" style="grid-column: 1/-1; padding: 30px; text-align: center; max-width: 480px; margin: 20px auto;">
                        <div style="margin-bottom: 8px; opacity: 0.7; display: flex; justify-content: center;">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-1.5 1.5L14 9l-1.5-1.5M7 14l-4 4 2 2 4-4m-2-2l3-3a5.5 5.5 0 1 1 7.78-7.78L21 2l-5.5 5.5"/></svg>
                        </div>
                        <h3 style="color: #fff; margin-bottom: 8px;">Clé API CurseForge requise</h3>
                        <p style="font-size: 12.5px; color: var(--text-dim); margin-bottom: 16px;">
                            CurseForge requiert une clé API personnelle. Entrez votre clé ci-dessous ou utilisez <strong>Modrinth</strong> (sans clé).
                        </p>
                        <input id="input-inline-curseforge" type="password" class="form-input" placeholder="Entrez votre clé API CurseForge (Optionnel)" style="margin-bottom: 12px;">
                        <button id="btn-save-inline-curseforge" class="rx-btn rx-btn-primary" style="width: 100%;">
                            Enregistrer la clé CurseForge
                        </button>
                    </div>
                `;
                document.getElementById('btn-save-inline-curseforge')?.addEventListener('click', () => {
                    const key = document.getElementById('input-inline-curseforge')?.value.trim();
                    if (key) {
                        curseforgeService.setApiKey(key);
                        this.showNotification('Clé sauvegardée', 'Recherche CurseForge activée.');
                        this.triggerModSearch();
                    }
                });
                return;
            }
        } else {
            res = await modrinthService.searchMods({
                query: query,
                version: targetInst?.version,
                loader: targetInst?.loader,
                category: this.activeModCategory || null,
                limit: 24
            });
        }

        if (!res.success || !res.mods || !res.mods.length) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-dim);">
                    ${res.error || 'Aucun mod trouvé pour cette recherche.'}
                </div>
            `;
            return;
        }

        grid.innerHTML = '';
        for (const mod of res.mods) {
            const card = document.createElement('div');
            card.className = 'mod-card';

            let iconSrc = mod.iconUrl;
            const searchKey = `${mod.slug || ''} ${mod.title || ''}`.toLowerCase();
            if (!iconSrc || (iconSrc.includes('icon.png') && !iconSrc.includes('modrinth') && !iconSrc.includes('cursecdn'))) {
                if (searchKey.includes('sodium')) {
                    iconSrc = 'https://cdn.modrinth.com/data/AANobbMI/icon.png';
                } else if (searchKey.includes('iris')) {
                    iconSrc = 'https://cdn.modrinth.com/data/YL57xq9U/icon.png';
                } else if (searchKey.includes('distant') || searchKey.includes('horizon')) {
                    iconSrc = 'https://cdn.modrinth.com/data/u6msX0Oc/icon.png';
                } else if (searchKey.includes('fabric-api') || searchKey.includes('fabric api')) {
                    iconSrc = 'https://cdn.modrinth.com/data/P7dR8mSH/icon.png';
                } else if (searchKey.includes('appleskin')) {
                    iconSrc = 'https://cdn.modrinth.com/data/EsAfCjCV/icon.png';
                } else if (searchKey.includes('jei') || searchKey.includes('just enough')) {
                    iconSrc = 'https://cdn.modrinth.com/data/u6dRKJwZ/icon.png';
                } else {
                    iconSrc = 'assets/images/icon/icon.png';
                }
            }

            const rawDownloads = Number(mod.downloads) || 0;
            const downloadsFormatted = rawDownloads >= 1000000 
                ? (rawDownloads / 1000000).toFixed(1) + 'M' 
                : (rawDownloads >= 1000 ? (rawDownloads / 1000).toFixed(0) + 'k' : rawDownloads);

            const rawFollows = Number(mod.follows) || 0;
            const followsFormatted = rawFollows >= 1000
                ? (rawFollows / 1000).toFixed(1) + 'k'
                : rawFollows;

            const sourceBadge = this.activeModSource === 'curseforge' ? 'CurseForge' : 'Modrinth';
            const categories = (mod.categories || []).slice(0, 2);

            card.innerHTML = `
                <div>
                    <div class="mod-card-header">
                        <img class="mod-icon" src="${iconSrc}" alt="${mod.title}" onerror="this.onerror=null;this.src='assets/images/icon/icon.png'">
                        <div class="mod-info-box">
                            <div class="mod-title" title="${mod.title}">${mod.title}</div>
                            <div class="mod-author">par ${mod.author || 'Auteur inconnu'}</div>
                            <div class="mod-tags-row">
                                <span class="mod-tag-badge" style="color: ${this.activeModSource === 'curseforge' ? 'var(--amber)' : 'var(--emerald)'};">${sourceBadge}</span>
                                ${categories.map(c => `<span class="mod-tag-badge">${c}</span>`).join('')}
                            </div>
                        </div>
                    </div>
                    <div class="mod-desc" style="margin-top: 10px;" title="${mod.description || ''}">
                        ${mod.description || 'Aucune description fournie.'}
                    </div>
                </div>
                <div class="mod-footer">
                    <div class="mod-stats">
                        <span title="${rawDownloads} téléchargements">${downloadsFormatted} dl</span>
                        <span title="${rawFollows} favoris">${followsFormatted} favoris</span>
                    </div>
                    <button class="rx-btn rx-btn-secondary btn-install-mod" data-id="${mod.id || mod.slug}" data-source="${this.activeModSource}">
                        <span>Installer</span>
                    </button>
                </div>
            `;

            card.querySelector('.btn-install-mod').addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.innerHTML = '<span>Installation...</span>';

                const currentTargetId = document.getElementById('select-target-instance')?.value || this.activeInstance?.id;
                const inst = instanceService.getInstance(currentTargetId) || this.getActiveInstanceForDomain('local');

                if (!inst) {
                    this.showNotification('Profil requis', 'Sélectionnez un profil local cible avant d\'installer un mod.');
                    btn.disabled = false;
                    btn.innerHTML = '<span>Installer</span>';
                    return;
                }

                try {
                    if (this.activeModSource === 'curseforge') {
                        const filesRes = await curseforgeService.getCompatibleVersions(mod.id, inst.version, inst.loader);
                        if (!filesRes.success || !filesRes.versions.length) {
                            this.showNotification('Incompatible', `Aucun fichier CurseForge pour MC ${inst.version} (${inst.loader})`);
                            btn.disabled = false;
                            btn.innerHTML = '<span>Installer</span>';
                            return;
                        }
                        const file = filesRes.versions[0];
                        await curseforgeService.installMod(inst.modsPath, file.downloadUrl, file.fileName);
                    } else {
                        const versionsRes = await modrinthService.getCompatibleVersions(mod.slug, inst.version, inst.loader);
                        if (!versionsRes.success || !versionsRes.versions.length) {
                            this.showNotification('Incompatible', `Aucune version Modrinth pour MC ${inst.version} (${inst.loader})`);
                            btn.disabled = false;
                            btn.innerHTML = '<span>Installer</span>';
                            return;
                        }
                        const file = versionsRes.versions[0];
                        await modrinthService.installMod(inst.modsPath, file.downloadUrl, file.fileName);
                    }

                    btn.innerHTML = '<span>Installé</span>';
                    btn.classList.remove('rx-btn-primary');
                    btn.classList.add('rx-btn-secondary');
                    this.showNotification('Mod installé !', `« ${mod.title} » a été ajouté à ${inst.name}.`);
                    this.loadInstances();
                } catch (err) {
                    this.showNotification('Erreur de téléchargement', err.message);
                    btn.disabled = false;
                    btn.innerHTML = '<span>Installer</span>';
                }
            });

            grid.appendChild(card);
        }
    }

    // ==========================================
    // GAME LAUNCH DOCK
    // ==========================================
    initLaunchDock() {
        const launchBtn = document.getElementById('btn-launch-game');
        launchBtn?.addEventListener('click', () => {
            this.launchCurrentInstance();
        });

        document.getElementById('dock-instance-pill')?.addEventListener('click', () => {
            const domain = this.getCurrentDomain();
            if (domain === 'cloud') {
                this.openDrawer('cloud', 'SERVEURS PELICAN CLOUD');
            } else {
                this.openDrawer('instances', 'MES PROFILS & MODPACKS');
            }
        });
    }

    async launchCurrentInstance() {
        const targetInst = this.getActiveInstanceForDomain();
        if (!targetInst) {
            const domain = this.getCurrentDomain();
            if (domain === 'cloud') {
                this.showNotification('Aucun serveur', 'Sélectionnez un serveur Cloud Pelican ou connectez-vous.');
                this.openDrawer('cloud', 'SERVEURS PELICAN CLOUD');
            } else {
                this.showNotification('Aucun profil', 'Créez ou sélectionnez un profil local d\'abord.');
                this.openDrawer('instances', 'MES PROFILS & MODPACKS');
            }
            return;
        }

        this.activeInstance = targetInst;

        const launchBtn = document.getElementById('btn-launch-game');
        launchBtn.disabled = true;
        launchBtn.innerHTML = '<span>LANCEMENT...</span>';

        let ramMax = store.get('ramMax') || 6;
        if (ramMax > 100) ramMax = Math.round(ramMax / 1024);
        const javaPath = store.get('javaPath') || null;
        const account = this.getActiveAccount();

        // Discord RPC Launching Event
        ipcRenderer.send('discord-rpc-launching', targetInst.name);

        try {
            await gameLauncher.launch(
                this.activeInstance,
                account,
                {
                    ramMin: Math.max(1, Math.floor(ramMax / 2)),
                    ramMax: ramMax,
                    javaPath: javaPath,
                    autoConnect: store.get('autoConnect') !== false
                },
                {
                    onStatus: (msg) => this.updateDockStatus(msg),
                    onProgress: (percent) => this.updateDockStatus(null, percent),
                    onSpeed: (speed) => console.log(`Speed: ${speed} MB/s`),
                    onGameStart: () => {
                        this.updateDockStatus('Minecraft est en cours d\'exécution...', 100);
                        launchBtn.innerHTML = '<span>EN JEU</span>';
                        // Discord RPC In-Game
                        ipcRenderer.send('discord-rpc-playing', targetInst.name);
                    },
                    onGameClose: () => {
                        this.updateDockStatus('Prêt à jouer', 0);
                        launchBtn.disabled = false;
                        launchBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg><span id="hero-play-label">JOUER</span>';
                        // Discord RPC Idle
                        ipcRenderer.send('discord-rpc-idle');
                    },
                    onError: (err) => {
                        this.showNotification('Erreur de lancement', err.message || String(err));
                        this.updateDockStatus('Erreur de lancement', 0);
                        launchBtn.disabled = false;
                        launchBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg><span id="hero-play-label">JOUER</span>';
                        // Discord RPC Idle
                        ipcRenderer.send('discord-rpc-idle');
                    }
                }
            );
        } catch (err) {
            launchBtn.disabled = false;
            launchBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg><span id="hero-play-label">JOUER</span>';
            ipcRenderer.send('discord-rpc-idle');
        }
    }

    updateDockStatus(message = null, percent = null) {
        const statusText = document.getElementById('dock-status');
        const progressContainer = document.getElementById('dock-progress-container');
        const progressFill = document.getElementById('dock-progress-fill');

        if (message !== null && statusText) {
            statusText.innerText = message;
        }

        if (percent !== null && progressContainer && progressFill) {
            if (percent > 0 && percent < 100) {
                progressContainer.style.display = 'block';
                progressFill.style.width = `${percent}%`;
            } else {
                progressContainer.style.display = 'none';
                progressFill.style.width = '0%';
            }
        }
    }

    // ==========================================
    // SETTINGS & ACCOUNTS
    // ==========================================
    initSettings() {
        const labelRam = document.getElementById('label-ram-max');
        const ramButtons = document.querySelectorAll('.ram-pill-btn');
        const inputJava = document.getElementById('input-java-path');
        const inputUrl = document.getElementById('settings-panel-url');
        const inputKey = document.getElementById('settings-panel-key');
        const inputCurseForge = document.getElementById('input-curseforge-key');
        const btnSave = document.getElementById('btn-save-settings');

        // Populate saved RAM
        let currentRam = store.get('ramMax') || 6;
        if (currentRam > 100) currentRam = Math.round(currentRam / 1024);
        if (![4, 6, 8, 16].includes(currentRam)) currentRam = 6;

        const updateRamUI = (val) => {
            currentRam = val;
            ramButtons.forEach(btn => {
                const btnVal = parseInt(btn.getAttribute('data-ram'), 10);
                btn.classList.toggle('active', btnVal === val);
            });
            if (labelRam) {
                labelRam.innerText = `${val} Go ${val === 6 ? '• (Recommandé)' : ''}`;
            }
        };

        ramButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const val = parseInt(btn.getAttribute('data-ram'), 10);
                if (val) {
                    updateRamUI(val);
                    store.set('ramMax', val);
                }
            });
        });

        updateRamUI(currentRam);

        if (inputJava) inputJava.value = store.get('javaPath') || '';
        if (inputUrl) inputUrl.value = store.get('panelUrl') || 'https://panel.rxcorp.me';
        if (inputKey) inputKey.value = store.get('apiKey') || '';
        if (inputCurseForge) inputCurseForge.value = store.get('curseforgeApiKey') || '';

        // Auto-connect toggle setting
        const toggleAutoConnect = document.getElementById('toggle-auto-connect');
        if (toggleAutoConnect) {
            toggleAutoConnect.checked = store.get('autoConnect') !== false;
            toggleAutoConnect.addEventListener('change', () => {
                store.set('autoConnect', toggleAutoConnect.checked);
            });
        }

        // Mode Selection Handler (Cloud Server vs Local Player / Friends)
        this.initModeSelector();
        this.initLinkSyncPoolSettings();

        btnSave?.addEventListener('click', () => {
            store.set('ramMax', currentRam);
            store.set('javaPath', inputJava ? inputJava.value.trim() : '');
            store.set('panelUrl', inputUrl ? inputUrl.value.trim() : '');
            store.set('apiKey', inputKey ? inputKey.value.trim() : '');
            if (toggleAutoConnect) {
                store.set('autoConnect', toggleAutoConnect.checked);
            }

            if (inputCurseForge) {
                curseforgeService.setApiKey(inputCurseForge.value.trim());
            }

            this.showNotification('Paramètres sauvegardés', 'Vos réglages ont été mis à jour.');
            this.loadCloudServers();
        });

        // Cloud login button on the cloud tab
        document.getElementById('btn-login-cloud')?.addEventListener('click', () => {
            const key = document.getElementById('input-panel-key').value.trim();
            const url = document.getElementById('input-panel-url').value.trim();

            if (!key) {
                this.showNotification('Clé manquante', 'Entrez une clé API Client valide.');
                return;
            }

            store.set('apiKey', key);
            store.set('panelUrl', url);
            this.loadCloudServers();
        });

        const btnDisconnectPanel = document.getElementById('btn-disconnect-panel');
        if (btnDisconnectPanel) {
            btnDisconnectPanel.style.display = store.get('apiKey') ? 'inline-flex' : 'none';
        }

        // Test panel connection button
        document.getElementById('btn-test-panel')?.addEventListener('click', async () => {
            const key = inputKey.value.trim();
            const url = inputUrl.value.trim();
            const res = await pelicanService.testConnection(key, url);
            if (res.success) {
                store.set('pelicanUser', {
                    username: res.user.username,
                    email: res.user.email,
                    admin: !!res.user.admin
                });
                if (btnDisconnectPanel) btnDisconnectPanel.style.display = 'inline-flex';
                this.showNotification('Connexion réussie !', `Connecté : ${res.user.username} (${res.user.email})`);
                this.loadCloudServers();
                this.updatePelicanSyncUI();
            } else {
                this.showNotification('Échec de connexion', res.error);
            }
        });

        // Disconnect panel button
        btnDisconnectPanel?.addEventListener('click', () => {
            this.disconnectPelican();
        });
    }

    disconnectPelican() {
        store.set('apiKey', '');
        store.delete('pelicanUser');
        store.delete('pelicanAdminScope');
        store.delete('pelicanMicrosoftSync');
        const inputKey = document.getElementById('settings-panel-key');
        if (inputKey) inputKey.value = '';
        const inputKeyManual = document.getElementById('input-manual-key-cloud');
        if (inputKeyManual) inputKeyManual.value = '';
        const btnDisconnect = document.getElementById('btn-disconnect-panel');
        if (btnDisconnect) btnDisconnect.style.display = 'none';

        this.showNotification('Déconnecté', 'Vous avez été déconnecté du Panel Pelican.');
        this.loadCloudServers();
        this.updatePelicanSyncUI();
    }

    initModeSelector() {
        const cardCloud = document.getElementById('card-mode-cloud');
        const cardLocal = document.getElementById('card-mode-local');
        const pelicanSettingsCard = document.getElementById('settings-card-pelican');

        const currentHasServer = store.get('hasPelicanServer') ?? (store.get('apiKey') ? true : false);

        const applyModeUI = (hasServer) => {
            if (cardCloud && cardLocal) {
                cardCloud.classList.toggle('active-cloud', hasServer);
                cardLocal.classList.toggle('active-local', !hasServer);
            }
            if (pelicanSettingsCard) {
                pelicanSettingsCard.style.opacity = hasServer ? '1' : '0.8';
            }
            this.updateRailOrder(hasServer);
        };

        applyModeUI(currentHasServer);

        cardCloud?.addEventListener('click', () => {
            store.set('hasPelicanServer', true);
            applyModeUI(true);
            this.showNotification('Mode Serveur RXCORP Cloud', 'Infrastructure Cloud et synchronisation Pelican activées au premier plan.');
        });

        cardLocal?.addEventListener('click', () => {
            store.set('hasPelicanServer', false);
            applyModeUI(false);
            if (this.activeDribbbleMode === 'cloud') {
                this.selectDribbbleMode('instances');
            }
            this.showNotification('Mode Joueur Indépendant', 'Mode local et catalogue de mods activés au premier plan. Mode Cloud discret.');
        });
    }

    initLanguageSelector() {
        const langBtns = document.querySelectorAll('.lang-btn-switch, .lang-btn');
        const currentLang = i18n.getLang() || 'fr';

        langBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.lang === currentLang);
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const chosenLang = btn.dataset.lang;
                if (chosenLang) {
                    i18n.setLang(chosenLang);
                    langBtns.forEach(b => b.classList.toggle('active', b.dataset.lang === chosenLang));
                    this.renderAccountsList();
                    this.updateDockInstancePill();
                    const readyText = i18n.t('ready_to_play');
                    this.updateDockStatus(readyText, 0);
                    const langNames = { fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch', pt: 'Português' };
                    this.showNotification('Langue / Language', `Interface : ${langNames[chosenLang] || chosenLang}`);
                }
            });
        });
    }

    initLinkSyncPoolSettings() {
        const statCount = document.getElementById('pool-stat-count');
        const statSize = document.getElementById('pool-stat-size');
        const emptyMsg = document.getElementById('pool-empty-state-msg');
        const btnOpenFolder = document.getElementById('btn-open-pool-folder');
        const btnPurge = document.getElementById('btn-purge-pool');

        const updatePoolDisplay = () => {
            const poolInfo = modPoolService.calculateSavings();
            const count = poolInfo.poolCount || 0;
            if (statCount) statCount.innerText = count;
            if (statSize) statSize.innerText = `${(poolInfo.poolBytes / (1024 * 1024)).toFixed(1)} Mo`;
            if (emptyMsg) {
                emptyMsg.style.display = count === 0 ? 'block' : 'none';
            }
        };

        updatePoolDisplay();

        btnOpenFolder?.addEventListener('click', () => {
            const dir = modPoolService.getPoolDir();
            shell.openPath(dir);
            this.logDev('UI', `Ouverture du dossier du pool RXSync : ${dir}`);
        });

        btnPurge?.addEventListener('click', () => {
            const res = modPoolService.purgePool();
            updatePoolDisplay();
            const freedMo = (res.freedBytes / (1024 * 1024)).toFixed(1);
            this.showNotification('Cache RXSync vidé', `${res.deletedCount} mod(s) supprimé(s) (${freedMo} Mo libérés).`);
            this.logDev('PELICAN', `Cache RXSync purgé : ${res.deletedCount} mod(s) supprimé(s), ${freedMo} Mo libérés.`);
        });
    }

    updateRailOrder(hasPelicanServer) {
        const railTop = document.querySelector('.dribbble-rail .rail-top');
        if (!railTop) return;
        const cloudBtn = railTop.querySelector('[data-view="cloud"]');
        const instBtn = railTop.querySelector('[data-view="instances"]');
        const modBtn = railTop.querySelector('[data-view="modrinth"]');
        if (!cloudBtn || !instBtn || !modBtn) return;

        if (hasPelicanServer) {
            cloudBtn.setAttribute('title', 'RX Cloud (Serveurs Officiels Pelican)');
            railTop.insertBefore(cloudBtn, instBtn);
            railTop.appendChild(modBtn);
        } else {
            cloudBtn.setAttribute('title', 'RX Cloud (Secondaire - Pas de serveur lié)');
            railTop.insertBefore(instBtn, cloudBtn);
            railTop.insertBefore(modBtn, cloudBtn);
        }
    }

    // ==========================================
    // ONBOARDING SETUP WIZARD (FIRST LAUNCH MULTI-STEP WIZARD)
    // ==========================================
    initOnboardingWizard() {
        const overlay = document.getElementById('page-onboarding');
        const btnOpen = document.getElementById('btn-open-config-wizard');
        const btnClose = document.getElementById('btn-close-onboard');
        const btnPrev = document.getElementById('btn-wizard-prev');
        const btnNext = document.getElementById('btn-wizard-next');
        const btnFinish = document.getElementById('btn-wizard-finish');

        if (!overlay) return;

        // Current wizard state
        let currentStep = 1;
        let selectedLang = store.get('language') || 'fr';
        let selectedAccount = null;
        let selectedRam = 6;
        let selectedProfile = {
            loader: 'fabric',
            version: '1.21.4',
            name: 'RX Fabric 1.21.4'
        };

        // Detect system RAM
        let totalRamGB = 16;
        try {
            totalRamGB = Math.max(4, Math.round(os.totalmem() / (1024 * 1024 * 1024)));
        } catch (e) {
            console.warn('[RXCORP] Could not detect total RAM:', e);
        }

        selectedRam = Math.min(8, Math.max(4, Math.floor(totalRamGB / 2)));
        if (store.get('ramMax')) {
            selectedRam = Math.min(totalRamGB, Math.max(2, parseInt(store.get('ramMax'), 10)));
        }

        // Initialize RAM UI
        const ramSlider = document.getElementById('wizard-ram-slider');
        const ramVal = document.getElementById('wizard-ram-val');
        const ramTotalLabel = document.getElementById('wizard-total-ram-label');
        const ramMaxLabel = document.getElementById('wizard-max-ram-label');
        const ramPresets = document.querySelectorAll('.ram-preset-btn');

        if (ramSlider) {
            ramSlider.max = Math.min(32, totalRamGB);
            ramSlider.value = selectedRam;
        }
        if (ramVal) ramVal.innerText = `${selectedRam} Go`;
        if (ramTotalLabel) ramTotalLabel.innerText = `Total Détecté : ${totalRamGB} Go`;
        if (ramMaxLabel) ramMaxLabel.innerText = `${Math.min(32, totalRamGB)} Go`;

        const updateRamUI = (val) => {
            selectedRam = parseInt(val, 10);
            if (ramSlider) ramSlider.value = selectedRam;
            if (ramVal) ramVal.innerText = `${selectedRam} Go`;
            ramPresets.forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.ram, 10) === selectedRam);
            });
        };

        ramSlider?.addEventListener('input', (e) => updateRamUI(e.target.value));
        ramPresets.forEach(btn => {
            btn.addEventListener('click', () => updateRamUI(btn.dataset.ram));
        });
        updateRamUI(selectedRam);

        // Language selection cards
        const langCards = document.querySelectorAll('.wizard-lang-card');
        langCards.forEach(card => {
            if (card.dataset.lang === selectedLang) card.classList.add('active');
            else card.classList.remove('active');

            card.addEventListener('click', () => {
                langCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                selectedLang = card.dataset.lang;
                store.set('language', selectedLang);
                i18n.setLanguage(selectedLang);
            });
        });

        // Account management in Step 2
        const inputUsername = document.getElementById('input-onboard-username');
        const btnConfirmOffline = document.getElementById('btn-onboard-confirm-offline');
        const accountConfirmedBox = document.getElementById('wizard-account-confirmed');
        const confirmedNameSpan = document.getElementById('wizard-confirmed-name');
        const btnMicrosoft = document.getElementById('btn-onboard-microsoft');

        const displayConfirmedAccount = (name) => {
            if (accountConfirmedBox && confirmedNameSpan) {
                confirmedNameSpan.innerText = name;
                accountConfirmedBox.style.display = 'block';
            }
        };

        // Auto-detect PC username so user never has to type an email or pseudo
        let detectedUser = 'Salem';
        try {
            const sysUser = os.userInfo()?.username;
            if (sysUser && sysUser !== 'root') {
                detectedUser = sysUser.charAt(0).toUpperCase() + sysUser.slice(1);
            }
        } catch (e) {}

        const currentActive = store.get('activeAccountName');
        if (currentActive && currentActive !== 'Player') {
            displayConfirmedAccount(currentActive);
            selectedAccount = currentActive;
            if (inputUsername) inputUsername.value = currentActive;
        } else if (inputUsername) {
            inputUsername.value = detectedUser;
            displayConfirmedAccount(detectedUser);
            selectedAccount = detectedUser;
        }

        const handleOfflineSubmit = () => {
            const val = (inputUsername?.value || '').trim();
            if (!val) {
                this.showNotification('Pseudo requis', 'Entrez un pseudo pour continuer.');
                return false;
            }
            let accList = store.get('accounts') || [];
            accList = accList.filter(a => a.name !== 'Player');
            if (!accList.some(a => a.name.toLowerCase() === val.toLowerCase())) {
                accList.push({
                    name: val,
                    uuid: 'offline-' + Date.now(),
                    meta: { type: 'Offline', online: false }
                });
            }
            store.set('accounts', accList);
            store.set('activeAccountName', val);
            selectedAccount = val;
            displayConfirmedAccount(val);
            this.renderAccountsList();
            this.showNotification('Compte Validé', `Joueur ${val} configuré.`);
            goToStep(3);
            return true;
        };

        btnConfirmOffline?.addEventListener('click', handleOfflineSubmit);
        inputUsername?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleOfflineSubmit();
        });

        // Pelican Web Auth
        document.getElementById('btn-onboard-web-auth')?.addEventListener('click', () => {
            this.showNotification('Connexion Web', 'Ouverture de votre navigateur pour validation...');
            ipcRenderer.send('start-web-auth');
        });

        // Modern Microsoft Login (Device Code Flow + QR Code + Browser 1-Click)
        btnMicrosoft?.addEventListener('click', () => {
            this.openMicrosoftDeviceAuthModal((auth, cloudConfig) => {
                selectedAccount = auth.name;
                displayConfirmedAccount(auth.name);
                if (cloudConfig) {
                    if (cloudConfig.allocated_ram_gb) {
                        updateRamUI(cloudConfig.allocated_ram_gb);
                    }
                    if (cloudConfig.lang && cloudConfig.lang !== selectedLang) {
                        selectedLang = cloudConfig.lang;
                        store.set('language', selectedLang);
                        i18n.setLanguage(selectedLang);
                    }
                }
                goToStep(3);
            });
        });

        // Step 4 Profile selection cards
        const profileCards = document.querySelectorAll('.wizard-profile-card');
        profileCards.forEach(card => {
            card.addEventListener('click', () => {
                profileCards.forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                selectedProfile = {
                    loader: card.dataset.loader,
                    version: card.dataset.version,
                    name: card.dataset.name
                };
            });
        });

        // Stepper navigation logic
        const goToStep = (step) => {
            currentStep = Math.max(1, Math.min(4, step));

            for (let i = 1; i <= 4; i++) {
                const indicator = document.getElementById(`step-indicator-${i}`);
                const pane = document.getElementById(`wizard-pane-${i}`);

                if (indicator) {
                    indicator.classList.toggle('active', i === currentStep);
                    indicator.classList.toggle('done', i < currentStep);
                }
                if (pane) {
                    pane.style.display = (i === currentStep) ? 'flex' : 'none';
                }
            }

            if (btnPrev) btnPrev.style.display = (currentStep === 1) ? 'none' : 'inline-flex';
            if (btnNext) btnNext.style.display = (currentStep === 4) ? 'none' : 'inline-flex';
            if (btnFinish) btnFinish.style.display = (currentStep === 4) ? 'inline-flex' : 'none';
        };

        btnPrev?.addEventListener('click', () => {
            goToStep(currentStep - 1);
        });

        btnNext?.addEventListener('click', () => {
            if (currentStep === 2 && !selectedAccount) {
                const val = (inputUsername?.value || '').trim();
                if (val) {
                    handleOfflineSubmit();
                } else {
                    const defaultName = 'Player';
                    store.set('activeAccountName', defaultName);
                    selectedAccount = defaultName;
                }
            }
            goToStep(currentStep + 1);
        });

        // Finish button: finalize setup & send telemetry
        btnFinish?.addEventListener('click', async () => {
            btnFinish.disabled = true;
            btnFinish.innerText = 'Enregistrement...';

            try {
                // Save RAM settings
                store.set('ramMax', selectedRam);
                store.set('ramMin', 2);
                const ramSliderMain = document.getElementById('ram-slider');
                if (ramSliderMain) ramSliderMain.value = selectedRam;
                const ramDisplayMain = document.getElementById('ram-display');
                if (ramDisplayMain) ramDisplayMain.innerText = `${selectedRam} GB`;

                // Save configured state
                store.set('configured', true);
                store.set('hasCompletedWizard', true);

                // Create starter profile if needed
                const existingInstances = instanceService.getLocalInstances();
                let matchingInst = existingInstances.find(i => 
                    i.loader?.toLowerCase() === selectedProfile.loader.toLowerCase() &&
                    i.version === selectedProfile.version
                );

                if (!matchingInst) {
                    matchingInst = instanceService.createInstance({
                        name: selectedProfile.name,
                        version: selectedProfile.version,
                        loader: selectedProfile.loader,
                        domain: 'local'
                    });
                }

                if (matchingInst && matchingInst.id) {
                    this.activeLocalInstanceId = matchingInst.id;
                    store.set('activeLocalInstanceId', matchingInst.id);
                    store.set('activeInstanceId', matchingInst.id);
                }

                // Register telemetry with VPS Database API
                let clientUuid = store.get('client_uuid');
                if (!clientUuid) {
                    clientUuid = 'c-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36);
                    store.set('client_uuid', clientUuid);
                }

                const msUuid = store.get('ms_uuid') || null;
                const msGamertag = store.get('ms_gamertag') || null;

                const telemetryPayload = {
                    client_uuid: clientUuid,
                    launcher_version: '2.6.0',
                    os: `${os.type()} ${os.release()} (${os.arch()})`,
                    selected_loader: selectedProfile.loader,
                    allocated_ram_gb: selectedRam,
                    language: selectedLang,
                    account_type: msUuid ? 'microsoft' : 'offline',
                    ms_uuid: msUuid,
                    ms_gamertag: msGamertag
                };

                fetch('https://rxcorp.me/launcher/api/index.php?action=register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(telemetryPayload)
                }).catch(err => console.warn('[RXCORP] Telemetry registration error:', err.message));

                overlay.style.display = 'none';
                await this.loadInstances();
                this.updateDockInstancePill();
                this.showNotification('Bienvenue sur RXCORP !', `Profil ${selectedProfile.name} prêt. Bon jeu !`);
            } catch (err) {
                console.error('[RXCORP] Wizard completion error:', err);
                overlay.style.display = 'none';
            } finally {
                btnFinish.disabled = false;
                btnFinish.innerText = i18n.t('wizard_finish') || 'Terminer la configuration';
            }
        });

        // Check if user already configured
        const isConfigured = store.get('configured');
        const hasWizardCompleted = store.get('hasCompletedWizard');

        if (!isConfigured && !hasWizardCompleted) {
            overlay.style.display = 'flex';
            if (btnClose) btnClose.style.display = 'none';
            goToStep(1);
        } else {
            overlay.style.display = 'none';
        }

        // Open config modal from top titlebar
        btnOpen?.addEventListener('click', () => {
            if (btnClose) btnClose.style.display = 'inline-flex';
            overlay.style.display = 'flex';
            goToStep(1);
        });

        // Close modal if user manually closes
        btnClose?.addEventListener('click', () => {
            overlay.style.display = 'none';
        });
    }

    // ==========================================
    // VPS CENTRAL API INTEGRATION (BOOTSTRAP & NEWS)
    // ==========================================
    async fetchBootstrapData() {
        try {
            console.log('[RXCORP] Fetching bootstrap data from central VPS API...');
            const res = await fetch('https://rxcorp.me/launcher/api/index.php?action=bootstrap', {
                signal: AbortSignal.timeout(5000)
            });
            if (!res.ok) return;
            const json = await res.json();
            if (!json || !json.success) return;

            const config = json.config || json.data?.config;
            const news = json.news || json.data?.news;
            const servers = json.servers || json.data?.servers;

            // 1. Dynamic News rendering
            if (news && Array.isArray(news) && news.length > 0) {
                const newsContainer = document.querySelector('.home-news-section .news-cards-row');
                if (newsContainer) {
                    newsContainer.innerHTML = '';
                    news.slice(0, 3).forEach(item => {
                        const article = document.createElement('article');
                        article.className = 'modern-news-card';
                        article.onclick = () => {
                            if (item.link_url) shell.openExternal(item.link_url);
                        };

                        const tagColor = item.tag_color ? `style="color: ${item.tag_color};"` : '';
                        const tagText = item.badge_tag || item.tag || 'INFO';
                        const pubDate = item.published_date || item.published_at || '';
                        article.innerHTML = `
                            <div class="news-thumb-box">
                                <img class="news-thumb-img" src="${item.image_url || 'assets/images/heroes/hero_cloud.jpg'}" alt="${item.title}" onerror="this.onerror=null; this.src='assets/images/heroes/hero_cloud.jpg';">
                                <span class="news-tag-badge" ${tagColor}>${tagText}</span>
                            </div>
                            <div class="news-body-box">
                                <span class="news-date-text">${pubDate}</span>
                                <h3 class="news-card-title">${item.title}</h3>
                                <p class="news-card-desc">${item.summary || ''}</p>
                            </div>
                        `;
                        newsContainer.appendChild(article);
                    });
                }
            }

            console.log('[RXCORP] Bootstrap data synchronized successfully.');
        } catch (err) {
            console.warn('[RXCORP] Could not sync bootstrap data (offline mode active):', err.message);
        }
    }

    // ==========================================
    // RXCORP CLOUD WEB SSO & DIRECT AUTH
    // ==========================================
    initWebAuth() {
        // Handle successful loopback Web SSO from main process
        ipcRenderer.on('web-auth-success', (event, data) => {
            console.log('[RXCORP] Web Auth success received:', data);
            if (data.token) {
                store.set('apiKey', data.token);
                store.set('hasPelicanServer', true);
                if (data.username) {
                    store.set('pelicanUser', {
                        username: data.username,
                        email: data.email || ''
                    });

                    // Only set active Minecraft account if NO account is currently selected
                    const activeAcc = this.getActiveAccount();
                    if (!activeAcc || !activeAcc.name) {
                        store.set('activeAccountName', data.username);
                        const accounts = store.get('accounts') || [];
                        if (!accounts.some(a => a.name === data.username)) {
                            accounts.push({
                                name: data.username,
                                uuid: 'offline-' + data.username,
                                meta: { type: 'RXCORP', online: false, email: data.email || '' }
                            });
                            store.set('accounts', accounts);
                        }
                    }
                }
                store.set('configured', true);
                const firstLaunchModal = document.getElementById('modal-first-launch');
                if (firstLaunchModal) firstLaunchModal.style.display = 'none';
                this.showNotification('Connexion Pelican Réussie', `Connecté au Panel : ${data.username || ''}. Vos serveurs sont prêts.`);
                this.renderAccountsList();
                this.loadCloudServers();
                this.updatePelicanSyncUI();
                this.handlePelicanSync(true);
            }
        });

        // 1-Click Web SSO Handlers
        const startWebAuth = () => {
            this.showNotification('Connexion Web SSO', 'Ouverture de votre navigateur pour validation...');
            this.closeModal('modal-direct-login');
            ipcRenderer.send('start-web-auth');
        };

        document.getElementById('btn-start-web-auth')?.addEventListener('click', startWebAuth);
        document.getElementById('btn-cloud-web-sso')?.addEventListener('click', startWebAuth);
        document.getElementById('btn-modal-open-sso')?.addEventListener('click', startWebAuth);

        // Open Direct Login Modal Handlers
        const openDirectLogin = () => {
            const errBox = document.getElementById('direct-login-error');
            if (errBox) errBox.style.display = 'none';
            this.openModal('modal-direct-login');
            setTimeout(() => document.getElementById('input-direct-login')?.focus(), 50);
        };

        document.getElementById('btn-open-direct-login')?.addEventListener('click', openDirectLogin);
        document.getElementById('btn-cloud-direct-login')?.addEventListener('click', openDirectLogin);

        // Toggle Manual Key Input in Cloud View
        document.getElementById('btn-toggle-manual-key-cloud')?.addEventListener('click', () => {
            const box = document.getElementById('manual-key-cloud-box');
            if (box) {
                box.style.display = box.style.display === 'none' ? 'block' : 'none';
            }
        });

        // Submit Manual Key in Cloud View
        document.getElementById('btn-submit-manual-key-cloud')?.addEventListener('click', async () => {
            const input = document.getElementById('input-manual-key-cloud');
            const key = input ? input.value.trim() : '';
            if (!key) {
                this.showNotification('Clé requise', 'Veuillez saisir votre token API Client (pacc_...).');
                return;
            }
            store.set('apiKey', key);
            store.set('hasPelicanServer', true);
            const testRes = await pelicanService.testConnection(key);
            if (testRes.success && testRes.user) {
                store.set('pelicanUser', {
                    username: testRes.user.username,
                    email: testRes.user.email,
                    admin: !!testRes.user.admin
                });
                this.showNotification('Connexion réussie', `Connecté en tant que ${testRes.user.username}`);
            } else {
                this.showNotification('Panel Connecté', 'Clé API enregistrée.');
            }
            this.loadCloudServers();
            this.updatePelicanSyncUI();
            this.handlePelicanSync(true);
        });

        // Cloud User Header Actions
        document.getElementById('btn-open-pelican-web')?.addEventListener('click', () => {
            const panelUrl = store.get('panelUrl') || 'https://panel.rxcorp.me';
            shell.openExternal(panelUrl);
        });

        document.getElementById('btn-disconnect-cloud')?.addEventListener('click', () => {
            this.disconnectPelican();
        });

        // Toggle Legacy Manual API Key Container
        document.getElementById('btn-toggle-manual-key')?.addEventListener('click', () => {
            const container = document.getElementById('manual-key-container');
            if (container) {
                container.style.display = container.style.display === 'none' ? 'block' : 'none';
            }
        });

        // Submit Direct Login Modal
        const submitDirectLogin = async () => {
            const login = document.getElementById('input-direct-login')?.value.trim();
            const password = document.getElementById('input-direct-password')?.value;
            const errBox = document.getElementById('direct-login-error');
            const btn = document.getElementById('btn-submit-direct-login');

            if (!login || !password) {
                if (errBox) {
                    errBox.textContent = 'Veuillez saisir votre identifiant et mot de passe.';
                    errBox.style.display = 'block';
                }
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<span>Connexion...</span>';
            if (errBox) errBox.style.display = 'none';

            try {
                const response = await fetch('https://panel.rxcorp.me/api/launcher/direct-login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ login, password })
                });
                const resData = await response.json();

                if (resData.success && resData.token) {
                    store.set('apiKey', resData.token);
                    store.set('hasPelicanServer', true);
                    if (resData.user?.username) {
                        store.set('pelicanUser', {
                            username: resData.user.username,
                            email: resData.user.email || '',
                            admin: !!(resData.user.admin || resData.user.root_admin)
                        });
                        // Preserve active Minecraft account if already present
                        const activeAcc = this.getActiveAccount();
                        if (!activeAcc || !activeAcc.name) {
                            store.set('activeAccountName', resData.user.username);
                            const accounts = store.get('accounts') || [];
                            if (!accounts.some(a => a.name === resData.user.username)) {
                                accounts.push({
                                    name: resData.user.username,
                                    uuid: 'offline-' + resData.user.username,
                                    meta: { type: 'RXCORP', online: false, email: resData.user.email || '' }
                                });
                                store.set('accounts', accounts);
                            }
                        }
                    }
                    this.closeModal('modal-direct-login');
                    this.showNotification('Connexion réussie', `Bienvenue ${resData.user?.username || ''} !`);
                    this.renderAccountsList();
                    this.loadCloudServers();
                    this.updatePelicanSyncUI();
                    this.handlePelicanSync(true);
                } else {
                    if (errBox) {
                        errBox.textContent = resData.error || 'Identifiants invalides.';
                        errBox.style.display = 'block';
                    }
                }
            } catch (e) {
                if (errBox) {
                    errBox.textContent = 'Erreur de connexion : ' + e.message;
                    errBox.style.display = 'block';
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span>Se connecter</span>';
            }
        };

        document.getElementById('btn-submit-direct-login')?.addEventListener('click', submitDirectLogin);
        document.getElementById('input-direct-password')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitDirectLogin();
        });
        document.getElementById('input-direct-login')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitDirectLogin();
        });

        // Public Servers 1-Click Join Handlers
        document.querySelectorAll('.btn-join-public-srv').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const srvType = e.currentTarget.dataset.srv;
                if (srvType === 'survie') {
                    const inst = instanceService.getOrCreateServerInstance({
                        name: 'RX Survie 1.21.4',
                        ip: 'play.rxcorp.me',
                        port: 25565,
                        version: '1.21.4',
                        loader: 'vanilla',
                        isMinecraft: true
                    });
                    this.setActiveInstanceForDomain('cloud', inst.id);
                    await this.launchCurrentInstance();
                } else if (srvType === 'modded') {
                    const inst = instanceService.getOrCreateServerInstance({
                        name: 'RX Modded NeoForge',
                        ip: 'node.rxcorp.me',
                        port: 25566,
                        version: '1.21.1',
                        loader: 'neoforge',
                        isMinecraft: true
                    });
                    this.setActiveInstanceForDomain('cloud', inst.id);
                    await this.launchCurrentInstance();
                }
            });
        });
    }

    initAccounts() {
        this.renderAccountsList();

        document.getElementById('btn-add-offline')?.addEventListener('click', () => {
            this.openModal('modal-add-offline');
        });

        document.getElementById('btn-confirm-add-offline')?.addEventListener('click', () => {
            const input = document.getElementById('input-offline-username');
            const username = (input.value || '').trim();
            if (!username) {
                this.showNotification('Pseudo requis', 'Entrez un pseudo pour votre compte hors-ligne.');
                return;
            }

            const accounts = store.get('accounts') || [];
            accounts.push({
                name: username,
                uuid: 'offline-' + Date.now(),
                meta: { type: 'Mojang', online: false }
            });

            store.set('accounts', accounts);
            store.set('activeAccountName', username);
            input.value = '';
            this.closeModal('modal-add-offline');
            this.renderAccountsList();
        });

        document.getElementById('btn-add-microsoft')?.addEventListener('click', () => {
            this.openMicrosoftDeviceAuthModal();
        });

        // Settings Skin card action buttons
        document.getElementById('btn-settings-change-pseudo')?.addEventListener('click', () => {
            this.openModal('modal-add-offline');
        });

        document.getElementById('btn-settings-add-account')?.addEventListener('click', () => {
            this.openMicrosoftDeviceAuthModal();
        });
    }

    getActiveAccount() {
        const accounts = store.get('accounts') || [];
        const activeName = store.get('activeAccountName');
        const found = accounts.find(a => a.name === activeName) || accounts[0];
        if (found) return found;

        const cloudUser = store.get('user');
        if (cloudUser && cloudUser.username) {
            return {
                name: cloudUser.username,
                uuid: '00000000-0000-0000-0000-000000000000',
                access_token: 'null',
                meta: { type: 'Offline', online: false }
            };
        }
        return null;
    }

    renderAccountsList() {
        const list = document.getElementById('accounts-list');
        const activeAccount = this.getActiveAccount();
        const userNameElem = document.getElementById('user-name');
        const userAvatarElem = document.getElementById('user-avatar');
        const railAvatarElem = document.getElementById('rail-user-avatar');

        if (activeAccount) {
            const isMs = activeAccount.meta?.type === 'Microsoft' || 
                         activeAccount.meta?.type === 'Xbox' || 
                         (activeAccount.access_token && activeAccount.access_token !== 'null');

            if (userNameElem) userNameElem.innerText = activeAccount.name;
            if (userAvatarElem) {
                userAvatarElem.src = `https://mc-heads.net/avatar/${activeAccount.name}/32`;
                userAvatarElem.onerror = () => { userAvatarElem.src = 'assets/images/icon/icon.png'; };
            }
            if (railAvatarElem) {
                railAvatarElem.src = `https://mc-heads.net/avatar/${activeAccount.name}/34`;
                railAvatarElem.onerror = () => { railAvatarElem.src = 'assets/images/icon/icon.png'; };
            }

            const skinName = document.getElementById('settings-skin-name');
            const skinBody = document.getElementById('settings-skin-body');
            const skinStatus = document.getElementById('settings-skin-status');

            if (skinName) skinName.innerText = activeAccount.name;
            if (skinBody) {
                skinBody.src = `https://mc-heads.net/body/${activeAccount.name}/220`;
                skinBody.onerror = () => { skinBody.src = 'https://mc-heads.net/body/Steve/220'; };
            }
            if (skinStatus) {
                if (isMs) {
                    skinStatus.innerHTML = '<span class="badge-ms-pill"><svg width="12" height="12" viewBox="0 0 24 24"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 13h10v10H1z"/><path fill="#7fba00" d="M13 1h10v10H13z"/><path fill="#ffb900" d="M13 13h10v10H13z"/></svg> Microsoft Officiel • Synchronisé</span>';
                } else {
                    skinStatus.innerHTML = '<span class="badge-offline-pill">Joueur Hors-Ligne (Pseudo Libre)</span>';
                }
            }
        }

        if (!list) return;
        const accounts = store.get('accounts') || [];

        if (accounts.length === 0) {
            list.innerHTML = `
                <div style="font-size: 12px; color: var(--text-dim); text-align: center; padding: 18px 10px; background: rgba(0,0,0,0.2); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
                    Aucun compte enregistré. Cliquez sur <strong>+ Compte Microsoft</strong> ou <strong>+ Pseudo libre</strong> pour ajouter votre joueur.
                </div>
            `;
            return;
        }

        list.innerHTML = accounts.map(acc => {
            const isActive = acc.name === activeAccount?.name;
            const isMicrosoft = acc.meta?.type === 'Microsoft' || acc.meta?.type === 'Xbox' || (acc.access_token && acc.access_token !== 'null');
            return `
                <div class="clean-account-row ${isActive ? 'active' : ''}">
                    <div class="clean-account-left">
                        <img class="clean-account-avatar" src="https://mc-heads.net/avatar/${acc.name}/32" onerror="this.src='assets/images/icon/icon.png'">
                        <div>
                            <div class="clean-account-name">${acc.name}</div>
                            <div class="clean-account-type">${isMicrosoft ? 'Compte Microsoft Officiel' : 'Compte Hors-Ligne'}</div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        ${isActive 
                            ? '<span style="color: var(--emerald); font-size: 12px; font-weight: 700; padding: 4px 10px; background: rgba(16, 185, 129, 0.12); border-radius: 6px;">Actif</span>'
                            : `<button class="rx-btn rx-btn-secondary btn-switch-account" data-name="${acc.name}" style="padding: 4px 10px; font-size: 11px;">Activer</button>`
                        }
                        <button class="rx-btn rx-btn-danger btn-delete-account" data-name="${acc.name}" title="Supprimer ce compte" style="padding: 4px 8px; font-size: 11px; min-width: unset;">✕</button>
                    </div>
                </div>
            `;
        }).join('');

        list.querySelectorAll('.btn-switch-account').forEach(btn => {
            btn.addEventListener('click', () => {
                store.set('activeAccountName', btn.dataset.name);
                this.renderAccountsList();
                this.updatePelicanSyncUI();
            });
        });

        list.querySelectorAll('.btn-delete-account').forEach(btn => {
            btn.addEventListener('click', () => {
                const name = btn.dataset.name;
                let accs = store.get('accounts') || [];
                accs = accs.filter(a => a.name !== name);
                store.set('accounts', accs);
                if (store.get('activeAccountName') === name) {
                    store.set('activeAccountName', accs[0] ? accs[0].name : '');
                }
                this.renderAccountsList();
                this.updatePelicanSyncUI();
            });
        });
    }

    // ==========================================
    // MODALS HANDLING
    // ==========================================
    initModals() {
        document.querySelectorAll('[data-close]').forEach(btn => {
            btn.addEventListener('click', () => {
                const modalId = btn.dataset.close;
                this.closeModal(modalId);
            });
        });

        document.getElementById('btn-copy-sync-logs')?.addEventListener('click', () => {
            this.copySyncLogs();
        });

        document.getElementById('btn-clear-sync-logs')?.addEventListener('click', () => {
            this.clearSyncTerminal();
        });

        document.getElementById('btn-new-instance')?.addEventListener('click', () => {
            this.openModal('modal-create-instance');
        });

        // Loader visual selection in create instance modal
        document.querySelectorAll('#create-loader-selector .loader-choice-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('#create-loader-selector .loader-choice-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                const loaderInput = document.getElementById('select-new-loader');
                if (loaderInput) loaderInput.value = card.dataset.loader;
            });
        });

        document.getElementById('btn-confirm-create-instance')?.addEventListener('click', () => {
            const name = document.getElementById('input-new-name').value.trim();
            const version = document.getElementById('select-new-version').value;
            const loader = document.getElementById('select-new-loader').value;

            if (!name) {
                this.showNotification('Nom requis', 'Donnez un nom à votre profil avant de continuer.');
                return;
            }

            const newInst = instanceService.createInstance({
                name: name,
                version: version,
                loader: loader,
                domain: 'local'
            });

            this.closeModal('modal-create-instance');
            document.getElementById('input-new-name').value = '';
            this.setActiveInstanceForDomain('local', newInst.id);
            this.selectDribbbleMode('instances');
            this.loadInstances();
            this.showNotification('Profil Local Créé', `"${name}" est prêt à être personnalisé.`);
        });
    }

    /**
     * Modern Microsoft OAuth 2.0 Device Code Flow Modal (QR Code & Browser 1-Click)
     * @param {Function} onSuccess Optional callback receiving (auth, cloudConfig)
     */
    async openMicrosoftDeviceAuthModal(onSuccess = null) {
        const modal = document.getElementById('modal-microsoft-auth');
        if (!modal) return;

        const qrImg = document.getElementById('ms-qr-image');
        const qrSpinner = document.getElementById('ms-qr-spinner');
        const userCodeDisplay = document.getElementById('ms-user-code-display');
        const btnCopy = document.getElementById('btn-ms-copy-code');
        const btnOpenBrowser = document.getElementById('btn-ms-open-browser');
        const statusText = document.getElementById('ms-auth-status-text');

        // Reset UI state
        if (qrImg) {
            qrImg.style.display = 'none';
            qrImg.src = '';
        }
        if (qrSpinner) qrSpinner.style.display = 'block';
        if (userCodeDisplay) userCodeDisplay.innerText = '••••••••';
        if (btnCopy) btnCopy.innerText = 'Copier le code';
        if (statusText) statusText.innerText = 'Génération du code de connexion...';

        this.openModal('modal-microsoft-auth');

        try {
            const flow = await microsoftAuthService.startDeviceFlow();

            if (qrSpinner) qrSpinner.style.display = 'none';
            if (qrImg) {
                qrImg.src = flow.qrDataUrl;
                qrImg.style.display = 'block';
            }
            if (userCodeDisplay) userCodeDisplay.innerText = flow.userCode;
            if (statusText) statusText.innerText = 'En attente de votre validation sur mobile ou navigateur...';

            if (btnCopy) {
                btnCopy.onclick = () => {
                    try {
                        clipboard.writeText(flow.userCode);
                        btnCopy.innerText = 'Copié !';
                        setTimeout(() => { btnCopy.innerText = 'Copier le code'; }, 2000);
                    } catch (e) {}
                };
            }

            if (btnOpenBrowser) {
                btnOpenBrowser.onclick = () => {
                    if (statusText) statusText.innerText = 'Lien ouvert. Validez sur votre navigateur...';
                    shell.openExternal(flow.verificationUrlWithCode);
                };
            }

            // Start polling until user signs in or cancels
            const auth = await microsoftAuthService.pollForApproval(flow.deviceCode, flow.interval, (status) => {
                if (status === 'pending' && statusText) {
                    statusText.innerText = 'En attente de validation sur le compte Microsoft...';
                } else if (status === 'slow_down' && statusText) {
                    statusText.innerText = 'Synchronisation Microsoft en cours...';
                }
            });

            if (auth && auth.name) {
                if (statusText) statusText.innerText = `Connexion réussie : ${auth.name} !`;

                // Update accounts store
                let accList = store.get('accounts') || [];
                accList = accList.filter(a => a.name !== 'Player');
                const existingIdx = accList.findIndex(a => a.name.toLowerCase() === auth.name.toLowerCase());
                if (existingIdx >= 0) {
                    accList[existingIdx] = auth;
                } else {
                    accList.push(auth);
                }
                store.set('accounts', accList);
                store.set('activeAccountName', auth.name);
                if (auth.uuid) store.set('ms_uuid', auth.uuid);
                store.set('ms_gamertag', auth.name);

                this.renderAccountsList();
                this.updatePelicanSyncUI();

                // Cloud database sync
                let clientUuid = store.get('client_uuid');
                if (!clientUuid) {
                    clientUuid = 'c-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36);
                    store.set('client_uuid', clientUuid);
                }

                let cloudConfig = null;
                try {
                    const syncRes = await fetch('https://rxcorp.me/launcher/api/index.php?action=sync_ms', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            client_uuid: clientUuid,
                            ms_uuid: auth.uuid || null,
                            ms_gamertag: auth.name,
                            allocated_ram_gb: store.get('ramMax') || 6,
                            preferred_loader: store.get('preferred_loader') || 'fabric',
                            lang: store.get('language') || 'fr'
                        })
                    });
                    const resJson = await syncRes.json();
                    if (resJson && resJson.success && resJson.cloud_config) {
                        cloudConfig = resJson.cloud_config;
                        console.log('[RXCORP] Cloud config synchronisée:', cloudConfig);
                    }
                } catch (e) {
                    console.warn('[RXCORP] Cloud sync non bloquante:', e.message);
                }

                this.showNotification('Compte Microsoft Connecté', `Bienvenue ${auth.name} ! Profil Cloud synchronisé.`);

                if (store.get('apiKey')) {
                    this.handlePelicanSync(true);
                }

                setTimeout(() => {
                    this.closeModal('modal-microsoft-auth');
                }, 800);

                if (typeof onSuccess === 'function') {
                    onSuccess(auth, cloudConfig);
                }
            }
        } catch (err) {
            if (err.name !== 'AbortError' && microsoftAuthService.activePolling !== false) {
                console.error('[RXCORP] Microsoft Auth Flow Error:', err);
                if (statusText) statusText.innerText = err.message || 'Erreur de connexion Microsoft.';
                this.showNotification('Erreur Microsoft', err.message);
            }
        }
    }

    openModal(id) {
        document.getElementById(id)?.classList.add('active');
    }

    closeModal(id) {
        document.getElementById(id)?.classList.remove('active');
        if (id === 'modal-microsoft-auth') {
            microsoftAuthService.cancelFlow();
        }
    }

    showNotification(title, body) {
        ipcRenderer.send('send-notification', { title, body });
    }
}

function bootstrap() {
    try {
        const app = new RxcorpApp();
        app.init();
    } catch (e) {
        console.error('[RXCORP Bootstrap Error]', e);
    }
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
