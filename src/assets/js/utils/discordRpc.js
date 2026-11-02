const DiscordRPC = require('discord-rpc');

class DiscordManager {
    constructor() {
        this.clientId = '1546525834381238393';
        this.client = null;
        this.connected = false;
        this.startTimestamp = Date.now();
        this.currentActivity = null;
        this.reconnectTimeout = null;
    }

    init() {
        if (this.client) return;
        try {
            DiscordRPC.register(this.clientId);
        } catch (e) {
            console.warn('[Discord RPC] Enregistrement protocole ignoré:', e.message);
        }

        this.connect();
    }

    connect() {
        if (this.connected) return;
        this.client = new DiscordRPC.Client({ transport: 'ipc' });

        this.client.on('ready', () => {
            this.connected = true;
            console.log(`[Discord RPC] Connecté à Discord en tant que ${this.client.user.username}`);
            if (this.currentActivity) {
                this.setActivity(this.currentActivity);
            } else {
                this.setIdle();
            }
        });

        this.client.on('error', (err) => {
            console.warn('[Discord RPC] Erreur communication:', err.message);
        });

        this.client.on('disconnected', () => {
            this.connected = false;
            console.log('[Discord RPC] Déconnecté de Discord. Nouvelle tentative dans 30s...');
            this.scheduleReconnect();
        });

        this.client.login({ clientId: this.clientId }).catch((err) => {
            this.connected = false;
            console.log('[Discord RPC] Discord inaccessible (' + err.message + '). Reconnexion dans 30s...');
            this.scheduleReconnect();
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, 30000);
    }

    setActivity(activity) {
        this.currentActivity = activity;
        if (!this.connected || !this.client) return;

        try {
            const data = {
                details: activity.details || 'RXLauncher',
                state: activity.state || 'Dans le launcher • Prêt',
                largeImageKey: activity.largeImageKey || 'https://rxcorp.me/logos/assets/discord_asset_logo_1024.png',
                largeImageText: activity.largeImageText || 'RXCORP - Infrastructure Gaming & Cloud',
                smallImageKey: activity.smallImageKey || 'https://rxcorp.me/assets/logo.png',
                smallImageText: activity.smallImageText || 'RXCORP v2.4',
                instance: false,
            };

            if (activity.startTimestamp) {
                data.startTimestamp = activity.startTimestamp;
            }

            // High priority official buttons
            data.buttons = [
                { label: 'Site Officiel', url: 'https://rxcorp.me' },
                { label: 'Rejoindre RXCORP', url: 'https://rxcorp.me' }
            ];

            this.client.setActivity(data).then(() => {
                console.log(`[Discord RPC] Statut mis à jour: "${data.details}" - "${data.state}"`);
            }).catch((err) => {
                console.warn('[Discord RPC] Impossible de définir l\'activité:', err.message);
            });
        } catch (err) {
            console.error('[Discord RPC] Exception setActivity:', err);
        }
    }

    setIdle() {
        this.setActivity({
            details: 'RXLauncher',
            state: 'Menu Principal • Prêt à jouer',
            largeImageKey: 'https://rxcorp.me/logos/assets/discord_asset_logo_1024.png',
            largeImageText: 'RXLauncher - Minecraft & Pelican Cloud',
            smallImageKey: 'https://rxcorp.me/assets/logo.png',
            smallImageText: 'En attente',
            startTimestamp: this.startTimestamp
        });
    }

    setLaunching(targetName = 'Minecraft') {
        this.setActivity({
            details: 'RXLauncher',
            state: `Lancement de ${targetName}...`,
            largeImageKey: 'https://rxcorp.me/logos/assets/discord_asset_logo_1024.png',
            largeImageText: 'RXCORP - Infrastructure Gaming & Cloud',
            smallImageKey: 'https://rxcorp.me/assets/logo.png',
            smallImageText: 'Chargement...',
            startTimestamp: Date.now()
        });
    }

    setPlaying(instanceOrServerName = 'RX Cloud') {
        this.setActivity({
            details: 'En jeu sur Minecraft',
            state: `Serveur : ${instanceOrServerName}`,
            largeImageKey: 'https://rxcorp.me/logos/assets/discord_asset_logo_1024.png',
            largeImageText: 'RXCORP - Infrastructure Gaming & Cloud',
            smallImageKey: 'https://rxcorp.me/assets/logo.png',
            smallImageText: 'En jeu',
            startTimestamp: Date.now()
        });
    }

    destroy() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.client) {
            try {
                this.client.destroy();
            } catch (e) {}
            this.client = null;
            this.connected = false;
        }
    }
}

module.exports = new DiscordManager();
