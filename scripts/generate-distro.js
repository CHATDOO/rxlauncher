/**
 * RXCORP Launcher - Distribution & Mod Sync Generator
 * Scans server folders, computes MD5 hashes, generates distribution.json,
 * and deploys mods & configurations to production CDN.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE_URL = 'https://rxcorp.me/launcher/distribution';
const SOURCE_DIR = path.resolve(__dirname, '../distribution-source');
const OUTPUT_DIR = path.resolve(__dirname, '../dist/distribution');
const LOCAL_WEB_DIR = '/var/www/landing/launcher/distribution';

const VPS_HOST = '82.70.251.151';
const VPS_USER = 'ubuntu';
const VPS_PASS = 'Cornemer2002*';

console.log('====================================================');
console.log('    RXCORP LAUNCHER - GÉNÉRATEUR DE DISTRIBUTION    ');
console.log('====================================================');

function calculateMD5(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

// 1. Ensure target directories
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const serversDir = path.join(SOURCE_DIR, 'servers');
if (!fs.existsSync(serversDir)) {
    console.error(`[ERREUR] Dossier ${serversDir} introuvable.`);
    process.exit(1);
}

const distribution = {
    version: '1.0.0',
    rss: `${BASE_URL}/rss.xml`,
    discord: {
        clientId: '1086936373057040395',
        smallImageText: 'RXLauncher',
        smallImageKey: 'icon'
    },
    servers: []
};

const serverFolders = fs.readdirSync(serversDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

console.log(`[INFO] Serveurs détectés : ${serverFolders.join(', ')}`);

serverFolders.forEach(serverFolder => {
    const sDir = path.join(serversDir, serverFolder);
    const configFile = path.join(sDir, 'server.json');

    let serverMeta = {
        id: serverFolder,
        name: `RXCORP ${serverFolder}`,
        description: 'Serveur officiel RXCORP',
        address: 'rxcorp.me:25565',
        minecraftVersion: '1.20.1',
        modLoader: 'Forge', // or Fabric
        mainServer: true,
        autoconnect: false
    };

    if (fs.existsSync(configFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            serverMeta = { ...serverMeta, ...parsed };
        } catch (e) {
            console.warn(`[WARN] Erreur lecture server.json dans ${serverFolder}:`, e.message);
        }
    }

    const serverDistDir = path.join(OUTPUT_DIR, 'servers', serverMeta.id);
    fs.mkdirSync(serverDistDir, { recursive: true });

    // Copy icon if exists
    let iconUrl = `${BASE_URL}/icon.png`;
    const iconLocal = path.join(sDir, 'icon.png');
    if (fs.existsSync(iconLocal)) {
        fs.copyFileSync(iconLocal, path.join(serverDistDir, 'icon.png'));
        iconUrl = `${BASE_URL}/servers/${serverMeta.id}/icon.png`;
    }

    const serverEntry = {
        id: serverMeta.id,
        name: serverMeta.name,
        description: serverMeta.description,
        icon: iconUrl,
        version: '1.0.0',
        address: serverMeta.address,
        minecraftVersion: serverMeta.minecraftVersion,
        discord: {
            shortId: serverMeta.name,
            largeImageKey: iconUrl,
            largeImageText: serverMeta.name
        },
        mainServer: !!serverMeta.mainServer,
        autoconnect: !!serverMeta.autoconnect,
        modules: []
    };

    // Scan mods
    const modsDir = path.join(sDir, 'mods');
    if (fs.existsSync(modsDir)) {
        const modFiles = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
        const distModsDir = path.join(serverDistDir, 'mods');
        fs.mkdirSync(distModsDir, { recursive: true });

        console.log(` -> Serveur [${serverMeta.name}] : ${modFiles.length} mods trouvés`);

        modFiles.forEach(file => {
            const srcPath = path.join(modsDir, file);
            const destPath = path.join(distModsDir, file);
            fs.copyFileSync(srcPath, destPath);

            const stat = fs.statSync(srcPath);
            const md5 = calculateMD5(srcPath);
            const modType = serverMeta.modLoader.toLowerCase().includes('fabric') ? 'FabricMod' : 'ForgeMod';

            serverEntry.modules.push({
                id: `rxcorp.mod:${file.replace('.jar', '')}`,
                name: file.replace('.jar', ''),
                type: modType,
                required: {
                    value: true
                },
                artifact: {
                    size: stat.size,
                    MD5: md5,
                    url: `${BASE_URL}/servers/${serverMeta.id}/mods/${encodeURIComponent(file)}`
                }
            });
        });
    }

    // Scan configs
    const configDir = path.join(sDir, 'config');
    if (fs.existsSync(configDir)) {
        const configFiles = fs.readdirSync(configDir, { withFileTypes: true });
        const distConfigDir = path.join(serverDistDir, 'config');
        fs.mkdirSync(distConfigDir, { recursive: true });

        configFiles.forEach(entry => {
            if (entry.isFile()) {
                const srcPath = path.join(configDir, entry.name);
                const destPath = path.join(distConfigDir, entry.name);
                fs.copyFileSync(srcPath, destPath);

                const stat = fs.statSync(srcPath);
                const md5 = calculateMD5(srcPath);

                serverEntry.modules.push({
                    id: `rxcorp.config:${entry.name}`,
                    name: entry.name,
                    type: 'File',
                    artifact: {
                        size: stat.size,
                        MD5: md5,
                        url: `${BASE_URL}/servers/${serverMeta.id}/config/${encodeURIComponent(entry.name)}`,
                        path: `config/${entry.name}`
                    }
                });
            }
        });
    }

    distribution.servers.push(serverEntry);
});

// Copy root brand icon
const brandIcon = path.resolve(__dirname, '../build/icon.png');
if (fs.existsSync(brandIcon)) {
    fs.copyFileSync(brandIcon, path.join(OUTPUT_DIR, 'icon.png'));
}

// Generate RSS feed
const rssContent = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
<channel>
 <title>RXCORP Actualités</title>
 <description>Flux d'actualités du réseau RXCORP</description>
 <link>https://rxcorp.me</link>
 <item>
  <title>Bienvenue sur le nouveau RXLauncher v3.0</title>
  <description>Synchronisation ultra-rapide des mods, stabilité maximale et design Dark Smoked Glass.</description>
  <link>https://rxcorp.me/launcher/</link>
  <pubDate>Mon, 02 Nov 2026 05:00:00 GMT</pubDate>
  <author>admin@rxcorp.me (RXCORP Team)</author>
 </item>
</channel>
</rss>`;
fs.writeFileSync(path.join(OUTPUT_DIR, 'rss.xml'), rssContent, 'utf8');

// Write distribution.json
const distroPath = path.join(OUTPUT_DIR, 'distribution.json');
fs.writeFileSync(distroPath, JSON.stringify(distribution, null, 2), 'utf8');
console.log(`[OK] Manifeste distribution.json généré (${distribution.servers.length} serveurs).`);

// 2. Deploy locally if /var/www/landing exists
if (fs.existsSync(path.dirname(LOCAL_WEB_DIR))) {
    console.log('[SYNC] Copie vers le répertoire web local...');
    fs.mkdirSync(LOCAL_WEB_DIR, { recursive: true });
    try {
        execSync(`cp -r "${OUTPUT_DIR}"/* "${LOCAL_WEB_DIR}/"`);
        execSync(`chown -R www-data:www-data "${LOCAL_WEB_DIR}" 2>/dev/null || true`);
        execSync(`chmod -R 755 "${LOCAL_WEB_DIR}" 2>/dev/null || true`);
    } catch (e) {
        console.warn('[WARN] Erreur copie web locale:', e.message);
    }
}

// 3. Deploy to remote VPS
console.log(`[SYNC] Déploiement vers le VPS ${VPS_HOST}...`);
try {
    execSync(`sshpass -p '${VPS_PASS}' rsync -avz -e "ssh -o StrictHostKeyChecking=no" "${OUTPUT_DIR}/" ${VPS_USER}@${VPS_HOST}:/tmp/distro_sync/`, { stdio: 'inherit' });
    execSync(`sshpass -p '${VPS_PASS}' ssh -o StrictHostKeyChecking=no ${VPS_USER}@${VPS_HOST} "echo '${VPS_PASS}' | sudo -S cp -r /tmp/distro_sync/* /var/www/landing/launcher/distribution/ && sudo chown -R www-data:www-data /var/www/landing/launcher/distribution && sudo chmod -R 755 /var/www/landing/launcher/distribution && rm -rf /tmp/distro_sync"`, { stdio: 'inherit' });
    console.log('   ✅ Distribution et mods synchronisés sur le Cloud VPS !');
    console.log(`   URL du Manifeste : ${BASE_URL}/distribution.json`);
} catch (e) {
    console.warn('[WARN] Erreur synchro VPS distro:', e.message);
}

console.log('====================================================');
