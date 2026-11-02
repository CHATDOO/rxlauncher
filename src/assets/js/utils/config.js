/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const path = require('path');
let pkg;
try {
    pkg = require('../../../../package.json');
} catch {
    try {
        pkg = require('../package.json');
    } catch {
        pkg = require(path.resolve('./package.json'));
    }
}
const nodeFetch = require("node-fetch");
const convert = require('xml-js');
let url = pkg.user ? `${pkg.url}/${pkg.user}` : pkg.url

let config = `${url}/config`;
let articles = `${url}/articles`;

const defaultDeltaZoneConfig = {
    maintenance: false,
    maintenance_message: "L'infrastructure RXCORP est actuellement en maintenance.",
    dataDirectory: "RXCORP",
    online: true,
    client_id: "00000000402b5328",
    socialLinks: [
        { name: "Site Web", url: "https://rxcorp.me" },
        { name: "Panel", url: "https://panel.rxcorp.me" }
    ]
};

const defaultDeltaZoneInstances = [
    {
        name: "RXCORP Cloud Server",
        url: null,
        loader: {
            minecraft_version: "1.21.4",
            loader_type: "forge",
            loader_version: "latest",
            mcp_file: null
        },
        verify: false,
        ignored: [],
        whitelist: [],
        whitelistActive: false,
        status: {
            nameServer: "RXCORP",
            ip: "panel.rxcorp.me",
            port: null
        }
    }
];

const defaultDeltaZoneNews = [
    {
        title: "RXCORP LAUNCHER 2.5",
        content: "Bienvenue sur le nouveau launcher RXCORP inspiré du design Behance. Profitez de la synchronisation automatique de vos serveurs Pelican Cloud et de vos profils locaux.",
        author: "Équipe RXCORP",
        publish_date: new Date().toISOString()
    }
];

class Config {
    GetConfig() {
        return new Promise((resolve) => {
            nodeFetch(config, { timeout: 4000 }).then(async res => {
                if (res.status === 200) {
                    let json = await res.json();
                    json.dataDirectory = "RXCORP";
                    return resolve(json);
                }
                return resolve(defaultDeltaZoneConfig);
            }).catch(() => {
                return resolve(defaultDeltaZoneConfig);
            });
        });
    }

    async getInstanceList() {
        let urlInstance = `${url}/instances`;
        try {
            let instances = await nodeFetch(urlInstance, { timeout: 3000 }).then(res => res.json()).catch(() => null);
            let instancesList = [];
            if (instances && Object.keys(instances).length > 0) {
                for (let [name, data] of Object.entries(instances)) {
                    instancesList.push(data);
                }
            }
            let hasRxcorp = instancesList.some(i => i.name && i.name.toLowerCase().includes('rxcorp'));
            if (!hasRxcorp) {
                instancesList.unshift(defaultDeltaZoneInstances[0]);
            }
            return instancesList;
        } catch {
            return defaultDeltaZoneInstances;
        }
    }

    async getNews(config) {
        if (config && config.rss) {
            return new Promise((resolve) => {
                nodeFetch(config.rss, { timeout: 4000 }).then(async res => {
                    if (res.status === 200) {
                        let news = [];
                        let response = await res.text();
                        response = (JSON.parse(convert.xml2json(response, { compact: true })))?.rss?.channel?.item;

                        if (!Array.isArray(response)) response = [response];
                        for (let item of response) {
                            news.push({
                                title: item.title._text,
                                content: item['content:encoded']._text,
                                author: item['dc:creator']._text,
                                publish_date: item.pubDate._text
                            });
                        }
                        return resolve(news);
                    }
                    return resolve(defaultDeltaZoneNews);
                }).catch(() => resolve(defaultDeltaZoneNews));
            });
        } else {
            return new Promise((resolve) => {
                nodeFetch(articles, { timeout: 4000 }).then(async res => {
                    if (res.status === 200) return resolve(res.json());
                    return resolve(defaultDeltaZoneNews);
                }).catch(() => resolve(defaultDeltaZoneNews));
            });
        }
    }
}

export default new Config;