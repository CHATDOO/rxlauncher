/**
 * RXCORP animated backdrop.
 *  - Images: two layers crossfading through the backgrounds with a slow drift.
 *  - Video (optional): https://panel.rxcorp.me/launcher-bg/manifest.json →
 *    { "video": "file.mp4", "sha256": "…" }. Downloaded once, verified, cached in
 *    the launcher folder, played muted in a loop on top of the images.
 *    Change the video by editing the manifest — no launcher release needed.
 *  - Pauses while the game runs / window hidden. Respects reduced motion.
 */
(function () {
    const COUNT = 8            // assets/images/backgrounds/0..7.jpg
    const HOLD_MS = 26000      // time each image stays before crossfading
    const MANIFEST = 'https://panel.rxcorp.me/launcher-bg/manifest.json'

    const state = { video: null, paused: false, rotate: null }

    window.rxBackdrop = {
        pause() { state.paused = true; if (state.video) state.video.pause() },
        resume() { state.paused = false; if (state.video && !document.hidden) state.video.play().catch(() => {}) }
    }
    document.addEventListener('visibilitychange', () => {
        if (!state.video) return
        if (document.hidden) state.video.pause()
        else if (!state.paused) state.video.play().catch(() => {})
    })

    function startImages(root, reduced) {
        const layers = root.querySelectorAll('.rxbg')
        const first = parseInt(document.body.getAttribute('bkid'), 10)
        const order = [...Array(COUNT).keys()].filter(i => i !== first).sort(() => Math.random() - 0.5)
        if (!Number.isNaN(first)) order.unshift(first)

        let idx = 0, active = 0
        const src = i => `assets/images/backgrounds/${order[i % order.length]}.jpg`
        const show = (layer, url) => {
            layer.style.backgroundImage = `url('${url}')`
            layer.classList.remove('rxbg-drift')
            void layer.offsetWidth
            if (!reduced) layer.classList.add('rxbg-drift')
        }
        show(layers[0], src(idx))
        layers[0].classList.add('rxbg-on')
        if (reduced) return

        state.rotate = setInterval(() => {
            idx++
            const next = 1 - active
            const url = src(idx)
            const img = new Image()
            img.onload = () => {
                show(layers[next], url)
                layers[next].classList.add('rxbg-on')
                layers[active].classList.remove('rxbg-on')
                active = next
            }
            img.src = url
        }, HOLD_MS)
    }

    function startParallax(root) {
        let tx = 0, ty = 0, cx = 0, cy = 0
        window.addEventListener('mousemove', e => {
            tx = (e.clientX / window.innerWidth - 0.5) * -20
            ty = (e.clientY / window.innerHeight - 0.5) * -12
        })
        const tick = () => {
            cx += (tx - cx) * 0.06
            cy += (ty - cy) * 0.06
            root.style.transform = `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0)`
            requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
    }

    async function cachedVideo() {
        const fs = require('fs')
        const path = require('path')
        const crypto = require('crypto')
        const https = require('https')

        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 6000)
        let manifest
        try {
            const res = await fetch(MANIFEST, { signal: ctrl.signal, cache: 'no-store' })
            if (!res.ok) return null
            manifest = await res.json()
        } finally { clearTimeout(t) }
        // Accept { video, sha256 } or { videos: [{ file, sha256 }, ...] } (one picked at random per launch)
        const valid = n => typeof n === 'string' && /^[\w.\-]+\.(mp4|webm)$/i.test(n)
        const list = Array.isArray(manifest && manifest.videos)
            ? manifest.videos.filter(v => v && valid(v.file)).map(v => ({ file: v.file, sha256: v.sha256 }))
            : (manifest && valid(manifest.video) ? [{ file: manifest.video, sha256: manifest.sha256 }] : [])
        if (!list.length) return null
        const pick = list[Math.floor(Math.random() * list.length)]

        const dir = path.join(require('@electron/remote').app.getPath('userData'), 'backgrounds')
        fs.mkdirSync(dir, { recursive: true })
        const keep = new Set(list.map(v => v.file))
        for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f), { force: true })
        manifest = { video: pick.file, sha256: pick.sha256 }
        const file = path.join(dir, manifest.video)

        const sha = p => new Promise((resolve, reject) => {
            const h = crypto.createHash('sha256')
            fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
        })

        if (fs.existsSync(file) && (!manifest.sha256 || (await sha(file)) === manifest.sha256)) return file

        const url = new window.URL(manifest.video, MANIFEST).toString()
        const part = file + '.part'
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(part)
            https.get(url, res => {
                if (res.statusCode !== 200) { res.resume(); out.close(); return reject(new Error('HTTP ' + res.statusCode)) }
                res.pipe(out)
                out.on('finish', () => out.close(resolve))
            }).on('error', err => { out.close(); reject(err) })
        })
        if (manifest.sha256 && (await sha(part)) !== manifest.sha256) { fs.rmSync(part, { force: true }); throw new Error('checksum mismatch') }
        fs.renameSync(part, file)
        return file
    }

    async function startVideo(root) {
        let file
        try { file = await cachedVideo() } catch (e) { console.warn('[rx-backdrop] video unavailable:', e.message); return }
        if (!file) return
        const v = document.createElement('video')
        v.className = 'rxvid'
        v.muted = true
        v.loop = true
        v.playsInline = true
        v.preload = 'auto'
        v.setAttribute('aria-hidden', 'true')
        // ejs-electron intercepts file:// and serves videos in a way the media
        // pipeline rejects ("Format error"), so play it from an in-memory blob.
        const type = file.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'
        v.src = window.URL.createObjectURL(new window.Blob([require('fs').readFileSync(file)], { type }))
        v.addEventListener('playing', () => {
            v.classList.add('rxvid-on')
            if (state.rotate) { clearInterval(state.rotate); state.rotate = null }
        }, { once: true })
        v.addEventListener('error', () => { console.warn('[rx-backdrop] video error', v.error && v.error.code, v.error && v.error.message, v.src); v.remove() })
        root.appendChild(v)
        state.video = v
        if (!state.paused && !document.hidden) v.play().catch(() => {})
    }

    function start() {
        const root = document.getElementById('rxBackdrop')
        if (!root) return
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        startImages(root, reduced)
        if (reduced) return
        startParallax(root)
        startVideo(root)
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
    else start()
})()
