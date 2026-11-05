/**
 * Postinstall patch for helios-core JavaGuard (idempotent).
 *
 * Bug: win32DriveMounts() ran `gdr ... | ConvertTo-Json` through powershell.exe WITH the
 * user's profile. Any profile that prints text (fastfetch, oh-my-posh, banners...) breaks
 * JSON.parse and the game never launches. A single drive also returned a string, not an array.
 * Fix: -NoProfile -NonInteractive, tolerant parsing, C:\ fallback.
 */
const fs = require('fs')
const path = require('path')

const file = path.join(__dirname, '..', 'node_modules', 'helios-core', 'dist', 'java', 'JavaGuard.js')
if (!fs.existsSync(file)) {
    console.log('[patch-helios] JavaGuard.js not found, skipping')
    process.exit(0)
}

let src = fs.readFileSync(file, 'utf8')
const MARKER = '/* rxcorp-patched:win32DriveMounts */'
if (src.includes(MARKER)) {
    console.log('[patch-helios] already patched')
    process.exit(0)
}

const start = src.indexOf('async function win32DriveMounts() {')
const end = src.indexOf('async function getPathsOnAllDrivesWin32')
if (start < 0 || end < 0) {
    console.error('[patch-helios] win32DriveMounts not found - helios-core changed, patch NOT applied')
    process.exit(1)
}

const replacement = `async function win32DriveMounts() { ${MARKER}
    const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
    try {
        const { stdout } = await execFileAsync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            '(Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root) | ConvertTo-Json -Compress'
        ], { windowsHide: true, timeout: 15000 });
        // Keep only the JSON payload in case anything else got printed.
        const m = String(stdout).match(/(\\[[\\s\\S]*\\]|"(?:[^"\\\\]|\\\\.)*")\\s*$/);
        const parsed = JSON.parse(m ? m[1] : String(stdout).trim());
        const list = (Array.isArray(parsed) ? parsed : [parsed]).filter(d => typeof d === 'string' && d.length > 0);
        return list.length ? list : ['C:\\\\'];
    }
    catch (error) {
        log.error('Failed to resolve drive mounts, defaulting to C:\\\\');
        log.error(error);
        return ['C:\\\\'];
    }
}
`
src = src.slice(0, start) + replacement + src.slice(end)
fs.writeFileSync(file, src)
console.log('[patch-helios] JavaGuard.win32DriveMounts patched')
