/**
 * Real player heads straight from Mojang (third-party renderers like mc-heads
 * often return a stale Steve). Fetches the profile textures, then draws the
 * face (8x8 @ 8,8) + hat overlay (8x8 @ 40,8) into a canvas → PNG data URL.
 * Offline accounts (no Mojang profile) fall back to the default Steve face.
 */
const https = require('https')

const cache = new Map()

function get(url, asBuffer) {
    return new Promise((resolve, reject) => {
        https.get(url.replace(/^http:/, 'https:'), { timeout: 8000 }, res => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
            const chunks = []
            res.on('data', c => chunks.push(c))
            res.on('end', () => {
                const buf = Buffer.concat(chunks)
                resolve(asBuffer ? buf : buf.toString('utf8'))
            })
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')) })
    })
}

async function skinUrlFor(uuid) {
    const profile = JSON.parse(await get(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`))
    const prop = (profile.properties || []).find(p => p.name === 'textures')
    if (!prop) return null
    const tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'))
    return tex.textures && tex.textures.SKIN ? tex.textures.SKIN.url : null
}

function drawHead(pngBuffer, size) {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            const c = document.createElement('canvas')
            c.width = c.height = size
            const ctx = c.getContext('2d')
            ctx.imageSmoothingEnabled = false
            ctx.drawImage(img, 8, 8, 8, 8, 0, 0, size, size)          // face
            ctx.drawImage(img, 40, 8, 8, 8, 0, 0, size, size)         // hat layer
            resolve(c.toDataURL('image/png'))
        }
        img.onerror = reject
        img.src = 'data:image/png;base64,' + pngBuffer.toString('base64')
    })
}

/**
 * @param {{uuid:string, type?:string, displayName?:string}} account
 * @param {number} size output px (default 128)
 * @returns {Promise<string>} data URL (or a remote fallback URL)
 */
exports.headFor = async function (account, size = 128) {
    if (!account || !account.uuid) return null
    const key = account.uuid + ':' + size
    if (cache.has(key)) return cache.get(key)
    let result = `https://mc-heads.net/avatar/MHF_Steve/${size}`
    try {
        if (account.type !== 'offline') {
            const url = await skinUrlFor(account.uuid)
            if (url) result = await drawHead(await get(url, true), size)
        }
    } catch (e) {
        console.warn('[skinhead] falling back to default head', e && e.message)
    }
    cache.set(key, result)
    return result
}
