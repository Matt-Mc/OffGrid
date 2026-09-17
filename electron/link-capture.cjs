'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteJson } = require('./backend-core.cjs');
const { parseYouTubeUrl } = require('./youtube-links.cjs');
const MAX_CAPTURES = 20;
function canonicalCaptureUrl(value) {
  if(typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) throw new Error('This YouTube link is invalid.');
  const parsed = parseYouTubeUrl(value);
  return parsed.videoUrl && parsed.playlistId ? `${parsed.videoUrl}&list=${parsed.playlistId}` : parsed.url;
}
function parseCaptureUri(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u0020\\]/.test(value) || /%(?![a-f\d]{2})/i.test(value)) throw new Error('This Offgrid link is invalid.');
  let uri;
  try {uri = new URL(value);} catch {throw new Error('This Offgrid link is invalid.');}
  if (uri.protocol !== 'offgrid:' || uri.hostname !== 'add' || !['','/'].includes(uri.pathname) || uri.username || uri.password || uri.port || uri.hash || uri.searchParams.getAll('url').length !== 1 || [...uri.searchParams.keys()].some(key => key !== 'url')) throw new Error('This Offgrid link is not supported.');
  return canonicalCaptureUrl(uri.searchParams.get('url'));
}
function createCaptureStore({file,onChange = () => {}}) {
  let items = [];
  let warning = null;
  try {
    const stored = JSON.parse(fs.readFileSync(file,'utf8'));
    if(stored?.version !== 1 || !Array.isArray(stored.items)) throw new Error('Invalid capture file');
    const seen = new Set();
    for(const item of stored.items) {
      try {
        if(typeof item?.id !== 'string' || !/^[a-f\d-]{36}$/i.test(item.id) || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('Invalid saved link');
        const url = canonicalCaptureUrl(item.url);
        if(seen.has(url) || items.some(existing => existing.id === item.id)) continue;
        if(items.length >= MAX_CAPTURES) {warning = 'Only the first 20 pending links could be restored.';break;}
        items.push({id:item.id,url,createdAt:new Date(item.createdAt).toISOString()});seen.add(url);
      }catch{warning='Some saved links could not be restored. Send those links to Offgrid again.';}
    }
  }catch(error){if(error.code !== 'ENOENT') warning='Pending links could not be restored. Send your links to Offgrid again.';}
  const list = () => ({items:items.map(item=>({...item})),warning});
  function persist(next) {atomicWriteJson(file,{version:1,items:next});items=next;}
  function publish(){const snapshot=list();onChange(snapshot);return snapshot;}
  return {
    list,
    receive(uri) {
      const url = parseCaptureUri(uri);
      if(items.some(item=>item.url===url)) return list();
      if(items.length >= MAX_CAPTURES){warning='20 links are waiting. Open or dismiss a pending link, then send this one again.';return publish();}
      persist([...items,{id:crypto.randomUUID(),url,createdAt:new Date().toISOString()}]);
      warning=null;return publish();
    },
    acknowledge(id) {
      if(typeof id !== 'string') throw new Error('Choose a pending link.');
      const next=items.filter(item=>item.id!==id);
      if(next.length !== items.length) {persist(next);warning=null;}
      return publish();
    },
  };
}
module.exports = {createCaptureStore,parseCaptureUri,MAX_CAPTURES};
