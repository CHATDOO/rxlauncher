const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// RXCORP Production Distribution Manifest
exports.REMOTE_DISTRO_URL = 'https://rxcorp.me/launcher/distribution/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

exports.DistroAPI = api
