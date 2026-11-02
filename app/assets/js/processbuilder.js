const AdmZip                = require('adm-zip')
const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const { LoggerUtil }        = require('helios-core')
const { getMojangOS, isLibraryCompatible, mcVersionAtLeast }  = require('helios-core/common')
const { Type }              = require('helios-distribution-types')
const os                    = require('os')
const path                  = require('path')

const ConfigManager            = require('./configmanager')

const logger = LoggerUtil.getLogger('ProcessBuilder')


/**
 * Only forge and fabric are top level mod loaders.
 * 
 * Forge 1.13+ launch logic is similar to fabrics, for now using usingFabricLoader flag to
 * change minor details when needed.
 * 
 * Rewrite of this module may be needed in the future.
 */
class ProcessBuilder {

    constructor(distroServer, vanillaManifest, modManifest, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.rawServer.id)
        this.commonDir = ConfigManager.getCommonDirectory()
        this.server = distroServer
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'forgeMods.list') // 1.13+
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.llDir = path.join(this.gameDir, 'liteloaderModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.usingFabricLoader = false
        this.llPath = null
    }
    
    ensureServersDat(){
        try {
            const address = this.server.rawServer.address || `${this.server.hostname}:${this.server.port}`
            if(!address || address === 'null' || address === 'undefined') return

            const serversDatPath = path.join(this.gameDir, 'servers.dat')
            const name = this.server.rawServer.name || 'Serveur RXCORP'
            const zlib = require('zlib')
            
            function writeString(buf, str) {
                const strBuf = Buffer.from(str, 'utf8')
                const lenBuf = Buffer.alloc(2)
                lenBuf.writeUInt16BE(strBuf.length, 0)
                return Buffer.concat([buf, lenBuf, strBuf])
            }

            let b = Buffer.from([0x0A, 0x00, 0x00]) // Compound root
            b = Buffer.concat([b, Buffer.from([0x09])]) // List tag
            b = writeString(b, 'servers')
            const listHeader = Buffer.alloc(5)
            listHeader.writeUInt8(0x0A, 0) // element type compound
            listHeader.writeInt32BE(1, 1)  // 1 server
            b = Buffer.concat([b, listHeader])

            b = Buffer.concat([b, Buffer.from([0x08])]) // String name
            b = writeString(b, 'name')
            b = writeString(b, name)

            b = Buffer.concat([b, Buffer.from([0x08])]) // String ip
            b = writeString(b, 'ip')
            b = writeString(b, address)

            b = Buffer.concat([b, Buffer.from([0x00, 0x00])]) // End of compound, end of root
            fs.writeFileSync(serversDatPath, zlib.gzipSync(b))
            logger.info(`Initialized servers.dat for ${name} (${address})`)
        } catch(e) {
            logger.warn('Unable to write servers.dat:', e.message)
        }
    }

    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build(){
        fs.ensureDirSync(this.gameDir)
        this.ensureServersDat()
        this.syncSharedGameOptions()
        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true
        this.setupLiteLoader()
        logger.info('Using liteloader:', this.usingLiteLoader)
        this.usingFabricLoader = this.server.modules.some(mdl => mdl.rawModule.type === Type.Fabric)
        logger.info('Using fabric loader:', this.usingFabricLoader)
        const modObj = this.resolveModConfiguration(ConfigManager.getModConfiguration(this.server.rawServer.id).mods, this.server.modules)
        
        // Mod list below 1.13
        // Fabric only supports 1.14+
        if(!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            this.constructJSONModList('forge', modObj.fMods, true)
            if(this.usingLiteLoader){
                this.constructJSONModList('liteloader', modObj.lMods, true)
            }
        }
        
        const uberModArr = modObj.fMods.concat(modObj.lMods)
        let args = this.constructJVMArguments(uberModArr, tempNativePath)

        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            //args = args.concat(this.constructModArguments(modObj.fMods))
            args = args.concat(this.constructModList(modObj.fMods))
        }

        // Hide access token
        const loggableArgs = [...args]
        loggableArgs[loggableArgs.findIndex(x => x === this.authUser.accessToken)] = '**********'

        logger.info('Launch Arguments:', loggableArgs)

        const child = child_process.spawn(ConfigManager.getJavaExecutable(this.server.rawServer.id), args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if(ConfigManager.getLaunchDetached()){
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[32m[Minecraft]\x1b[0m ${x}`))
            
        })
        child.stderr.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[31m[Minecraft]\x1b[0m ${x}`))
        })
        child.on('close', (code) => {
            logger.info('Exited with code', code)
            try {
                this.saveSharedGameOptions()
            } catch(e) {
                logger.warn('Failed to save shared options after game exit:', e)
            }
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.info('Temp dir deleted successfully.')
                }
            })
        })

        return child
    }

    getSharedDirectory() {
        return path.join(ConfigManager.getDataDirectory(), 'shared')
    }

    syncSharedGameOptions() {
        try {
            const sharedDir = this.getSharedDirectory()
            fs.ensureDirSync(sharedDir)

            const optionFiles = [
                'options.txt',
                'optionsof.txt',
                'optionsshaders.txt',
                'optionsiris.txt',
                'sodiumoptions.json'
            ]

            // 1. Initial discovery: if shared options.txt doesn't exist, search existing instances for the newest one
            const sharedOptionsTxt = path.join(sharedDir, 'options.txt')
            if (!fs.existsSync(sharedOptionsTxt)) {
                let newestFile = null
                let newestMtime = 0
                const instanceBase = ConfigManager.getInstanceDirectory()
                if (fs.existsSync(instanceBase)) {
                    const instances = fs.readdirSync(instanceBase)
                    for (const inst of instances) {
                        const candidate = path.join(instanceBase, inst, 'options.txt')
                        if (fs.existsSync(candidate)) {
                            try {
                                const stat = fs.statSync(candidate)
                                if (stat.mtimeMs > newestMtime) {
                                    newestMtime = stat.mtimeMs
                                    newestFile = candidate
                                }
                            } catch (_) {}
                        }
                    }
                }
                if (newestFile) {
                    logger.info(`Bootstrapping shared options from newest instance: ${newestFile}`)
                    fs.copyFileSync(newestFile, sharedOptionsTxt)
                }
            }

            // 2. Synchronize option files between sharedDir and this.gameDir
            for (const file of optionFiles) {
                const src = path.join(sharedDir, file)
                const dest = path.join(this.gameDir, file)

                const srcExists = fs.existsSync(src)
                const destExists = fs.existsSync(dest)

                if (srcExists && !destExists) {
                    fs.copyFileSync(src, dest)
                } else if (!srcExists && destExists) {
                    fs.copyFileSync(dest, src)
                } else if (srcExists && destExists) {
                    try {
                        const srcMtime = fs.statSync(src).mtimeMs
                        const destMtime = fs.statSync(dest).mtimeMs
                        if (destMtime > srcMtime) {
                            fs.copyFileSync(dest, src)
                        } else if (srcMtime > destMtime) {
                            fs.copyFileSync(src, dest)
                        }
                    } catch (_) {}
                }
            }

            // 3. Synchronize folders: resourcepacks, shaderpacks
            const sharedFolders = ['resourcepacks', 'shaderpacks']
            for (const folder of sharedFolders) {
                const sharedFolderPath = path.join(sharedDir, folder)
                const gameFolderPath = path.join(this.gameDir, folder)
                fs.ensureDirSync(sharedFolderPath)

                let linkNeeded = true
                if (fs.existsSync(gameFolderPath)) {
                    try {
                        const stat = fs.lstatSync(gameFolderPath)
                        if (stat.isSymbolicLink()) {
                            linkNeeded = false
                        } else {
                            // Regular directory - copy existing contents to shared if any, then remove to link
                            const files = fs.readdirSync(gameFolderPath)
                            for (const f of files) {
                                const sf = path.join(sharedFolderPath, f)
                                const gf = path.join(gameFolderPath, f)
                                if (!fs.existsSync(sf)) {
                                    fs.copySync(gf, sf)
                                }
                            }
                            fs.removeSync(gameFolderPath)
                        }
                    } catch (err) {
                        logger.warn(`Could not migrate existing ${folder} directory:`, err)
                        linkNeeded = false
                    }
                }

                if (linkNeeded) {
                    try {
                        const type = process.platform === 'win32' ? 'junction' : 'dir'
                        fs.symlinkSync(sharedFolderPath, gameFolderPath, type)
                        logger.info(`Linked ${folder} -> ${sharedFolderPath}`)
                    } catch (err) {
                        logger.warn(`Could not create junction/symlink for ${folder}, falling back to copy:`, err)
                        fs.copySync(sharedFolderPath, gameFolderPath)
                    }
                }
            }
        } catch (err) {
            logger.warn('Error during syncSharedGameOptions:', err)
        }
    }

    saveSharedGameOptions() {
        try {
            const sharedDir = this.getSharedDirectory()
            fs.ensureDirSync(sharedDir)

            const optionFiles = [
                'options.txt',
                'optionsof.txt',
                'optionsshaders.txt',
                'optionsiris.txt',
                'sodiumoptions.json'
            ]

            for (const file of optionFiles) {
                const gameFile = path.join(this.gameDir, file)
                const sharedFile = path.join(sharedDir, file)
                if (fs.existsSync(gameFile)) {
                    fs.copyFileSync(gameFile, sharedFile)
                }
            }

            // Fallback for folders if symlink was not active
            const sharedFolders = ['resourcepacks', 'shaderpacks']
            for (const folder of sharedFolders) {
                const sharedFolderPath = path.join(sharedDir, folder)
                const gameFolderPath = path.join(this.gameDir, folder)
                if (fs.existsSync(gameFolderPath) && fs.existsSync(sharedFolderPath)) {
                    try {
                        const stat = fs.lstatSync(gameFolderPath)
                        if (!stat.isSymbolicLink()) {
                            fs.copySync(gameFolderPath, sharedFolderPath)
                        }
                    } catch (_) {}
                }
            }

            logger.info('Saved in-game options to shared directory.')
        } catch (err) {
            logger.warn('Error during saveSharedGameOptions:', err)
        }
    }

    /**
     * Get the platform specific classpath separator. On windows, this is a semicolon.
     * On Unix, this is a colon.
     * 
     * @returns {string} The classpath separator for the current operating system.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }

    /**
     * Determine if an optional mod is enabled from its configuration value. If the
     * configuration value is null, the required object will be used to
     * determine if it is enabled.
     * 
     * A mod is enabled if:
     *   * The configuration is not null and one of the following:
     *     * The configuration is a boolean and true.
     *     * The configuration is an object and its 'value' property is true.
     *   * The configuration is null and one of the following:
     *     * The required object is null.
     *     * The required object's 'def' property is null or true.
     * 
     * @param {Object | boolean} modCfg The mod configuration object.
     * @param {Object} required Optional. The required object from the mod's distro declaration.
     * @returns {boolean} True if the mod is enabled, false otherwise.
     */
    static isModEnabled(modCfg, required = null){
        return modCfg != null ? ((typeof modCfg === 'boolean' && modCfg) || (typeof modCfg === 'object' && (typeof modCfg.value !== 'undefined' ? modCfg.value : true))) : required != null ? required.def : true
    }

    /**
     * Function which performs a preliminary scan of the top level
     * mods. If liteloader is present here, we setup the special liteloader
     * launch options. Note that liteloader is only allowed as a top level
     * mod. It must not be declared as a submodule.
     */
    setupLiteLoader(){
        for(let ll of this.server.modules){
            if(ll.rawModule.type === Type.LiteLoader){
                if(!ll.getRequired().value){
                    const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                    if(ProcessBuilder.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], ll.getRequired())){
                        if(fs.existsSync(ll.getPath())){
                            this.usingLiteLoader = true
                            this.llPath = ll.getPath()
                        }
                    }
                } else {
                    if(fs.existsSync(ll.getPath())){
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
    }

    /**
     * Resolve an array of all enabled mods. These mods will be constructed into
     * a mod list format and enabled at launch.
     * 
     * @param {Object} modCfg The mod configuration object.
     * @param {Array.<Object>} mdls An array of modules to parse.
     * @returns {{fMods: Array.<Object>, lMods: Array.<Object>}} An object which contains
     * a list of enabled forge mods and litemods.
     */
    resolveModConfiguration(modCfg, mdls){
        let fMods = []
        let lMods = []

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                const o = !mdl.getRequired().value
                const e = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                if(!o || (o && e)){
                    if(mdl.subModules.length > 0){
                        const v = this.resolveModConfiguration(modCfg[mdl.getVersionlessMavenIdentifier()].mods, mdl.subModules)
                        fMods = fMods.concat(v.fMods)
                        lMods = lMods.concat(v.lMods)
                        if(type === Type.LiteLoader){
                            continue
                        }
                    }
                    if(type === Type.ForgeMod || type === Type.FabricMod){
                        fMods.push(mdl)
                    } else {
                        lMods.push(mdl)
                    }
                }
            }
        }

        return {
            fMods,
            lMods
        }
    }

    _lteMinorVersion(version) {
        if(!this.modManifest || !this.modManifest.id || !this.modManifest.id.includes('-')) {
            return false
        }
        return Number(this.modManifest.id.split('-')[0].split('.')[1]) <= Number(version)
    }

    /**
     * Test to see if this version of forge requires the absolute: prefix
     * on the modListFile repository field.
     */
    _requiresAbsolute(){
        try {
            if(!this.modManifest || !this.modManifest.id || !this.modManifest.id.includes('-')) {
                return false
            }
            if(this._lteMinorVersion(9)) {
                return false
            }
            const ver = this.modManifest.id.split('-')[2]
            const pts = ver.split('.')
            const min = [14, 23, 3, 2655]
            for(let i=0; i<pts.length; i++){
                const parsed = Number.parseInt(pts[i])
                if(parsed < min[i]){
                    return false
                } else if(parsed > min[i]){
                    return true
                }
            }
        } catch (_err) {
            // We know old forge versions follow this format.
            // Error must be caused by newer version.
        }
        
        // Equal or errored
        return true
    }

    /**
     * Construct a mod list json object.
     * 
     * @param {'forge' | 'liteloader'} type The mod list type to construct.
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     * @param {boolean} save Optional. Whether or not we should save the mod list file.
     */
    constructJSONModList(type, mods, save = false){
        const modList = {
            repositoryRoot: ((type === 'forge' && this._requiresAbsolute()) ? 'absolute:' : '') + path.join(this.commonDir, 'modstore')
        }

        const ids = []
        if(type === 'forge'){
            for(let mod of mods){
                ids.push(mod.getExtensionlessMavenIdentifier())
            }
        } else {
            for(let mod of mods){
                ids.push(mod.getMavenIdentifier())
            }
        }
        modList.modRef = ids
        
        if(save){
            const json = JSON.stringify(modList, null, 4)
            fs.writeFileSync(type === 'forge' ? this.fmlDir : this.llDir, json, 'UTF-8')
        }

        return modList
    }

    // /**
    //  * Construct the mod argument list for forge 1.13
    //  * 
    //  * @param {Array.<Object>} mods An array of mods to add to the mod list.
    //  */
    // constructModArguments(mods){
    //     const argStr = mods.map(mod => {
    //         return mod.getExtensionlessMavenIdentifier()
    //     }).join(',')

    //     if(argStr){
    //         return [
    //             '--fml.mavenRoots',
    //             path.join('..', '..', 'common', 'modstore'),
    //             '--fml.mods',
    //             argStr
    //         ]
    //     } else {
    //         return []
    //     }
        
    // }

    /**
     * Construct the mod argument list for forge 1.13 and Fabric
     * 
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     */
    constructModList(mods) {
        const writeBuffer = mods.map(mod => {
            return this.usingFabricLoader ? mod.getPath() : mod.getExtensionlessMavenIdentifier()
        }).join('\n')

        if(writeBuffer) {
            fs.writeFileSync(this.forgeModListFile, writeBuffer, 'UTF-8')
            return this.usingFabricLoader ? [
                '--fabric.addMods',
                `@${this.forgeModListFile}`
            ] : [
                '--fml.mavenRoots',
                path.join('..', '..', 'common', 'modstore'),
                '--fml.modLists',
                this.forgeModListFile
            ]
        } else {
            return []
        }

    }

    _processAutoConnectArg(args){
        if(ConfigManager.getAutoConnect() && (this.server.rawServer.autoconnect !== false)){
            const address = this.server.rawServer.address || `${this.server.hostname}:${this.server.port}`
            if(address && address !== 'null' && address !== 'undefined'){
                if(mcVersionAtLeast('1.20', this.server.rawServer.minecraftVersion)){
                    args.push('--quickPlayMultiplayer')
                    args.push(address)
                } else {
                    const host = this.server.hostname || address.split(':')[0]
                    const port = this.server.port || address.split(':')[1] || '25565'
                    args.push('--server')
                    args.push(host)
                    args.push('--port')
                    args.push(String(port))
                }
            }
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    constructJVMArguments(mods, tempNativePath){
        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            return this._constructJVMArguments113(mods, tempNativePath)
        } else {
            return this._constructJVMArguments112(mods, tempNativePath)
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.12 and below.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments112(mods, tempNativePath){

        let args = []

        // Classpath Argument
        args.push('-cp')
        args.push(this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator()))

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=HeliosLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + tempNativePath)

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Forge Arguments
        args = args.concat(this._resolveForgeArgs())

        return args
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.13+
     * 
     * Note: Required Libs https://github.com/MinecraftForge/MinecraftForge/blob/af98088d04186452cb364280340124dfd4766a5c/src/fmllauncher/java/net/minecraftforge/fml/loading/LibraryFinder.java#L82
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments113(mods, tempNativePath){

        const argDiscovery = /\${*(.*)}/

        // JVM Arguments First
        let args = this.vanillaManifest.arguments.jvm

        // Debug securejarhandler
        // args.push('-Dbsl.debug=true')

        if(this.modManifest != null && this.modManifest.arguments != null && this.modManifest.arguments.jvm != null) {
            for(const argStr of this.modManifest.arguments.jvm) {
                let resolved = argStr
                    .replaceAll('${library_directory}', this.libPath)
                    .replaceAll('${classpath_separator}', ProcessBuilder.getClasspathSeparator())
                    .replaceAll('${version_name}', this.modManifest.id || this.server.rawServer.minecraftVersion)
                if (resolved.startsWith('-Dforgewrapper.installer=')) {
                    const rawVal = resolved.substring('-Dforgewrapper.installer='.length)
                    resolved = '-Dforgewrapper.installer=' + path.normalize(rawVal)
                } else if (resolved.startsWith('-Dforgewrapper.minecraft=')) {
                    const rawVal = resolved.substring('-Dforgewrapper.minecraft='.length)
                    resolved = '-Dforgewrapper.minecraft=' + path.normalize(rawVal)
                } else if (resolved.startsWith('-Dforgewrapper.librariesDir=')) {
                    const rawVal = resolved.substring('-Dforgewrapper.librariesDir='.length)
                    resolved = '-Dforgewrapper.librariesDir=' + path.normalize(rawVal)
                }
                args.push(resolved)
            }
        }

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=HeliosLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))

        // Main Java Class
        const targetMainClass = (this.modManifest && this.modManifest.mainClass) ? this.modManifest.mainClass : this.vanillaManifest.mainClass

        // Ensure ForgeWrapper properties if using ForgeWrapper
        if (targetMainClass === 'io.github.zekerzhayard.forgewrapper.installer.Main') {
            const hasLibDir = args.some(a => typeof a === 'string' && a.startsWith('-Dforgewrapper.librariesDir='))
            if (!hasLibDir) {
                args.push(`-Dforgewrapper.librariesDir=${this.libPath}`)
            }
            const hasMc = args.some(a => typeof a === 'string' && a.startsWith('-Dforgewrapper.minecraft='))
            if (!hasMc) {
                const mcJar = path.join(this.commonDir, 'versions', this.server.rawServer.minecraftVersion, `${this.server.rawServer.minecraftVersion}.jar`)
                args.push(`-Dforgewrapper.minecraft=${mcJar}`)
            }
        }

        args.push(targetMainClass)

        // Vanilla Arguments
        args = args.concat(this.vanillaManifest.arguments.game)

        for(let i=0; i<args.length; i++){
            if(typeof args[i] === 'object' && args[i].rules != null){
                
                let checksum = 0
                for(let rule of args[i].rules){
                    if(rule.os != null){
                        if(rule.os.name === getMojangOS()
                            && (rule.os.version == null || new RegExp(rule.os.version).test(os.release))){
                            if(rule.action === 'allow'){
                                checksum++
                            }
                        } else {
                            if(rule.action === 'disallow'){
                                checksum++
                            }
                        }
                    } else if(rule.features != null){
                        // We don't have many 'features' in the index at the moment.
                        // This should be fine for a while.
                        if(rule.features.has_custom_resolution != null && rule.features.has_custom_resolution === true){
                            if(ConfigManager.getFullscreen()){
                                args[i].value = [
                                    '--fullscreen',
                                    'true'
                                ]
                            }
                            checksum++
                        }
                    }
                }

                // TODO splice not push
                if(checksum === args[i].rules.length){
                    if(typeof args[i].value === 'string'){
                        args[i] = args[i].value
                    } else if(typeof args[i].value === 'object'){
                        //args = args.concat(args[i].value)
                        args.splice(i, 1, ...args[i].value)
                    }

                    // Decrement i to reprocess the resolved value
                    i--
                } else {
                    args[i] = null
                }

            } else if(typeof args[i] === 'string'){
                if(argDiscovery.test(args[i])){
                    const identifier = args[i].match(argDiscovery)[1]
                    let val = null
                    switch(identifier){
                        case 'auth_player_name':
                            val = this.authUser.displayName.trim()
                            break
                        case 'version_name':
                            //val = vanillaManifest.id
                            val = this.server.rawServer.id
                            break
                        case 'game_directory':
                            val = this.gameDir
                            break
                        case 'assets_root':
                            val = path.join(this.commonDir, 'assets')
                            break
                        case 'assets_index_name':
                            val = this.vanillaManifest.assets
                            break
                        case 'auth_uuid':
                            val = this.authUser.uuid.trim()
                            break
                        case 'auth_access_token':
                            val = this.authUser.accessToken
                            break
                        case 'user_type':
                            val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                            break
                        case 'version_type':
                            val = this.vanillaManifest.type
                            break
                        case 'resolution_width':
                            val = ConfigManager.getGameWidth()
                            break
                        case 'resolution_height':
                            val = ConfigManager.getGameHeight()
                            break
                        case 'natives_directory':
                            val = args[i].replace(argDiscovery, tempNativePath)
                            break
                        case 'launcher_name':
                            val = args[i].replace(argDiscovery, 'Helios-Launcher')
                            break
                        case 'launcher_version':
                            val = args[i].replace(argDiscovery, this.launcherVersion)
                            break
                        case 'classpath':
                            val = this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator())
                            break
                    }
                    if(val != null){
                        args[i] = val
                    }
                }
            }
        }

        // Autoconnect
        this._processAutoConnectArg(args)
        

        // Forge / Loader Specific Arguments
        if(this.modManifest != null && this.modManifest.arguments != null && Array.isArray(this.modManifest.arguments.game)) {
            args = args.concat(this.modManifest.arguments.game)
        }

        // Filter null values
        args = args.filter(arg => {
            return arg != null
        })

        return args
    }

    /**
     * Resolve the arguments required by forge.
     * 
     * @returns {Array.<string>} An array containing the arguments required by forge.
     */
    _resolveForgeArgs(){
        if(!this.modManifest || !this.modManifest.minecraftArguments) {
            return []
        }
        const mcArgs = this.modManifest.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/

        // Replace the declared variables with their proper values.
        for(let i=0; i<mcArgs.length; ++i){
            if(argDiscovery.test(mcArgs[i])){
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch(identifier){
                    case 'auth_player_name':
                        val = this.authUser.displayName.trim()
                        break
                    case 'version_name':
                        //val = vanillaManifest.id
                        val = this.server.rawServer.id
                        break
                    case 'game_directory':
                        val = this.gameDir
                        break
                    case 'assets_root':
                        val = path.join(this.commonDir, 'assets')
                        break
                    case 'assets_index_name':
                        val = this.vanillaManifest.assets
                        break
                    case 'auth_uuid':
                        val = this.authUser.uuid.trim()
                        break
                    case 'auth_access_token':
                        val = this.authUser.accessToken
                        break
                    case 'user_type':
                        val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                        break
                    case 'user_properties': // 1.8.9 and below.
                        val = '{}'
                        break
                    case 'version_type':
                        val = this.vanillaManifest.type
                        break
                }
                if(val != null){
                    mcArgs[i] = val
                }
            }
        }

        // Autoconnect to the selected server.
        this._processAutoConnectArg(mcArgs)

        // Prepare game resolution
        if(ConfigManager.getFullscreen()){
            mcArgs.push('--fullscreen')
            mcArgs.push(true)
        } else {
            mcArgs.push('--width')
            mcArgs.push(ConfigManager.getGameWidth())
            mcArgs.push('--height')
            mcArgs.push(ConfigManager.getGameHeight())
        }
        
        // Mod List File Argument
        mcArgs.push('--modListFile')
        if(this._lteMinorVersion(9)) {
            mcArgs.push(path.basename(this.fmlDir))
        } else {
            mcArgs.push('absolute:' + this.fmlDir)
        }
        

        // LiteLoader
        if(this.usingLiteLoader){
            mcArgs.push('--modRepo')
            mcArgs.push(this.llDir)

            // Set first arg to liteloader tweak class
            mcArgs.unshift('com.mumfrey.liteloader.launch.LiteLoaderTweaker')
            mcArgs.unshift('--tweakClass')
        }

        return mcArgs
    }

    /**
     * Ensure that the classpath entries all point to jar files.
     * 
     * @param {Array.<String>} list Array of classpath entries.
     */
    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for(let i=0; i<list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if(extIndex > -1 && extIndex  !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }

    /**
     * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
     * libraries as well as the libraries declared by the server. Since mods are permitted to declare libraries,
     * this method requires all enabled mods as an input
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the paths of each library required by this process.
     */
    classpathArg(mods, tempNativePath){
        let cpArgs = []

        const isUsingForgeBootstrap = (this.modManifest != null && this.modManifest.mainClass && this.modManifest.mainClass !== 'net.minecraft.client.main.Main')
        if(!isUsingForgeBootstrap || !mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) || this.usingFabricLoader) {
            // Add the version.jar to the classpath.
            // Must not be added to the classpath for Forge 1.17+ when using ForgeBootstrap.
            const version = (this.vanillaManifest && this.vanillaManifest.id) ? this.vanillaManifest.id : this.server.rawServer.minecraftVersion
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        }
        

        if(this.usingLiteLoader){
            cpArgs.push(this.llPath)
        }

        // Resolve the Mojang declared libraries.
        const mojangLibs = this._resolveMojangLibraries(tempNativePath)

        // Resolve the server declared libraries.
        const servLibs = this._resolveServerLibraries(mods)

        // Merge libraries, server libs with the same
        // maven identifier will override the mojang ones.
        // Ex. 1.7.10 forge overrides mojang's guava with newer version.
        const finalLibs = {...mojangLibs, ...servLibs}

        // Ensure installer jars are never included on the runtime classpath.
        // The installer jar is only used by ForgeWrapper via -Dforgewrapper.installer
        // and contains shaded classes (like jopt-simple) that trigger JPMS split-package collisions.
        for (const [key, libPath] of Object.entries(finalLibs)) {
            if (typeof libPath === 'string' && libPath.endsWith('-installer.jar')) {
                delete finalLibs[key]
            }
        }

        cpArgs = cpArgs.concat(Object.values(finalLibs))

        this._processClassPathList(cpArgs)

        return cpArgs
    }

    /**
     * Resolve the libraries defined by Mojang's version data. This method will also extract
     * native libraries and point to the correct location for its classpath.
     * 
     * TODO - clean up function
     * 
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {{[id: string]: string}} An object containing the paths of each library mojang declares.
     */
    _resolveMojangLibraries(tempNativePath){
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}

        const libArr = this.vanillaManifest.libraries
        fs.ensureDirSync(tempNativePath)
        for(let i=0; i<libArr.length; i++){
            const lib = libArr[i]
            if(isLibraryCompatible(lib.rules, lib.natives)){

                // Pre-1.19 has a natives object.
                if(lib.natives != null) {
                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    const artifact = lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        // Extract the file.
                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, fileName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // 1.19+ logic
                else if(lib.name.includes('natives-')) {

                    const regexTest = nativesRegex.exec(lib.name)
                    // const os = regexTest[1]
                    const arch = regexTest[2] ?? 'x64'

                    if(arch != process.arch) {
                        continue
                    }

                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
                    const artifact = lib.downloads.artifact

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        if(zipEntries[i].isDirectory) {
                            continue
                        }

                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        const extractName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/')) : fileName

                        // Extract the file.
                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, extractName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // No natives
                else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }
            }
        }

        return libs
    }

    /**
     * Resolve the libraries declared by this server in order to add them to the classpath.
     * This method will also check each enabled mod for libraries, as mods are permitted to
     * declare libraries.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
     */
    _resolveServerLibraries(mods){
        const mdls = this.server.modules
        let libs = {}

        // Locate Forge/Fabric/Libraries
        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeHosted || type === Type.Fabric || type === Type.Library){
                const p = mdl.getPath()
                const isInstaller = typeof p === 'string' && p.endsWith('-installer.jar')
                const isModernForge = (type === Type.ForgeHosted && mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion))
                if(!isModernForge && !isInstaller){
                    libs[mdl.getVersionlessMavenIdentifier()] = p
                }
                if(mdl.subModules.length > 0){
                    const res = this._resolveModuleLibraries(mdl)
                    libs = {...libs, ...res}
                }
            }
        }

        //Check for any libraries in our mod list.
        for(let i=0; i<mods.length; i++){
            if(mods.sub_modules != null){
                const res = this._resolveModuleLibraries(mods[i])
                libs = {...libs, ...res}
            }
        }

        return libs
    }

    /**
     * Recursively resolve the path of each library required by this module.
     * 
     * @param {Object} mdl A module object from the server distro index.
     * @returns {{[id: string]: string}} An object containing the paths of each library this module requires.
     */
    _resolveModuleLibraries(mdl){
        if(mdl.subModules.length === 0){
            return {}
        }
        let libs = {}
        for(let sm of mdl.subModules){
            if(sm.rawModule.type === Type.Library){
                const p = sm.getPath()
                const isInstaller = typeof p === 'string' && p.endsWith('-installer.jar')
                if((sm.rawModule.classpath ?? true) && !isInstaller) {
                    libs[sm.getVersionlessMavenIdentifier()] = p
                }
            }
            // If this module has submodules, we need to resolve the libraries for those.
            // To avoid unnecessary recursive calls, base case is checked here.
            if(mdl.subModules.length > 0){
                const res = this._resolveModuleLibraries(sm)
                libs = {...libs, ...res}
            }
        }
        return libs
    }

}

module.exports = ProcessBuilder