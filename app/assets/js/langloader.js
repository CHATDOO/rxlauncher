const fs = require('fs-extra')
const path = require('path')
const toml = require('toml')
const merge = require('lodash.merge')

let lang

exports.loadLanguage = function(id){
    lang = merge(lang || {}, toml.parse(fs.readFileSync(path.join(__dirname, '..', 'lang', `${id}.toml`))) || {})
}

exports.query = function(id, placeHolders){
    let query = id.split('.')
    let res = lang
    for(let q of query){
        res = res[q]
    }
    let text = res === lang ? '' : res
    if (placeHolders) {
        Object.entries(placeHolders).forEach(([key, value]) => {
            text = text.replace(`{${key}}`, value)
        })
    }
    return text
}

exports.queryJS = function(id, placeHolders){
    return exports.query(`js.${id}`, placeHolders)
}

exports.queryEJS = function(id, placeHolders){
    return exports.query(`ejs.${id}`, placeHolders)
}

/**
 * System language (Windows display language). French if it starts with "fr",
 * English otherwise. Works in both main and renderer processes.
 */
exports.getSystemLanguage = function(){
    let loc = ''
    try {
        if (process.type === 'browser') {
            const { app } = require('electron')
            loc = (app.isReady() && app.getLocale()) || (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || ''
        } else if (typeof navigator !== 'undefined') {
            loc = navigator.language || ''
        }
    } catch (e) { /* ignore */ }
    if (!loc) {
        try { loc = Intl.DateTimeFormat().resolvedOptions().locale || '' } catch (e) { /* ignore */ }
    }
    return loc.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

exports.setupLanguage = function(){
    lang = undefined // reset so a reload after app 'ready' can switch language cleanly
    const sys = exports.getSystemLanguage()

    // English base = fallback for any missing key
    exports.loadLanguage('en_US')
    if (sys === 'fr') exports.loadLanguage('fr_FR')

    // RXCORP customizations: shared links, then texts in the system language
    exports.loadLanguage('_custom')
    exports.loadLanguage(`_custom_${sys}`)
}