import { useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorMessage, Icon, formatBytes, formatDuration } from './shared';

function connectionError(error) {
  // Electron prepends IPC implementation details to rejected invoke messages.
  return String(error?.message || 'Server connection failed. Please retry.')
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^(?:PlexError|JellyfinError|Error):\s*/, '');
}

const providers = {
  plex: { name: 'Plex', config: 'getPlexConfig', connect: 'connectPlex', disconnect: 'disconnectPlex', sections: 'plexSections', browse: 'browsePlex', download: 'downloadPlex', localAccess: 'requestPlexLocalAccess', placeholder: 'http://192.168.1.20:32400' },
  jellyfin: { name: 'Jellyfin', config: 'getJellyfinConfig', connect: 'connectJellyfin', disconnect: 'disconnectJellyfin', sections: 'jellyfinSections', browse: 'browseJellyfin', download: 'downloadJellyfin', localAccess: 'requestJellyfinLocalAccess', placeholder: 'http://192.168.1.20:8096' }
};

export function Servers({ onDownloads, provider = 'plex', onProviderChange }) {
  const providerControls = <div className="server-provider-switch" role="group" aria-label="Server type">
      {Object.entries(providers).map(([id, service]) => <button type="button" key={id} aria-pressed={provider === id} onClick={() => onProviderChange(id)}>{service.name}</button>)}
    </div>;
  return <section className="screen" aria-label={providers[provider].name}>
    <ServerBrowser key={provider} provider={provider} onDownloads={onDownloads} providerControls={providerControls} />
  </section>;
}

