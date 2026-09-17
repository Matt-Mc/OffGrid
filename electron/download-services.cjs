'use strict';
const { randomUUID } = require('node:crypto');
const { parseYouTubeUrl, parseLinkInput } = require('./youtube-links.cjs');
const { readPlaylist, mapBounded } = require('./youtube-playlists.cjs');
const { batchResult, validateBatch } = require('./batch-downloads.cjs');
const { getExpectedSize } = require('./backend-core.cjs');

function subtitleOptions(args = {}, settings = {}) {
  const languages = args.subtitleLanguages ?? (settings.defaultSubtitleLanguage ? [settings.defaultSubtitleLanguage] : []);
  const allowAutoCaptions = args.allowAutoCaptions ?? settings.allowAutoCaptions ?? false;
  if (!Array.isArray(languages) || languages.length > 2 || languages.some(value => typeof value !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value)) || typeof allowAutoCaptions !== 'boolean') throw new Error('Choose up to two valid subtitle languages.');
  return { subtitleLanguages: [...new Set(languages)], allowAutoCaptions };
}
function youtubeTracks(metadata) {
  const tracks = [];
  for (const [key, origin] of [['subtitles', 'manual'], ['automatic_captions', 'auto']]) {
    for (const [language, formats] of Object.entries(metadata?.[key] || {})) {
      if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language) || !Array.isArray(formats)) continue;
      if (formats.some(format => ['vtt', 'srt'].includes(format.ext))) tracks.push({ language, origin, format: 'vtt' });
      if (tracks.length >= 500) return tracks;
    }
  }
  return tracks;
}

