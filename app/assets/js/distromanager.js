const { DistributionAPI, HeliosDistribution } = require('helios-core/common')
const fs = require('fs-extra')
const path = require('path')
const ConfigManager = require('./configmanager')

// By default, query server code from config (default: RX-8)
const code = (ConfigManager.isLoaded && ConfigManager.isLoaded()) ? ConfigManager.getServerCode() : 'RX-8'
exports.REMOTE_DISTRO_URL = `https://panel.rxcorp.me/api/launcher/distribution/${encodeURIComponent(code)}`

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

exports.DistroAPI = api
