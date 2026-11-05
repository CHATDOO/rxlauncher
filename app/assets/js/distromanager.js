const { DistributionAPI, HeliosDistribution } = require('helios-core/common')
const fs = require('fs-extra')
const path = require('path')
const ConfigManager = require('./configmanager')

// Query the distribution for the player's saved server code.
// No code = public placeholder distribution (no real server is exposed without its code)
const code = (ConfigManager.isLoaded && ConfigManager.isLoaded()) ? ConfigManager.getServerCode() : ''
exports.REMOTE_DISTRO_URL = code
    ? `https://panel.rxcorp.me/api/launcher/distribution/${encodeURIComponent(code)}`
    : 'https://panel.rxcorp.me/api/launcher/distribution'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

// Preserve existing server instances when writing distribution to disk
const originalWrite = api.writeDistributionToDisk.bind(api)
api.writeDistributionToDisk = async function(distribution) {
    try {
        if (await fs.pathExists(this.distroPath)) {
            const existing = await fs.readJson(this.distroPath)
            if (existing && Array.isArray(existing.servers) && Array.isArray(distribution.servers)) {
                const mergedServers = [...existing.servers]
                for (const newServ of distribution.servers) {
                    const idx = mergedServers.findIndex(s => s.id === newServ.id)
                    if (idx >= 0) {
                        mergedServers[idx] = newServ
                    } else {
                        mergedServers.push(newServ)
                    }
                }
                distribution.servers = mergedServers
            }
        }
    } catch (e) {
        // Fallback to normal write if read/merge fails
    }
    return await originalWrite(distribution)
}

/**
 * Add or update a server instance from Pelican Panel server code
 * Ensures instance directory, config, and distribution are updated in memory and on disk.
 */
api.addServerInstance = async function(targetRaw, serverCode, fullDistroData = null) {
    const launcherDir = ConfigManager.getLauncherDirectory()
    const instanceBaseDir = ConfigManager.getInstanceDirectory()
    const distroFilePath = this.distroPath || path.join(launcherDir, 'distribution.json')

    // Read current raw distribution
    let currentRaw = this.rawDistribution
    if (!currentRaw && (await fs.pathExists(distroFilePath))) {
        try {
            currentRaw = await fs.readJson(distroFilePath)
        } catch (e) {
            currentRaw = null
        }
    }

    if (!currentRaw || !Array.isArray(currentRaw.servers)) {
        currentRaw = {
            version: fullDistroData?.version || '1.0.0',
            rss: fullDistroData?.rss || 'https://rxcorp.me/launcher/distribution/rss.xml',
            discord: fullDistroData?.discord || { clientId: '1086936373057040995', smallImageText: 'RXLauncher', smallImageKey: 'icon' },
            servers: []
        }
    }

    // Merge server into current servers array
    const existingIndex = currentRaw.servers.findIndex(s => s.id === targetRaw.id)
    if (existingIndex >= 0) {
        currentRaw.servers[existingIndex] = targetRaw
    } else {
        currentRaw.servers.push(targetRaw)
    }

    // Mark as mainServer for active selection
    currentRaw.servers.forEach(s => {
        s.mainServer = (s.id === targetRaw.id)
    })

    // Ensure physical instance directory exists on disk
    const targetInstanceDir = path.join(instanceBaseDir, targetRaw.id)
    await fs.ensureDir(targetInstanceDir)
    await fs.ensureDir(path.join(targetInstanceDir, 'mods'))
    await fs.ensureDir(path.join(targetInstanceDir, 'config'))

    // Write instance metadata file
    const instanceMetaFile = path.join(targetInstanceDir, 'instance.json')
    const instanceMeta = {
        id: targetRaw.id,
        name: targetRaw.name,
        code: serverCode,
        minecraftVersion: targetRaw.minecraftVersion,
        address: targetRaw.address,
        updatedAt: new Date().toISOString()
    }
    await fs.writeJson(instanceMetaFile, instanceMeta, { spaces: 2 })

    // Save updated distribution to disk
    await fs.writeJson(distroFilePath, currentRaw, { spaces: 2 })

    // Force update in-memory distribution models
    this.rawDistribution = currentRaw
    this.distribution = new HeliosDistribution(currentRaw, this.commonDir || ConfigManager.getCommonDirectory(), this.instanceDir || instanceBaseDir)

    const serverObj = this.distribution.getServerById(targetRaw.id)
    if (serverObj) {
        ConfigManager.ensureJavaConfig(targetRaw.id, serverObj.effectiveJavaOptions)
    }
    return serverObj
}

/**
 * Drop every locally cached server the player has no valid code for.
 * Older builds merged the panel's public listing into distribution.json, so a
 * player could still see other people's servers. Each kept server must have an
 * instance.json with a code that the panel still accepts.
 *
 * @returns {Promise<boolean>} true if the local list changed.
 */
api.pruneUnauthorizedServers = async function() {
    const launcherDir = ConfigManager.getLauncherDirectory()
    const instanceBaseDir = ConfigManager.getInstanceDirectory()
    const distroFilePath = this.distroPath || path.join(launcherDir, 'distribution.json')
    if (!(await fs.pathExists(distroFilePath))) return false

    let raw
    try { raw = await fs.readJson(distroFilePath) } catch (e) { return false }
    if (!raw || !Array.isArray(raw.servers)) return false

    const kept = []
    for (const s of raw.servers) {
        if (s.id === 'rxcorp-mc-default') { kept.push(s); continue }
        let code = null
        try { code = (await fs.readJson(path.join(instanceBaseDir, s.id, 'instance.json'))).code } catch (e) { /* no instance.json */ }
        if (!code) continue
        try {
            const res = await fetch(`https://panel.rxcorp.me/api/launcher/distribution/${encodeURIComponent(code)}`)
            if (res.status === 404 || res.status === 403) continue        // code revoked/invalid
            if (res.ok) {
                const data = await res.json()
                const fresh = (data.servers || [])[0]
                kept.push(fresh && fresh.id === s.id ? Object.assign(fresh, { mainServer: s.mainServer }) : s)
                continue
            }
        } catch (e) { /* offline: keep what the player legitimately synced */ }
        kept.push(s)
    }

    if (kept.length === raw.servers.length && kept.every((s, i) => s.id === raw.servers[i].id)) return false
    raw.servers = kept
    await fs.writeJson(distroFilePath, raw, { spaces: 2 })
    this.rawDistribution = raw
    this.distribution = new HeliosDistribution(raw, this.commonDir || ConfigManager.getCommonDirectory(), this.instanceDir || instanceBaseDir)
    return true
}

exports.DistroAPI = api