function ServerBrowser({ provider, onDownloads, providerControls }) {
  const service = providers[provider];
  const isJellyfin = provider === 'jellyfin';
  const [config, setConfig] = useState(null);
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sections, setSections] = useState([]);
  const [sectionId, setSectionId] = useState('');
  const [trail, setTrail] = useState([]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [start, setStart] = useState(0);
  const [page, setPage] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [localAccess, setLocalAccess] = useState({ status: 'idle', url: '', message: '' });
  const [settingsError, setSettingsError] = useState('');
  const accessGeneration = useRef(0);
  const generation = useRef(0);
  const parentId = trail.at(-1)?.id;
  const api = window.offgrid;
  const isMac = config?.platform === 'darwin';
  const accessStatus = localAccess.url === baseUrl.trim() ? localAccess.status : 'idle';

  useEffect(() => {
    accessGeneration.current++;
    setSettingsError('');
    setLocalAccess(current => current.status === 'checking' ? { status: 'idle', url: '', message: '' } : current);
    return () => { accessGeneration.current++; };
  }, [baseUrl, editing]);

  function changeServerAddress(value) {
    accessGeneration.current++;
    setLocalAccess({ status: 'idle', url: '', message: '' });
    setBaseUrl(value);
  }

  function recordReachable(url) {
    accessGeneration.current++;
    setLocalAccess({ status: 'reachable', url: url.trim(), message: 'Your server is reachable on this network.' });
  }
  function recordConnectionError(error, url) {
    const message = connectionError(error);
    setError(message);
    if (/network|could not connect|could not reach|could not find|timed out|unreachable|refused|interrupted|secure connection|not responding/i.test(message)) {
      accessGeneration.current++;
      setLocalAccess({ status: 'blocked-or-unreachable', url: url.trim(), message: 'Your server could not be reached. Check that it is running and this device is on the same network.' });
    }
  }

  async function requestLocalAccess() {
    const url = baseUrl.trim();
    const current = ++accessGeneration.current;
    setSettingsError('');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Invalid address');
    } catch {
      setLocalAccess({ status: 'invalid', url, message: 'Enter your server address first, including http:// or https://.' });
      return;
    }
    setLocalAccess({ status: 'checking', url, message: isMac ? 'Checking access. Choose Allow if macOS asks to find devices on your local network.' : 'Checking your server connection…' });
    try {
      const result = await api[service.localAccess](url);
      if (current !== accessGeneration.current) return;
      setLocalAccess({ ...result, url });
      if (result.status === 'reachable' && config?.configured && !editing) setReload(value => value + 1);
    } catch (error) {
      if (current === accessGeneration.current) setLocalAccess({ status: 'unreachable', url, message: connectionError(error) });
    }
  }

  async function openNetworkSettings() {
    const current = accessGeneration.current;
    setSettingsError('');
    try { await api.openLocalNetworkSettings(); }
    catch (error) { if (current === accessGeneration.current) setSettingsError(connectionError(error)); }
  }

  useEffect(() => {
    let alive = true;
    api[service.config]().then(value => {
      if (alive) { setConfig(value); setBaseUrl(value.baseUrl || value.suggestedBaseUrl || ''); setUsername(value.username || ''); }
    }).catch(error => { if (alive) setError(connectionError(error)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!config?.configured || editing) return;
    let alive = true;
    setLoading(true);
    setError('');
    api[service.sections]().then(value => {
      if (!alive) return;
      recordReachable(config.baseUrl);
      setSections(value);
      setSectionId(current => value.some(section => section.id === current) ? current : value[0]?.id || '');
    }).catch(error => { if (alive) recordConnectionError(error, config.baseUrl); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [config, editing, reload]);

  useEffect(() => {
    if (!config?.configured || !sectionId || editing) return;
    const current = ++generation.current;
    setLoading(true);
    setError('');
    setPage({ items: [], total: 0 });
    api[service.browse]({ sectionId, parentId, start, query: parentId ? '' : search }).then(value => {
      if (current === generation.current) { setPage(value); recordReachable(config.baseUrl); }
    }).catch(error => { if (current === generation.current) recordConnectionError(error, config.baseUrl); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [config, sectionId, parentId, start, search, editing, reload]);

  async function connect(event) {
    event.preventDefault();
    setBusy('connect'); setError(''); setNotice('');
    try {
      const value = await api[service.connect](isJellyfin ? { baseUrl: baseUrl.trim(), username: username.trim(), password } : { baseUrl: baseUrl.trim(), token: token.trim() });
      recordReachable(value.baseUrl);
      setToken(''); setPassword(''); setConfig(value); setBaseUrl(value.baseUrl); setEditing(false);
      setSectionId(''); setTrail([]); setStart(0); setQuery(''); setSearch('');
    } catch (error) { recordConnectionError(error, baseUrl); }
    finally { setBusy(''); }
  }
  async function disconnect() {
    setBusy('disconnect'); setError(''); setNotice('');
    try {
      await api[service.disconnect]();
      generation.current++;
      setConfig({ configured: false, platform: config?.platform }); setToken(''); setPassword(''); setUsername(''); setBaseUrl(''); setEditing(false);
      setLocalAccess({ status: 'idle', url: '', message: '' });
      setSections([]); setSectionId(''); setTrail([]); setPage({ items: [], total: 0 });
    } catch (error) { setError(connectionError(error)); }
    finally { setBusy(''); }
  }
  async function download(item) {
    setBusy(item.id); setError(''); setNotice('');
    try {
      const result = await api[service.download](item.id);
      setNotice(result.alreadySaved ? `“${item.title}” is already saved in your library.` : result.accepted ? `“${item.title}” added to downloads.` : `“${item.title}” is already in the queue.`);
    } catch (error) { recordConnectionError(error, config.baseUrl); }
    finally { setBusy(''); }
  }
  const accessPanel = accessStatus === 'reachable' ? <p className="success-message plex-access-success" role="status"><Icon name="check" size={14} /> Your server is reachable on this network.</p> : <section className="plex-local-access" aria-label={isMac ? 'Local network access' : 'Server connection'}>
    <h3>{isMac ? 'Local network access' : 'Server connection'}</h3>
    <p className="section-note">{isMac ? 'Request access before connecting. Choose Allow if macOS asks. No sign-in is needed for this check.' : 'Check that Offgrid can reach your server before connecting. No sign-in is needed.'}</p>
    <div className="plex-actions">
      <button type="button" className="secondary-button compact" disabled={accessStatus === 'checking' || !!busy} onClick={requestLocalAccess}>{accessStatus === 'checking' ? 'Checking…' : ['unreachable', 'blocked-or-unreachable'].includes(accessStatus) ? 'Check again' : isMac ? 'Request local access' : 'Check server connection'}</button>
      {isMac && <button type="button" className="text-button" onClick={openNetworkSettings}>Open Local Network settings</button>}
    </div>
    <p className="section-note" role="status" aria-live="polite">{localAccess.url === baseUrl.trim() ? localAccess.message : ''}</p>
    {isMac && ['unreachable', 'blocked-or-unreachable'].includes(accessStatus) && <p className="section-note">If access was denied, enable Offgrid in System Settings → Privacy &amp; Security → Local Network, then check again. macOS only shows the permission prompt the first time; an unreachable server can also cause this check to fail.</p>}
    <ErrorMessage>{settingsError}</ErrorMessage>
  </section>;
  return <>
    <header className="page-header">
      <div><h1>{service.name}</h1></div>
      {config?.configured && <button className="secondary-button" onClick={onDownloads}><Icon name="download" size={16} /> View downloads</button>}
    </header>
    {providerControls}
    <ErrorMessage>{error}</ErrorMessage>
    {config === null ? <p className="loading-message" role="status">{loading ? `Checking your ${service.name} connection…` : `Your ${service.name} connection could not be loaded.`}</p> : !config.configured || editing ? <section className="download-composer plex-connect">
      <h2>{config.configured ? 'Change connection' : `Connect your ${service.name} server`}</h2>
      <p className="section-note">Use the local address of your server. Offgrid downloads the original files; playback opens in mpv.</p>
      <form onSubmit={connect} autoComplete="off">
        <label className="form-field">Server address<input type="url" value={baseUrl} onChange={event => changeServerAddress(event.target.value)} placeholder={service.placeholder} required spellCheck="false" autoCapitalize="none" /></label>
        {accessPanel}
        {isJellyfin ? <>
          <label className="form-field">Username<input type="text" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required spellCheck="false" autoCapitalize="none" /></label>
          <label className="form-field">Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
          <p className="section-note">Sign in with a Jellyfin account that allows downloads. Offgrid stores your session securely on this Mac; your password is never saved. Include /jellyfin in the server address if your server uses that path.</p>
        </> : <>
          <label className="form-field">Plex token<input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Enter your Plex authentication token" autoComplete="new-password" required spellCheck="false" /></label>
          <p className="section-note">Your token is stored securely on this Mac. Use a token for an account that can access this server.</p>
          <details className="plex-token-help"><summary>Find your Plex token</summary><p>In Plex Web, open a movie or episode, choose Get Info, then View XML. Copy the value after X-Plex-Token= in the browser address, and paste only that value here.</p></details>
        </>}
        <div className="plex-actions"><button className="primary-button" disabled={!!busy || (isJellyfin ? !username.trim() : !token.trim()) || !baseUrl.trim()}>{busy === 'connect' ? 'Connecting…' : 'Connect server'}</button>
          {config.configured && <button type="button" className="text-button" disabled={!!busy} onClick={() => { setEditing(false); setToken(''); setPassword(''); setUsername(config.username || ''); setBaseUrl(config.baseUrl); setError(''); }}>Cancel</button>}</div>
      </form>
    </section> : <>
      <div className="plex-connection"><div><h2>{config.serverName || `${service.name} server`}</h2><p>{config.baseUrl}</p></div><div className="plex-actions"><button className="text-button" disabled={!!busy} onClick={() => { setEditing(true); setNotice(''); }}>Change connection</button><button className="text-button neutral" disabled={!!busy} onClick={disconnect}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button></div></div>
      {accessStatus !== 'reachable' && !loading && accessPanel}
      <div className="library-toolbar">
        <select aria-label={`${service.name} library`} value={sectionId} disabled={!sections.length || !!busy} onChange={event => { setSectionId(event.target.value); setTrail([]); setStart(0); setQuery(''); setSearch(''); }}>
          {sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}
        </select>
        {!parentId && <form className="plex-search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setStart(0); }}><label className="search-field"><Icon name="search" size={16} /><input aria-label={`Search ${service.name} library`} placeholder="Search this library" value={query} onChange={event => setQuery(event.target.value)} /></label><button className="text-button" type="submit">Search</button></form>}
        <button className="text-button" disabled={loading} onClick={() => setReload(value => value + 1)}>Refresh</button>
      </div>
      {parentId && <div className="section-heading"><button className="text-button" onClick={() => { setTrail(current => current.slice(0, -1)); setStart(0); }}><Icon name="back" size={16} /> Back to {trail.length > 1 ? trail.at(-2).title : sections.find(section => section.id === sectionId)?.title || 'library'}</button><span>{trail.at(-1).title}</span></div>}
      {notice && <p className="success-message" role="status"><Icon name="check" size={14} />{notice}</p>}
      {loading ? <p className="loading-message" role="status">Loading your {service.name} library…</p> : !page.items.length ? <EmptyState icon="library" title={error ? 'Server unavailable' : search ? 'No matches in this library' : 'No media to browse'}>{error ? 'Make sure your server is running on this network, then refresh.' : search ? 'Try another title or clear your search.' : 'Movie and TV libraries on your connected server appear here.'}</EmptyState> : <>
        <div className="plex-media-list">
          {page.items.map(item => <article className="plex-media-row" key={item.id}>
            <span className="job-glyph"><Icon name={['show', 'season'].includes(item.type) ? 'folder' : 'play'} size={18} /></span>
            <div className="plex-media-details"><h3>{item.title}</h3><p>{[item.subtitle, item.duration ? formatDuration(item.duration) : '', item.sizeBytes ? formatBytes(item.sizeBytes) : '', item.downloadable ? 'Original quality' : ''].filter(Boolean).join(' · ')}</p></div>
            {['show', 'season'].includes(item.type) ? <button className="secondary-button compact" onClick={() => { setTrail(current => [...current, { id: item.id, title: item.title }]); setStart(0); setNotice(''); }}>Browse {item.type === 'show' ? 'seasons' : 'episodes'}</button> : item.downloadable ? <button className="secondary-button compact" disabled={!!busy} onClick={() => download(item)}><Icon name="download" size={13} />{busy === item.id ? 'Adding…' : 'Download'}</button> : <span className="section-note">Unavailable</span>}
          </article>)}
        </div>
        <div className="plex-pagination"><span>{start + 1}–{start + page.items.length} of {page.total}</span><div className="plex-actions"><button className="text-button" disabled={start === 0 || loading} onClick={() => setStart(value => Math.max(0, value - 100))}>Previous</button><button className="text-button" disabled={start + page.items.length >= page.total || loading} onClick={() => setStart(value => value + 100)}>Next</button></div></div>
      </>}
      <p className="section-note">{service.name} stays available on your local network even without internet access. Saved files remain in your library after disconnecting.</p>
    </>}
  </>;
}
