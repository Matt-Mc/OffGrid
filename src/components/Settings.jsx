import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorMessage, Icon, QualitySelect, StorageBar, Toggle, formatBytes } from './shared';
function SettingRow({
  title,
  description,
  children
}) {
  return <div className="setting-row">
    <div>
      <h3>
        {title}
      </h3>
      {description && <p>
        {description}
      </p>}
    </div>
    <div className="setting-control">
      {children}
    </div>
  </div>;
}
export function Settings({
  settings,
  storage,
  videos,
  queue,
  onSave,
  onDelete,
  storageRequest,
  tool,
  ffmpeg,
  version,
  onUpdateTool,
  player,
  onRefreshPlayer
}) {
  const [saving, setSaving] = useState('');
  const [errors, setErrors] = useState({});
  const [limit, setLimit] = useState(settings.maxLibraryBytes ? String(settings.maxLibraryBytes / 1e9) : 'none');
  const [customLimit, setCustomLimit] = useState('20');
  const [managerOpen, setManagerOpen] = useState(false);
  const [selected, setSelected] = useState([]);
  const [sort, setSort] = useState('size');
  const storageSection = useRef(null);
  useEffect(() => {
    const next = settings.maxLibraryBytes ? String(settings.maxLibraryBytes / 1e9) : 'none';
    if (['none', '10', '20', '50', '100'].includes(next)) setLimit(next);else {
      setLimit('custom');
      setCustomLimit(next);
    }
  }, [settings.maxLibraryBytes]);
  useEffect(() => {
    if (storageRequest) {
      setManagerOpen(true);
      storageSection.current?.scrollIntoView({
        block: 'start'
      });
    }
  }, [storageRequest]);
  useEffect(() => setSelected(current => current.filter(id => videos.some(video => video.id === id))), [videos]);
  async function save(key, value) {
    setSaving(key);
    setErrors(current => ({
      ...current,
      [key]: ''
    }));
    try {
      await onSave({
        [key]: value
      });
      return true;
    } catch (error) {
      setErrors(current => ({
        ...current,
        [key]: error.message
      }));
      return false;
    } finally {
      setSaving('');
    }
  }
  async function runAction(key, action) {
    setSaving(key);
    setErrors(current => ({
      ...current,
      [key]: ''
    }));
    try {
      await action();
    } catch (error) {
      setErrors(current => ({
        ...current,
        [key]: error.message
      }));
    } finally {
      setSaving('');
    }
  }
  const nextLimit = limit === 'none' ? null : Math.round(Number(limit === 'custom' ? customLimit : limit) * 1e9);
  const validLimit = nextLimit === null || Number.isSafeInteger(nextLimit) && nextLimit >= 1e9;
  const used = (storage?.savedBytes || 0) + (storage?.temporaryBytes || 0);
  const active = queue.jobs.some(job => ['preparing', 'downloading', 'processing'].includes(job.status));
  const selectedVideos = videos.filter(video => selected.includes(video.id));
  const ordered = useMemo(() => [...videos].sort((a, b) => sort === 'size' ? (b.deletionBytes ?? b.sizeBytes ?? 0) - (a.deletionBytes ?? a.sizeBytes ?? 0) : new Date(a.savedAt) - new Date(b.savedAt)), [videos, sort]);
  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">MAKE YOURSELF AT HOME</p>
        <h1>Settings</h1>
        <p>Your defaults for a library that travels well.</p>
      </div>
      <span className="keyboard-hint">⌘ ,</span>
    </header>
    <div className="settings-content">
      <section className="settings-section">
        <div className="section-heading">
          <h2>Downloads</h2>
          <span>For videos added from now on</span>
        </div>
        <div className="setting-group">
          <SettingRow title="Default quality" description="Higher quality uses more space. Videos keep their original resolution when it is lower.">
            <QualitySelect value={settings.defaultQuality} onChange={value => save('defaultQuality', value)} disabled={!!saving} aria-label="Default download quality" />
          </SettingRow>
          <ErrorMessage>
            {errors.defaultQuality}
          </ErrorMessage>
          <SettingRow title="Save available comments" description="Keep a selection of comments to read offline alongside each video.">
            <Toggle checked={settings.saveComments} onChange={value => save('saveComments', value)} disabled={!!saving} label="Save available comments" />
          </SettingRow>
          <ErrorMessage>
            {errors.saveComments}
          </ErrorMessage>
        </div>
        <p className="section-note">Videos already in the queue keep the options they were added with.</p>
      </section>
      <section className="settings-section">
        <div className="section-heading"><h2>Playback</h2><span>Separate player window</span></div>
        <div className="setting-group">
          <SettingRow title={player?.available ? (player.source === 'bundled' ? 'Bundled player is ready' : 'mpv is ready') : 'Server player needs attention'} description={player?.available ? 'Movies and videos open in mpv. Offgrid saves your progress so you can resume later.' : 'The mpv player supports original Plex and Jellyfin files, multiple audio tracks, and subtitles. YouTube videos can use the built-in player.'}>
            <button className="secondary-button compact" disabled={!!saving} onClick={() => runAction('player', onRefreshPlayer)}>{saving === 'player' ? 'Checking…' : 'Refresh player'}</button>
          </SettingRow>
          <ErrorMessage>{errors.player}</ErrorMessage>
        </div>
        {player?.message && <p className="section-note">{player.message}</p>}
      </section>
      <section ref={storageSection} className="settings-section storage-section" id="storage">
        <div className="section-heading">
          <h2>Storage</h2>
          <button className="text-button" onClick={() => setManagerOpen(!managerOpen)} aria-expanded={managerOpen}>
            {managerOpen ? 'Hide saved videos' : 'Manage saved videos'}
          </button>
        </div>
        <div className="storage-overview">
          <div className="storage-heading">
            <strong>{formatBytes(used)} <span>in your library</span></strong>
            <span>
              {storage?.maxLibraryBytes ? `${formatBytes(storage.maxLibraryBytes)} limit` : 'No library limit'}
            </span>
          </div>
          <StorageBar storage={storage} />
          <div className="storage-legend">
            <span><i />Saved media <b>
                {formatBytes(storage?.savedBytes)}
              </b></span>
            <span><i className="temporary" />Temporary files <b>
                {formatBytes(storage?.temporaryBytes)}
              </b></span>
            <span>Free on disk <b>
                {formatBytes(storage?.freeBytes)}
              </b></span>
          </div>
        </div>
        <div className="setting-group">
          <SettingRow title="Maximum library size" description="Includes saved videos, thumbnails, and temporary download files. Nothing is deleted automatically.">
            <select value={limit} onChange={e => setLimit(e.target.value)} aria-label="Maximum library size">
              <option value="none">No limit</option>
              {[10, 20, 50, 100].map(size => <option key={size} value={size}>{size} GB</option>)}
              <option value="custom">Custom…</option>
            </select>
          </SettingRow>
          {limit === 'custom' && <div className="custom-limit">
            <label>Custom limit<input aria-label="Custom library limit in GB" type="number" min="1" step="0.1" value={customLimit} onChange={e => setCustomLimit(e.target.value)} />GB</label>
          </div>}
          {nextLimit !== settings.maxLibraryBytes && <div className="limit-preview">
            <p>
              {!validLimit ? 'Enter a library limit of at least 1 GB.' : nextLimit && nextLimit < used ? `Your library uses ${formatBytes(used)}. New downloads will wait until there is space within ${formatBytes(nextLimit)}. Your saved videos stay safe.` : nextLimit ? `New downloads will wait when they cannot fit within ${formatBytes(nextLimit)}.` : 'Your library can grow as space allows. Free disk protection remains enabled.'}
              {active && nextLimit && nextLimit < (settings.maxLibraryBytes || Infinity) ? ' A lower limit may stop the current download if it no longer fits.' : ''}
            </p>
            <button className="primary-button compact" disabled={!validLimit || !!saving} onClick={() => save('maxLibraryBytes', nextLimit)}>
              {saving === 'maxLibraryBytes' ? 'Applying…' : 'Apply limit'}
            </button>
          </div>}
          <ErrorMessage>
            {errors.maxLibraryBytes}
          </ErrorMessage>
          <SettingRow title="Library location" description={storage?.libraryPath || 'Loading library location…'}>
            <button className="secondary-button compact" disabled={!!saving} onClick={() => runAction('reveal', () => window.offgrid.revealLibrary())}><Icon name="folder" size={15} /> Reveal in Finder</button>
          </SettingRow>
          <ErrorMessage>
            {errors.reveal}
          </ErrorMessage>
        </div>
        <p className="section-note">Sizes use decimal GB. App support files: {formatBytes(storage?.supportBytes)} (outside your library limit). Offgrid keeps at least {formatBytes(storage?.diskReserveBytes || 2e9)} of disk space free.</p>
        {managerOpen && <div className="storage-manager">
          <div className="section-heading">
            <h3>Saved videos</h3>
            <select aria-label="Sort saved videos for cleanup" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="size">Largest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
          {videos.length ? <>
            <div className="manager-actions">
              <label><input type="checkbox" checked={selected.length === videos.length} onChange={e => setSelected(e.target.checked ? videos.map(video => video.id) : [])} /> Select all</label>
              <button className="text-button danger" disabled={!selected.length} onClick={() => onDelete(selectedVideos)}>Delete {selected.length || 'selected'} · {formatBytes(selectedVideos.reduce((sum, video) => sum + (video.deletionBytes ?? video.sizeBytes ?? 0), 0))}…</button>
            </div>
            <div className="storage-video-list">
              {ordered.map(video => <label key={video.id} className="storage-video-row">
                <input type="checkbox" checked={selected.includes(video.id)} onChange={e => setSelected(current => e.target.checked ? [...current, video.id] : current.filter(id => id !== video.id))} />
                <span>
                  <strong>
                    {video.title}
                  </strong>
                  <small>{video.channel} · Saved {new Date(video.savedAt).toLocaleDateString()}{video.watched ? ' · Watched' : ''}</small>
                </span>
                <b>
                  {formatBytes(video.deletionBytes ?? video.sizeBytes)}
                </b>
              </label>)}
            </div>
            <p className="section-note">Sizes include the saved video and its thumbnail. Associated metadata is also removed.</p>
          </> : <p className="section-note">There are no saved videos to manage yet.</p>}
        </div>}
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h2>Following</h2>
          <span>Defaults for new follows</span>
        </div>
        <div className="setting-group">
          <SettingRow title="Automatic downloads" description="Offer automatic downloads when following a new channel. You can change this for each channel.">
            <Toggle checked={settings.autoDownload} onChange={value => save('autoDownload', value)} disabled={!!saving} label="Automatic downloads for new follows" />
          </SettingRow>
          <ErrorMessage>
            {errors.autoDownload}
          </ErrorMessage>
          <SettingRow title="Check frequency" description="Automatic checks run while Offgrid is open and online.">
            <select value={settings.checkIntervalHours} onChange={e => save('checkIntervalHours', Number(e.target.value))} disabled={!!saving} aria-label="Default check frequency">
              <option value={0}>Manual only</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Daily</option>
            </select>
          </SettingRow>
          <ErrorMessage>
            {errors.checkIntervalHours}
          </ErrorMessage>
          <SettingRow title="Recent videos to fetch" description="Look at this many recent videos per check. This does not remove older saved videos.">
            <select value={settings.recentVideoCount} onChange={e => save('recentVideoCount', Number(e.target.value))} disabled={!!saving} aria-label="Recent videos per channel">
              {[1, 3, 5, 10].map(count => <option key={count} value={count}>{count} {count === 1 ? 'video' : 'videos'}</option>)}
            </select>
          </SettingRow>
          <ErrorMessage>
            {errors.recentVideoCount}
          </ErrorMessage>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h2>About & diagnostics</h2>
          <span>Offgrid {version || ''}</span>
        </div>
        <div className="diagnostics-summary">
          <span className={`tool-dot ${[tool.status, ffmpeg.status].every(status => ['ready', 'fallback'].includes(status)) ? 'ready' : 'busy'}`} />
          <p>
            {[tool.status, ffmpeg.status].every(status => ['ready', 'fallback'].includes(status)) ? 'Download components are ready.' : 'Download components need attention. See details below.'}
          </p>
        </div>
        <details className="diagnostics">
          <summary>Download component details</summary>
          {[['yt-dlp', tool, 'tool'], ['FFmpeg', ffmpeg, 'ffmpeg']].map(([name, status, key]) => <div className="tool-row" key={key}>
            <div>
              <h3>{name} <span>
                  {status.version || status.status}
                </span></h3>
              <p>
                {status.message}
              </p>
              {status.path && <p className="tool-path">
                {status.path}
              </p>}
              <ErrorMessage>
                {errors[key]}
              </ErrorMessage>
            </div>
            <button className="secondary-button compact" disabled={!!saving || ['checking', 'updating'].includes(status.status)} onClick={() => runAction(key, () => onUpdateTool(key))}>
              {saving === key ? 'Updating…' : 'Check for updates'}
            </button>
          </div>)}
        </details>
      </section>
    </div>
  </>;
}
