import { useEffect, useRef, useState } from 'react';
export const qualityOptions = [['480p', 'Up to 480p'], ['720p', 'Up to 720p'], ['1080p', 'Up to 1080p'], ['best', 'Best available']];
export const pendingStatuses = ['queued', 'preparing', 'downloading', 'processing', 'waiting-storage', 'waiting-network'];
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
