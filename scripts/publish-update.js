/**
 * RXCORP Launcher - Update Publisher
 * Deploys built artifacts to the live update server on https://rxcorp.me/launcher/update/
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIST_DIR = path.resolve(__dirname, '../dist');
const TARGET_UPDATE_DIR = '/var/www/landing/launcher/update';
const TARGET_EXE = '/var/www/landing/RXCORP-Launcher.exe';

console.log('==================================================');
console.log('       RXCORP LAUNCHER - PUBLICATION DE LA MAJ    ');
console.log('==================================================');

if (!fs.existsSync(DIST_DIR)) {
    console.error('[ERREUR] Dossier dist/ introuvable. Lancez npm run build:win d abord.');
    process.exit(1);
}

// 1. Ensure target directory exists
if (!fs.existsSync(TARGET_UPDATE_DIR)) {
    fs.mkdirSync(TARGET_UPDATE_DIR, { recursive: true });
}

// 2. Locate built files
const files = fs.readdirSync(DIST_DIR);
const ymlFile = files.find(f => f.endsWith('latest.yml'));
if (!ymlFile) {
    console.error('[ERREUR] Fichier latest.yml manquant dans dist/');
    process.exit(1);
}

const ymlContent = fs.readFileSync(path.join(DIST_DIR, ymlFile), 'utf8');
const pathMatch = ymlContent.match(/path:\s*(.+)/);
const exeFile = pathMatch ? pathMatch[1].trim() : files.find(f => f.endsWith('.exe') && !f.includes('Portable') && !f.startsWith('__uninstaller'));
const blockmapFile = files.find(f => f.endsWith('.blockmap') && f.includes(exeFile.replace('.exe', '')));

if (!exeFile || !fs.existsSync(path.join(DIST_DIR, exeFile))) {
    console.error(`[ERREUR] Fichier .exe (${exeFile}) manquant dans dist/`);
    process.exit(1);
}

console.log(`[1/4] Copie de ${ymlFile}...`);
fs.copyFileSync(path.join(DIST_DIR, ymlFile), path.join(TARGET_UPDATE_DIR, 'latest.yml'));

console.log(`[2/4] Copie de l'installateur ${exeFile}...`);
fs.copyFileSync(path.join(DIST_DIR, exeFile), path.join(TARGET_UPDATE_DIR, exeFile));

// Also copy as direct download root
fs.copyFileSync(path.join(DIST_DIR, exeFile), TARGET_EXE);
fs.copyFileSync(path.join(DIST_DIR, exeFile), '/var/www/landing/RXLauncher.exe');
fs.copyFileSync(path.join(DIST_DIR, exeFile), '/var/www/landing/RXCORP-Launcher-v2.exe');

// Check if standalone portable .exe was built
const portableExe = files.find(f => f.includes('Portable') && f.endsWith('.exe'));
if (portableExe && fs.existsSync(path.join(DIST_DIR, portableExe))) {
    console.log(`[2b/4] Copie de la version portable autonome ${portableExe}...`);
    fs.copyFileSync(path.join(DIST_DIR, portableExe), '/var/www/landing/RXLauncher-Portable.exe');
    fs.copyFileSync(path.join(DIST_DIR, portableExe), '/var/www/landing/RXCORP-Launcher-Portable.exe');
}

const unpackedDir = path.join(DIST_DIR, 'win-unpacked');
if (fs.existsSync(unpackedDir)) {
    console.log('[3/4] Mise à jour du package portable RXCORP-Launcher-Portable.zip...');
    try {
        execSync(`cd "${unpackedDir}" && zip -r -q /var/www/landing/RXCORP-Launcher-Portable.zip .`);
    } catch (e) {
        console.warn('[AVERTISSEMENT] Erreur zip portable:', e.message);
    }
}

if (blockmapFile) {
    console.log(`[3b/4] Copie de ${blockmapFile} pour mises à jour différentielles rapides...`);
    fs.copyFileSync(path.join(DIST_DIR, blockmapFile), path.join(TARGET_UPDATE_DIR, blockmapFile));
}

console.log('[4/4] Ajustement des permissions web locales (www-data)...');
try {
    execSync(`chown -R www-data:www-data /var/www/landing/launcher /var/www/landing/*.exe /var/www/landing/*.zip 2>/dev/null || true`);
    execSync(`chmod -R 755 /var/www/landing/launcher 2>/dev/null || true`);
    execSync(`chmod 644 /var/www/landing/*.exe /var/www/landing/*.zip 2>/dev/null || true`);
} catch (e) {
    console.warn('[AVERTISSEMENT] Erreur chown/chmod local:', e.message);
}

// 5. Sync to Production VPS (rxcorp.me)
console.log('[5/5] Synchronisation vers le VPS de production rxcorp.me (82.70.251.151)...');
try {
    const vpsHost = '82.70.251.151';
    const vpsUser = 'ubuntu';
    const vpsPass = 'Cornemer2002*';

    // Sync launcher update folder and landing site
    execSync(`sshpass -p '${vpsPass}' rsync -avz -e "ssh -o StrictHostKeyChecking=no" /var/www/landing/launcher/ ${vpsUser}@${vpsHost}:/tmp/launcher_sync/`, { stdio: 'inherit' });
    execSync(`sshpass -p '${vpsPass}' rsync -avz -e "ssh -o StrictHostKeyChecking=no" /var/www/landing/RX*.exe /var/www/landing/RX*.zip ${vpsUser}@${vpsHost}:/tmp/launcher_root/`, { stdio: 'inherit' });
    execSync(`sshpass -p '${vpsPass}' ssh -o StrictHostKeyChecking=no ${vpsUser}@${vpsHost} "echo '${vpsPass}' | sudo -S cp -r /tmp/launcher_sync/* /var/www/landing/launcher/ && sudo cp /tmp/launcher_root/* /var/www/landing/ && sudo chown -R www-data:www-data /var/www/landing/launcher /var/www/landing/*.exe /var/www/landing/*.zip && sudo chmod -R 755 /var/www/landing/launcher && sudo chmod 644 /var/www/landing/*.exe /var/www/landing/*.zip && rm -rf /tmp/launcher_sync /tmp/launcher_root"`, { stdio: 'inherit' });
    console.log('   ✅ Synchronisation VPS production terminée !');
} catch (e) {
    console.warn('[AVERTISSEMENT] Erreur synchro VPS:', e.message);
}

console.log('==================================================');
console.log('   ✅ MISE À JOUR DÉPLOYÉE AVEC SUCCÈS SUR LE CLOUD !');
console.log('   Flux de MAJ : https://rxcorp.me/launcher/update/latest.yml');
console.log('   Téléchargement : https://rxcorp.me/RXCORP-Launcher.exe');
console.log('==================================================');
