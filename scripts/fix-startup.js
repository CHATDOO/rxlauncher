#!/usr/bin/env node
/**
 * RXCORP - Fix Startup Command Script
 * Met à jour la commande de démarrage Java du serveur Pelican via l'API Admin
 * 
 * Usage: node fix-startup.js <ADMIN_API_KEY> <SERVER_ID_NUMÉRIQUE>
 * 
 * Exemple: node fix-startup.js ptla_xxxxx 12
 */

const https = require('https');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const PANEL_URL  = 'panel.rxcorp.me';
const SERVER_UUID = '5420e1c7-e45c-43ad-a45f-f356c07b0e0b';

// Nouvelle commande de démarrage optimisée (une seule ligne, sans {{SERVER_MEMORY}})
const NEW_STARTUP = 'java -Xms512M -XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -XX:+UseG1GC -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:G1HeapRegionSize=32M -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dterminal.jline=false -Dterminal.ansi=true @unix_args.txt';
// ───────────────────────────────────────────────────────────────────────────────

const ADMIN_API_KEY = process.argv[2];
const SERVER_NUMERIC_ID = process.argv[3]; // ID numérique du serveur (pas le UUID)

if (!ADMIN_API_KEY) {
    console.error('❌ Usage: node fix-startup.js <ADMIN_API_KEY> <SERVER_NUMERIC_ID>');
    console.error('   Exemple: node fix-startup.js ptla_xxxxxxxxxxxxxxxx 12');
    console.error('\n   La clé admin commence par "ptla_" (pas "ptlc_")');
    console.error('   L\'ID numérique se trouve dans l\'URL du panel: /admin/servers/view/12');
    process.exit(1);
}

if (!SERVER_NUMERIC_ID) {
    console.error('❌ Il faut aussi l\'ID numérique du serveur (dans l\'URL admin du panel).');
    process.exit(1);
}

function apiRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: PANEL_URL,
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${ADMIN_API_KEY.trim()}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'RXCORP-FixStartup/1.0'
            }
        };
        if (payload) {
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, body: data });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function main() {
    console.log('🔧 RXCORP - Fix Startup Command');
    console.log('================================');
    console.log(`📡 Panel: https://${PANEL_URL}`);
    console.log(`🖥️  Server UUID: ${SERVER_UUID}`);
    console.log(`🔢 Server ID numérique: ${SERVER_NUMERIC_ID}`);
    console.log('');

    // 1. Vérifier la connexion avec la clé admin
    console.log('1️⃣  Vérification de la clé API Admin...');
    const authRes = await apiRequest('GET', '/api/application/servers/' + SERVER_NUMERIC_ID);
    
    if (authRes.status === 401) {
        console.error('❌ Clé API invalide ou refusée (401).');
        console.error('   Assure-toi d\'utiliser une clé ADMIN (ptla_...) et non une clé Client (ptlc_...)');
        process.exit(1);
    }
    if (authRes.status === 403) {
        console.error('❌ Accès refusé (403). La clé n\'a pas les permissions admin.');
        process.exit(1);
    }
    if (authRes.status === 404) {
        console.error(`❌ Serveur ID ${SERVER_NUMERIC_ID} introuvable (404).`);
        console.error('   Vérifie l\'ID numérique dans l\'URL: https://panel.rxcorp.me/admin/servers/view/<ID>');
        process.exit(1);
    }
    if (authRes.status !== 200) {
        console.error(`❌ Erreur inattendue (${authRes.status}): ${authRes.body}`);
        process.exit(1);
    }

    let serverData;
    try {
        serverData = JSON.parse(authRes.body);
    } catch {
        console.error('❌ Réponse JSON invalide:', authRes.body.slice(0, 200));
        process.exit(1);
    }

    const serverName = serverData?.attributes?.name || '???';
    const currentStartup = serverData?.attributes?.startup || '';
    console.log(`✅ Serveur trouvé: "${serverName}"`);
    console.log(`\n📋 Commande actuelle:\n   ${currentStartup || '(vide)'}`);
    console.log(`\n🆕 Nouvelle commande:\n   ${NEW_STARTUP}`);
    console.log('');

    // 2. Mettre à jour la commande de startup via PATCH /api/application/servers/<id>/startup
    console.log('2️⃣  Application de la nouvelle commande...');
    
    // On a besoin des egg variables actuelles pour ne pas les perdre
    const eggId = serverData?.attributes?.egg || null;
    const envVars = serverData?.attributes?.environment || {};

    const updatePayload = {
        startup: NEW_STARTUP,
        environment: envVars,
        egg: eggId,
        image: serverData?.attributes?.container?.image || '',
        skip_scripts: false
    };

    const updateRes = await apiRequest(
        'PATCH',
        `/api/application/servers/${SERVER_NUMERIC_ID}/startup`,
        updatePayload
    );

    if (updateRes.status === 200 || updateRes.status === 204) {
        console.log('✅ Commande de démarrage mise à jour avec succès !');
        console.log('');
        console.log('🎯 Prochaine étape: Redémarre le serveur depuis Pelican Panel.');
        console.log(`   👉 https://${PANEL_URL}/admin/servers/view/${SERVER_NUMERIC_ID}`);
    } else {
        console.error(`❌ Échec de la mise à jour (${updateRes.status}):`);
        try {
            const errBody = JSON.parse(updateRes.body);
            console.error(JSON.stringify(errBody, null, 2));
        } catch {
            console.error(updateRes.body.slice(0, 500));
        }
        process.exit(1);
    }
}

main().catch(err => {
    console.error('💥 Erreur fatale:', err.message);
    process.exit(1);
});
