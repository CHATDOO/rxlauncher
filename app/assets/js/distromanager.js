const { DistributionAPI } = require('helios-core/common')
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

exports.DistroAPI = api
