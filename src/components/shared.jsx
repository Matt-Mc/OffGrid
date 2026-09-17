import { useEffect, useRef, useState } from 'react';
export const qualityOptions = [['480p', 'Up to 480p'], ['720p', 'Up to 720p'], ['1080p', 'Up to 1080p'], ['best', 'Best available']];
export const pendingStatuses = ['queued', 'preparing', 'downloading', 'processing', 'waiting-storage', 'waiting-network', 'paused'];
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unavailable';
  if (bytes <= 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), 4);
  const value = bytes / 1000 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}
export function formatDuration(seconds) {
  if (!seconds) return '—';
  const total = Math.floor(seconds);
  return total >= 3600 ? `${Math.floor(total / 3600)}h ${Math.floor(total % 3600 / 60)}m` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export function formatDate(date) {
  return date ? new Date(date).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }) : 'Not checked yet';
}
export function validUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(url.hostname);
  } catch {
    return false;
  }
}
export function Icon({
  name,
  size = 18
}) {
  const paths = {
    library: <>
    <rect x="3" y="5" width="18" height="15" rx="2" />
    <path d="M7 2h10M3 10h18m-13 4 5 3-5 3" />
  </>,
    download: <>
    <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
  </>,
    follow: <>
    <rect x="3" y="3" width="18" height="14" rx="2" />
    <path d="M8 21h8m-4-4v4m-2-14 5 3-5 3" />
  </>,
    settings: <>
    <path d="M4 6h16M4 12h16M4 18h16" />
    <circle cx="8" cy="6" r="2" />
    <circle cx="16" cy="12" r="2" />
    <circle cx="10" cy="18" r="2" />
  </>,
    play: <path d="m8 5 11 7-11 7z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <>
    <circle cx="10" cy="10" r="6" />
    <path d="m15 15 5 5" />
  </>,
    check: <path d="m5 12 4 4L19 6" />,
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    more: <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
    folder: <path d="M3 7V4h7l2 3h9v13H3z" />,
    offline: <>
    <path d="m3 3 18 18M3 9a15 15 0 0 1 3-2m4-1a15 15 0 0 1 11 3M6 13a10 10 0 0 1 3-2m5 0a10 10 0 0 1 4 2m-9 4a5 5 0 0 1 6 0" />
    <circle cx="12" cy="21" r=".5" />
  </>
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
    {paths[name]}
  </svg>;
}
export function QualitySelect({
  value,
  onChange,
  ...props
}) {
  return <select value={value} onChange={e => onChange(e.target.value)} {...props}>
    {qualityOptions.map(([value, label]) => <option key={value} value={value}>
      {label}
    </option>)}
  </select>;
}
export function Toggle({
  checked,
  onChange,
  label,
  disabled
}) {
  return <button type="button" className="toggle" role="switch" aria-checked={!!checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
    <span />
  </button>;
}
export function Thumbnail({
  video
}) {
  const [failed, setFailed] = useState(!video.thumbnailPath);
  useEffect(() => setFailed(!video.thumbnailPath), [video.id, video.thumbnailPath]);
  return failed ? <div className="visual-tile">
    <Icon name="play" size={30} />
  </div> : <img className="video-thumbnail" src={window.offgrid.thumbnailUrl(video.id)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}
export function EmptyState({
  icon,
  title,
  children,
  action
}) {
  return <div className="empty-state">
    <span className="empty-glyph">
      <Icon name={icon} size={32} />
    </span>
    <h2>
      {title}
    </h2>
    <p>
      {children}
    </p>
    {action}
  </div>;
}
export function ErrorMessage({
  children
}) {
  return children ? <p className="inline-error" role="alert">
    {children}
  </p> : null;
}
export function StorageBar({
  storage
}) {
  const used = (storage?.savedBytes || 0) + (storage?.temporaryBytes || 0);
  const denominator = storage?.maxLibraryBytes || used + (storage?.freeBytes || 0) || 1;
  return <div className="storage-bar" role="img" aria-label={`${formatBytes(used)} used${storage?.maxLibraryBytes ? ` of ${formatBytes(storage.maxLibraryBytes)}` : ', no library limit'}`}>
    <i style={{
      width: `${Math.min(100, (storage?.savedBytes || 0) / denominator * 100)}%`
    }} />
    <b style={{
      width: `${Math.min(100 - Math.min(100, (storage?.savedBytes || 0) / denominator * 100), (storage?.temporaryBytes || 0) / denominator * 100)}%`
    }} />
  </div>;
}
export function ConfirmDialog({
  confirmation,
  onCancel,
  onConfirm,
  busy,
  error
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (confirmation && !ref.current.open) ref.current.showModal();else if (!confirmation && ref.current.open) ref.current.close();
  }, [confirmation]);
  return <dialog ref={ref} className="confirm-dialog" onCancel={e => {
    e.preventDefault();
    if (!busy) onCancel();
  }} aria-labelledby="confirmation-title">
    <h2 id="confirmation-title">
      {confirmation?.title}
    </h2>
    <p>
      {confirmation?.description}
    </p>
    <ErrorMessage>
      {error}
    </ErrorMessage>
    <div className="dialog-actions">
      <button autoFocus className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button className="danger-button" disabled={busy} onClick={onConfirm}>
        {busy ? 'Removing…' : confirmation?.action || 'Delete permanently'}
      </button>
    </div>
  </dialog>;
}

export function SubtitleOptions({ language, onLanguage, automatic = false, onAutomatic, disabled = false }) {
  return <div className="subtitle-options">
    <label className="form-field">Subtitles<select aria-label="Subtitle language" value={language || ''} disabled={disabled} onChange={event => onLanguage(event.target.value)}>
      <option value="">Don’t download subtitles</option>
      {[['en','English'],['fr','French'],['es','Spanish'],['de','German'],['it','Italian'],['pt','Portuguese'],['ja','Japanese'],['ko','Korean'],['zh','Chinese']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}
      {language && !['en','fr','es','de','it','pt','ja','ko','zh'].includes(language) && <option value={language}>{language}</option>}
    </select></label>
    {onAutomatic && <label className="inline-check"><input type="checkbox" checked={automatic} disabled={disabled || !language} onChange={event => onAutomatic(event.target.checked)} /> Allow automatic captions when needed</label>}
  </div>;
}

export function batchSummary(result) {
  const counts = result?.counts || {};
  return [[counts.added,'added'],[counts.alreadyQueued,'already queued'],[counts.alreadySaved,'already saved'],[counts.rejected,'unavailable']].filter(([count]) => count).map(([count,label]) => `${count} ${label}`).join(' · ') || 'No downloads added.';
}

export function BatchSelection({ preview, selected, onSelected, busy, onAdd, onMore, onClose, label = 'videos' }) {
  const items = preview?.items || [];
  const selectable = items.filter(item => item.available !== false && !['alreadyQueued','alreadySaved','rejected'].includes(item.outcome));
  const chosen = selectable.filter(item => selected.includes(item.id));
  const bytes = chosen.reduce((sum,item) => sum + (item.expectedBytes || item.sizeBytes || 0),0);
  const unknown = chosen.filter(item => !(item.expectedBytes || item.sizeBytes)).length;
  const duration = chosen.reduce((sum,item) => sum + (item.duration || 0),0);
  return <section className="batch-preview" aria-label={`Select ${label} to download`}>
    <div className="section-heading"><h3>Choose {label}</h3>{onClose && <button type="button" className="text-button" disabled={busy} onClick={onClose}>Close preview</button>}</div>
    {preview.warning && <p className="estimate-warning" role="status">{preview.warning}</p>}
    <div className="batch-toolbar"><label className="inline-check"><input type="checkbox" disabled={busy || !selectable.length} checked={!!selectable.length && selectable.every(item => selected.includes(item.id))} onChange={event => onSelected(event.target.checked ? selectable.slice(0,500).map(item => item.id) : [])} /> Select available{selectable.length > 500 ? ' (up to 500)' : ''}</label><span>{items.length} shown{preview.total != null ? ` of ${preview.total}` : ''}</span></div>
    <div className="batch-items">{items.map((item,index) => {
      const unavailable = !selectable.includes(item);
      return <label className={`batch-item ${unavailable ? 'unavailable' : ''}`} key={`${item.id}-${index}`}><input type="checkbox" disabled={busy || unavailable || selected.length >= 500 && !selected.includes(item.id)} checked={selected.includes(item.id)} onChange={event => onSelected(event.target.checked ? [...selected,item.id] : selected.filter(id => id !== item.id))} /><span><strong>{item.title || item.url || 'Unavailable video'}</strong><small>{[(item.episodeNumber ?? item.episode) != null ? `Episode ${item.episodeNumber ?? item.episode}` : '',item.duration ? formatDuration(item.duration) : '',item.expectedBytes || item.sizeBytes ? formatBytes(item.expectedBytes || item.sizeBytes) : 'Size unavailable',item.outcome === 'alreadyQueued' ? 'Already queued' : item.outcome === 'alreadySaved' ? 'Already saved' : item.reason].filter(Boolean).join(' · ')}</small>{item.subtitleTracks?.length > 0 && <small>Subtitles: {item.subtitleTracks.map(track => `${track.language}${['auto','automatic'].includes(track.origin) ? ' (automatic)' : ''}`).join(', ')}</small>}</span></label>;
    })}</div>
    {preview.hasMore && onMore && <button type="button" className="text-button" disabled={busy} onClick={onMore}>{busy ? 'Loading…' : 'Load more'}</button>}
    <div className="batch-footer"><p>{chosen.length} selected{duration ? ` · ${formatDuration(duration)}` : ''}{bytes ? ` · About ${formatBytes(bytes)}` : ''}{unknown ? ` · ${unknown} size${unknown === 1 ? '' : 's'} unknown` : ''}<small>{chosen.length > 500 ? 'Choose up to 500 videos per batch.' : 'Final sizes may vary. Downloads wait when storage is full.'}</small></p><button type="button" className="primary-button" disabled={busy || !chosen.length || chosen.length > 500} onClick={onAdd}>{busy ? 'Working…' : `Add ${chosen.length || 'selected'} to queue`}</button></div>
  </section>;
}


export function BatchResults({ results }) {
  const skipped=(results || []).filter(result=>result.outcome !== 'added');
  if(!skipped.length) return null;
  return <details className="composer-options batch-results"><summary>Skipped and unavailable · {skipped.length}</summary><div className="batch-items">{skipped.map((result,index)=><div className="batch-item" key={index}><span><strong>{result.title || 'Video'}</strong><small>{result.reason || (result.outcome === 'alreadySaved' ? 'Already saved in your library.' : result.outcome === 'alreadyQueued' ? 'Already in your download queue.' : 'This video could not be added.')}</small></span></div>)}</div></details>;
}