function createDownloadServices({ settings, library, queue, servers, metadata, ytCommand, spawnProcess, isOnline, clearDeleted }) {
  const previews = new Map(), estimates=new Map();
  function recordEstimate(url,selectedQuality,info) {
    const parsed=parseYouTubeUrl(url);
    if(info?.id && parsed.sourceId!==info.id) return;
    const key=`${parsed.sourceId}:${selectedQuality}`;
    estimates.delete(key);estimates.set(key,{title:String(info.title || 'YouTube video').slice(0,500),expectedBytes:getExpectedSize(info),at:Date.now()});
    if(estimates.size>1000) estimates.delete(estimates.keys().next().value);
  }
  function quality(value) {
    const result = value ?? settings().defaultQuality;
    if (!['480p', '720p', '1080p', 'best'].includes(result)) throw new Error('Invalid download quality.');
    return result;
  }
  function outcome(sourceId) {
    const saved = library().find(video => video.sourceId === sourceId);
    if (saved) return { outcome: 'alreadySaved', videoId: saved.id };
    const pending = queue().jobs.find(job => job.kind !== 'assets' && job.sourceId === sourceId && !['complete', 'error', 'canceled'].includes(job.status));
    return pending ? { outcome: 'alreadyQueued', id: pending.id } : {};
  }
  function youtubeData(args, source = 'manual', extra = {}) {
    const parsed = parseYouTubeUrl(args?.url);
    if (!parsed.videoUrl) throw new Error('Preview the playlist and select videos first.');
    const selectedQuality=quality(args.quality),estimate=estimates.get(`${parsed.sourceId}:${selectedQuality}`);
    return { url: parsed.videoUrl, quality: selectedQuality, ...subtitleOptions(args, settings()), saveComments: settings().saveComments,
      source, sourceId: parsed.sourceId, title: 'YouTube video', ...(estimate && Date.now()-estimate.at<15*60_000 ? {title:estimate.title,expectedBytes:estimate.expectedBytes} : {}), ...extra };
  }
  function enqueueYoutube(args, source = 'manual', extra = {}) {
    const data = youtubeData(args, source, extra);
    const existing = outcome(data.sourceId);
    if (existing.outcome) return { accepted: false, alreadySaved: existing.outcome === 'alreadySaved', ...existing };
    const result = queue().addMany([data])[0];
    if (source === 'manual' && result.outcome === 'added') clearDeleted([data.sourceId]);
    return { accepted: result.outcome === 'added', ...result };
  }
  function addDownloadBatch(args = {}) {
    validateBatch(args.urls);
    const selectedQuality = quality(args.quality), options = subtitleOptions(args, settings());
    const results = [], data = [], indexes = [];
    for (const url of args.urls) {
      const index = results.length;
      try {
        const item = youtubeData({ url, quality: selectedQuality, ...options });
        const existing = outcome(item.sourceId);
        results.push({ title: item.title, url: item.url, ...existing });
        if (!existing.outcome) { data.push(item); indexes.push(index); }
      } catch (error) { results.push({ outcome: 'rejected', reason: error.message, title: String(url).slice(0, 500) }); }
    }
    if (data.length) {
      const accepted = queue().addMany(data);
      accepted.forEach((result, index) => Object.assign(results[indexes[index]], { outcome: result.outcome, id: result.id }));
      clearDeleted(data.filter((_, index) => accepted[index].outcome === 'added').map(item => item.sourceId));
    }
    return batchResult(results);
  }
  function cancelPreview(requestId) { previews.get(requestId)?.abort(); previews.delete(requestId); }
  async function previewDownloads(args = {}) {
    if (typeof args.requestId !== 'string' || !/^[\w-]{1,100}$/.test(args.requestId)) throw new Error('Invalid preview request.');
    if (!['video', 'playlist', undefined].includes(args.mode)) throw new Error('Invalid preview mode.');
    cancelPreview(args.requestId);
    if (previews.size >= 4) throw new Error('Another preview is still loading. Try again shortly.');
    const selectedQuality = quality(args.quality);
    const controller = new AbortController(); previews.set(args.requestId, controller);
    try {
      if (!isOnline()) throw new Error('Connect to load video details. Your links can stay here until then.');
      const links = parseLinkInput(args.input);
      const command = await ytCommand();
      let result;
      if (links.length === 1 && parseYouTubeUrl(links[0], args.mode).type === 'playlist') {
        result = await readPlaylist(command, links[0], { start: args.start ?? 0, signal: controller.signal, spawnProcess });
      } else {
        const start = args.start ?? 0;
        if (!Number.isSafeInteger(start) || start < 0 || start >= links.length) throw new Error('Invalid preview page.');
        const items = links.slice(start, start + 100).map((url, index) => {
          try {
            const parsed = parseYouTubeUrl(url);
            if (!parsed.videoUrl) throw new Error('Preview playlist links separately.');
            return { id: parsed.sourceId, url: parsed.videoUrl, title: parsed.videoUrl, available: true };
          } catch (error) { return { id: `invalid-${start + index}`, url: null, title: url.slice(0, 500), available: false, reason: error.message }; }
        });
        result = { items, start, nextStart:start+items.length, total: links.length, complete: start + items.length >= links.length, hasMore: start + items.length < links.length, warning: null };
      }
      result.items = await mapBounded(result.items, async item => {
        if (!item.available) return item;
        const existing = outcome(item.id);
        try {
          const info = await metadata(item.url, selectedQuality, command, { signal: controller.signal });
          recordEstimate(item.url,selectedQuality,info);
          return { ...item, title: String(info.title || item.title).slice(0, 500), duration: info.duration || 0, expectedBytes: getExpectedSize(info), subtitleTracks: youtubeTracks(info), ...existing };
        } catch (error) {
          if (controller.signal.aborted) throw error;
          return { ...item, expectedBytes: null, estimateWarning: 'Details unavailable; size is unknown.', ...existing };
        }
      }, { signal: controller.signal });
      if (controller.signal.aborted) throw new Error('Preview canceled.');
      return { ...result, requestId: args.requestId };
    } finally { if (previews.get(args.requestId) === controller) previews.delete(args.requestId); }
  }
  function serverContext(provider) {
    const server = servers[provider];
    if (!server || server.busy) throw new Error('Wait for the server connection to finish.');
    const revision = server.revision, connection = server.connection.status(), client = server.connection.client();
    const assert = () => {
      const current = server.connection.status();
      if (server.busy || server.revision !== revision || current.serverId !== connection.serverId || current.baseUrl !== connection.baseUrl) throw new Error('The server connection changed. Select the videos again.');
    };
    return { server, connection, client, assert };
  }
  async function downloadServerBatch(provider, args = {}) {
    validateBatch(args.ids);
    const context = serverContext(provider), options = subtitleOptions(args, settings());
    const copyQuality = args.copyQuality ?? 'original';
    if (!['original', '720p'].includes(copyQuality)) throw new Error('Choose Original or a smaller 720p copy.');
    const prepared = await mapBounded(args.ids, async id => {
      try {
        const info = await context.client.metadata(id); context.assert();
        const sourceId = `${provider}:${context.connection.serverId}:${info.id}`;
        return { info, sourceId, ...outcome(sourceId) };
      } catch (error) { return { outcome: 'rejected', title: String(id).slice(0, 100), reason: error.message }; }
    });
    context.assert();
    const data = [], indexes = [];
    const results = prepared.map((item, index) => {
      if (item.outcome) return { outcome: item.outcome, title: item.info?.title || item.title, reason: item.reason, id: item.id, videoId: item.videoId };
      data.push({ provider, source: 'manual', sourceId: item.sourceId, serverId: context.connection.serverId, ratingKey: item.info.id,
        url: `${provider}://${encodeURIComponent(context.connection.serverId)}/${item.info.id}`, quality: 'original', copyQuality, ...options,
        title: item.info.title, expectedBytes: item.info.sizeBytes });
      indexes.push(index); return { title: item.info.title };
    });
    if (data.length) queue().addMany(data).forEach((item, index) => Object.assign(results[indexes[index]], { outcome: item.outcome, id: item.id }));
    return batchResult(results);
  }
  async function previewServerSeason(provider,id,requestId=`server-${randomUUID()}`) {
    if(typeof requestId!=='string' || !/^[\w-]{1,100}$/.test(requestId)) throw new Error('Invalid preview request.');
    cancelPreview(requestId);
    if(previews.size>=4) throw new Error('Another preview is still loading. Try again shortly.');
    const controller=new AbortController();previews.set(requestId,controller);
    try {return await enumerateServerSeason(provider,id,controller.signal);}
    finally {if(previews.get(requestId)===controller) previews.delete(requestId);}
  }
  async function enumerateServerSeason(provider, id, signal) {
    const context = serverContext(provider), items = [], seen = new Set(); let start = 0, total, complete = false, warning = null;
    while (items.length < 500) {
      if(signal.aborted) throw new Error('Preview canceled.');
      const page = await context.client.browse({ parentId: id, start, signal }); context.assert();
      if(signal.aborted) throw new Error('Preview canceled.');
      if (total !== undefined && total !== page.total) { warning = 'This season changed while loading. Review the available episodes or load it again.'; break; }
      total = page.total;
      if (!page.items.length) { complete = start >= total; if (!complete) warning = 'Some episodes could not be loaded.'; break; }
      let fresh = 0;
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id); fresh++;
        if (item.type !== 'episode') continue;
        const sourceId = `${provider}:${context.connection.serverId}:${item.id}`;
        items.push({ ...item, available: item.downloadable, expectedBytes: item.sizeBytes,
          reason: item.downloadable ? null : 'Original file unavailable or download permission is missing.', ...outcome(sourceId) });
        if (items.length >= 500) break;
      }
      if (!fresh) { warning = 'The server repeated a page. Reload this season to continue.'; break; }
      start += page.items.length;
      if (start >= total) { complete = true; break; }
      if (start > 10_000) { warning = 'This season could not be fully enumerated.'; break; }
    }
    items.sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0) || a.id.localeCompare(b.id));
    return { items, start: 0, total: total ?? items.length, complete, hasMore: !complete, warning: warning || (!complete ? 'Showing up to 500 episodes. Add additional episodes from the server browser.' : null) };
  }
  function dispose() { for (const controller of previews.values()) controller.abort(); previews.clear(); }
  return { recordEstimate, enqueueYoutube, addDownloadBatch, previewDownloads, cancelPreview, previewServerSeason, downloadServerBatch, serverContext, dispose };
}
module.exports = { createDownloadServices, subtitleOptions, youtubeTracks };
