/**
 * RXCORP Launcher - Modrinth Integration Service
 * Browse, search and install mods from Modrinth (https://modrinth.com)
 */

const fs = require('fs');
const path = require('path');

class ModrinthService {
    constructor() {
        this.baseUrl = 'https://api.modrinth.com/v2';
    }

    _getHeaders() {
        return {
            'User-Agent': 'RXCORP-Launcher/2.0 (contact@rxcorp.me)',
            'Accept': 'application/json'
        };
    }

    /**
     * Search mods on Modrinth
     */
    async searchMods({ query = '', version = null, loader = null, category = null, limit = 20, index = 'relevance' }) {
        try {
            const facets = [['project_type:mod']];

            if (version) {
                facets.push([`versions:${version}`]);
            }
            if (loader && loader !== 'vanilla') {
                facets.push([`categories:${loader.toLowerCase()}`]);
            }
            if (category) {
                facets.push([`categories:${category.toLowerCase()}`]);
            }

            const params = new URLSearchParams({
                query: query.trim(),
                limit: limit.toString(),
                index: index, // relevance, downloads, follows, updated, newest
                facets: JSON.stringify(facets)
            });

            const res = await fetch(`${this.baseUrl}/search?${params.toString()}`, {
                headers: this._getHeaders()
            });

            if (!res.ok) {
                throw new Error(`Erreur recherche Modrinth (${res.status})`);
            }

            const data = await res.json();
            return {
                success: true,
                totalHits: data.total_hits,
                mods: (data.hits || []).map(hit => ({
                    id: hit.project_id,
                    slug: hit.slug,
                    title: hit.title,
                    description: hit.description,
                    iconUrl: hit.icon_url,
                    author: hit.author,
                    downloads: hit.downloads,
                    follows: hit.follows,
                    categories: hit.categories,
                    versions: hit.versions
                }))
            };
        } catch (err) {
            console.error('[Modrinth Search Error]:', err);
            return { success: false, error: err.message, mods: [] };
        }
    }

    /**
     * Get compatible versions of a mod for specific MC version and loader
     */
    async getCompatibleVersions(projectSlugOrId, mcVersion = null, loader = null) {
        try {
            const params = new URLSearchParams();
            if (mcVersion) params.append('game_versions', JSON.stringify([mcVersion]));
            if (loader && loader !== 'vanilla') params.append('loaders', JSON.stringify([loader.toLowerCase()]));

            const url = `${this.baseUrl}/project/${projectSlugOrId}/version?${params.toString()}`;
            const res = await fetch(url, { headers: this._getHeaders() });

            if (!res.ok) {
                throw new Error(`Erreur récupération versions (${res.status})`);
            }

            const versions = await res.json();
            return {
                success: true,
                versions: versions.map(v => {
                    const primaryFile = v.files.find(f => f.primary) || v.files[0];
                    return {
                        id: v.id,
                        name: v.name,
                        versionNumber: v.version_number,
                        gameVersions: v.game_versions,
                        loaders: v.loaders,
                        downloadUrl: primaryFile ? primaryFile.url : null,
                        fileName: primaryFile ? primaryFile.filename : null,
                        size: primaryFile ? primaryFile.size : 0
                    };
                })
            };
        } catch (err) {
            return { success: false, error: err.message, versions: [] };
        }
    }

    /**
     * Download and install mod file to target instance mods folder
     */
    async installMod(instanceModsPath, fileUrl, fileName, onProgress) {
        if (!fs.existsSync(instanceModsPath)) {
            fs.mkdirSync(instanceModsPath, { recursive: true });
        }

        const targetPath = path.join(instanceModsPath, fileName);
        const res = await fetch(fileUrl);

        if (!res.ok) {
            throw new Error(`Impossible de télécharger le fichier (${res.status})`);
        }

        const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
        const fileStream = fs.createWriteStream(targetPath);

        return new Promise((resolve, reject) => {
            const reader = res.body.getReader();
            let downloadedBytes = 0;

            function pump() {
                reader.read().then(({ done, value }) => {
                    if (done) {
                        fileStream.end();
                        resolve({ success: true, path: targetPath });
                        return;
                    }

                    fileStream.write(Buffer.from(value));
                    downloadedBytes += value.length;

                    if (onProgress && totalBytes > 0) {
                        onProgress(downloadedBytes, totalBytes);
                    }

                    pump();
                }).catch(err => {
                    fileStream.close();
                    reject(err);
                });
            }

            fileStream.on('error', err => reject(err));
            pump();
        });
    }
}

module.exports = new ModrinthService();
