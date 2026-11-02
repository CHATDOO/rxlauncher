const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// Production Pelican Panel Distribution Endpoint
exports.REMOTE_DISTRO_URL = 'https://panel.rxcorp.me/api/launcher/distribution'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api
