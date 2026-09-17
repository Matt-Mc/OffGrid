'use strict';
const hosts = new Set(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be']);
try {
  const raw = new URL(location.href).searchParams.get('url');
  if(!raw || raw.length > 4096 || /[\u0000-\u0020\\]/.test(raw)) throw new Error();
  const url = new URL(raw);
  if(!['http:','https:'].includes(url.protocol) || !hosts.has(url.hostname) || url.username || url.password || url.port) throw new Error();
  const parts=url.pathname.split('/').filter(Boolean);
  const video=url.hostname.endsWith('youtu.be') && parts.length===1 ? parts[0] : url.pathname==='/watch' ? url.searchParams.get('v') : parts.length===2 && ['shorts','live','embed'].includes(parts[0]) ? parts[1] : null;
  const playlist=url.searchParams.get('list');
  if(url.searchParams.getAll('v').length>1 || url.searchParams.getAll('list').length>1 || video && !/^[\w-]{1,128}$/.test(video) || playlist && !/^[\w-]{1,128}$/.test(playlist) || !video && !(url.pathname==='/playlist' && playlist)) throw new Error();
  const canonical=video ? `https://www.youtube.com/watch?v=${video}${playlist ? `&list=${playlist}` : ''}` : `https://www.youtube.com/playlist?list=${playlist}`;
  document.querySelector('#url').textContent=canonical;
  const link=document.querySelector('#open');link.href='offgrid://add?url='+encodeURIComponent(canonical);link.hidden=false;
  document.querySelector('#message').textContent='Open this link in Offgrid to choose your download options.';
} catch {
  document.querySelector('#message').textContent='Choose a YouTube video or playlist, then send it to Offgrid again.';
}
