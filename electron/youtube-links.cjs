'use strict';

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function parseYouTubeUrl(value, mode = 'video') {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\\]/.test(value.trim())) throw new Error('Enter a valid YouTube video or playlist link.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid YouTube video or playlist link.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new Error('Only YouTube video and playlist links are supported.');
  if (url.searchParams.getAll('v').length > 1 || url.searchParams.getAll('list').length > 1) throw new Error('This link has conflicting video or playlist details.');
  const parts = url.pathname.split('/').filter(Boolean);
  let sourceId = null;
  if (url.hostname.endsWith('youtu.be') && parts.length === 1) sourceId = parts[0];
  else if (url.pathname === '/watch') sourceId = url.searchParams.get('v');
  else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) sourceId = parts[1];
  const playlistId = url.searchParams.get('list');
  if (sourceId && !ID.test(sourceId) || playlistId && !ID.test(playlistId)) throw new Error('This YouTube link has an invalid identifier.');
  if (!sourceId && !(url.pathname === '/playlist' && playlistId)) throw new Error('Choose a YouTube video or playlist link.');
  const videoUrl = sourceId ? `https://www.youtube.com/watch?v=${sourceId}` : null;
  const playlistUrl = playlistId ? `https://www.youtube.com/playlist?list=${playlistId}` : null;
  const type = playlistUrl && (mode === 'playlist' || !videoUrl) ? 'playlist' : 'video';
  return { sourceId, playlistId, videoUrl, playlistUrl, type, url: type === 'playlist' ? playlistUrl : videoUrl };
}

function parseLinkInput(input) {
  if (typeof input !== 'string' || input.length > 500 * 4097) throw new Error('Add at most 500 links at a time.');
  const links = input.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!links.length || links.length > 500) throw new Error('Add between 1 and 500 links.');
  return links;
}

module.exports = { parseYouTubeUrl, parseLinkInput };
