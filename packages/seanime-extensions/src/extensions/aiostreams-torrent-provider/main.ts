import {
  AIOStreamsAPI,
  parseManifestUrl,
  ParsedId,
  SearchApiResponse,
} from '../../lib/aiostreams';
import {
  buildSearchId,
  createParsedIdFromSmartSearch,
  formatIdForSearch,
  PreferredSearchId,
} from '../../lib/provider/anime-id';
import {
  toAnimeTorrent,
  ResultFormat,
} from '../../lib/provider/torrent-mapper';
import {
  unwrapSeanimeMediaId,
  tryDecodeStremioLocalId,
} from '../../lib/stremio-id';

class Provider {
  // aiostreamsBaseUrl = "{{baseUrl}}";
  // aiostreamsUuid = "{{uuid}}";
  // aiostreamsPassword = "{{password}}";
  aiostreamsManifestUrl = '{{manifestUrl}}';

  searchId = '{{searchId}}';
  resultFormat = '{{resultFormat}}';

  getSettings(): AnimeProviderSettings {
    return {
      canSmartSearch: true,
      smartSearchFilters: ['episodeNumber'],
      supportsAdult: true,
      type: 'special',
    };
  }

  async search(_opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
    return [];
  }

  async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
    const { baseUrl, uuid, encryptedPassword } = parseManifestUrl(
      this.aiostreamsManifestUrl
    );
    const aiostreams = new AIOStreamsAPI(baseUrl, uuid, encryptedPassword);
    const type = opts.media.format === 'TV' ? 'series' : 'movie';

    let id: ParsedId | null = null;

    const localId = unwrapSeanimeMediaId(opts.media.id);
    const decoded = tryDecodeStremioLocalId(localId);
    if (decoded) {
      id = {
        type: 'stremioId',
        value: decoded.stremioId,
        episode: decoded.metaType !== 'movie' ? opts.episodeNumber : undefined,
      };
    }

    if (!id) {
      id = createParsedIdFromSmartSearch(opts);
    }

    if (!id) {
      console.warn('No valid media ID for smart search', opts);
      return [];
    }

    const resultFormat = $getUserPreference('resultFormat') as ResultFormat;
    const seen = new Set<string>();
    const collected: AnimeTorrent[] = [];
    const collect = (response: SearchApiResponse | null) => {
      for (const item of response?.results ?? []) {
        const torrent = toAnimeTorrent(item, resultFormat);
        // Keep p2p/torrent results (infoHash) AND pre-resolved direct streams (streamUrl).
        if (!torrent.infoHash && !torrent.streamUrl) continue;
        const key = torrent.infoHash || torrent.streamUrl || torrent.name;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(torrent);
      }
    };

    if (id.type === 'stremioId') {
      collect(
        await aiostreams.search(
          type,
          formatIdForSearch(id),
          id.season,
          id.episode
        )
      );
      return collected;
    }

    // searchId may be a comma-joined list (e.g. "kitsuId,imdbId"). Resolve the title once,
    // then query AIOStreams once per id type. kitsu/anilist ids hit the anime scrapers
    // (Nyaa/AnimeTosho/SeaDex); imdb hits the generic ones. Fire them in parallel and merge.
    const animeEntry = await aiostreams.anime(id.type, id.value);
    const prefs = ((($getUserPreference('searchId') as string) || 'imdbId')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as PreferredSearchId[]);
    if (prefs.length === 0) prefs.push('imdbId');

    const responses = await Promise.all(
      prefs.flatMap((pref) => {
        const sid = buildSearchId(id, animeEntry, pref);
        if (!sid) return [];
        let season = sid.season;
        let episode = sid.episode;
        if (type === 'movie') {
          season = undefined;
          episode = undefined;
        }
        // Swallow per-id failures so one bad strategy can't sink the others.
        return [
          aiostreams
            .search(type, formatIdForSearch(sid), season, episode)
            .then(
              (r) => r,
              () => null
            ),
        ];
      })
    );

    for (const response of responses) collect(response);
    return collected;
  }

  async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
    return torrent.infoHash || '';
  }

  async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
    return torrent.magnetLink || '';
  }

  async getLatest(): Promise<AnimeTorrent[]> {
    return [];
  }
}

(globalThis as { Provider?: typeof Provider }).Provider = Provider;
