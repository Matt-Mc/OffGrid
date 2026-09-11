import { useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorMessage, Icon, QualitySelect, formatBytes, formatDuration, pendingStatuses, validUrl } from './shared';
const statusLabels = {
  queued: 'Queued',
  preparing: 'Preparing',
  downloading: 'Downloading',
  processing: 'Processing',
  complete: 'Ready to watch',
  error: 'Failed',
  canceled: 'Canceled',
  'waiting-storage': 'Waiting for space',
  'waiting-network': 'Waiting for connection'
};
function DownloadRow({
  job,
  onAction,
  onManage,
  onPlay,
  videos
}) {
  const [quality, setQuality] = useState(job.quality);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recoverable = ['error', 'canceled', 'waiting-storage', 'waiting-network'].includes(job.status);
  const active = ['preparing', 'downloading', 'processing'].includes(job.status);
  async function act(action, ...args) {
    setBusy(true);
    setError('');
    try {
      await onAction(action, ...args);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const serverDownload = ['plex', 'jellyfin'].includes(job.provider);
  const saved = videos.find(video => video.id === job.videoId || video.sourceId && video.sourceId === job.sourceId);
  return <article className={`download-row status-${job.status}`}>
    <span className="job-glyph">
      <Icon name={job.status === 'complete' ? 'check' : 'download'} size={18} />
    </span>
    <div className="job-details">
      <div className="job-title">
        <h3>
          {job.title || job.url}
        </h3>
        <span className={`status-label ${job.status}`}>
          {statusLabels[job.status] || job.status}
        </span>
      </div>
      <p>{serverDownload ? `Original quality · ${job.provider === 'jellyfin' ? 'Jellyfin' : 'Plex'}` : job.quality === 'best' ? 'Best available' : `Up to ${job.quality}`} · {job.expectedBytes ? `About ${formatBytes(job.expectedBytes)}` : 'Size unavailable'}{job.source === 'subscription' ? ' · Followed channel' : ''}{job.saveComments ? ' · Comments included' : ''}</p>
      {active && <div className={`progress-track ${job.status !== 'downloading' ? 'indeterminate' : ''}`} role="progressbar" aria-label={statusLabels[job.status]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.status === 'downloading' ? Math.round(job.progress || 0) : undefined}>
        <i style={{
          width: `${Math.min(100, Math.max(0, job.progress || 0))}%`
        }} />
      </div>}
      {job.status === 'downloading' && <p className="progress-copy">{Math.round(job.progress || 0)}% downloaded{job.speedBytes ? ` · ${formatBytes(job.speedBytes)}/s` : ''}{Number.isFinite(job.etaSeconds) ? ` · ${Math.ceil(job.etaSeconds / 60)} min remaining` : ''}</p>}
      {job.message && job.status !== 'downloading' && <p className={['error', 'waiting-storage'].includes(job.status) ? 'job-message attention' : 'job-message'}>
        {job.error || job.message}
      </p>}
      <ErrorMessage>
        {error}
      </ErrorMessage>
      {recoverable && <div className="recovery-actions">
        {job.status === 'waiting-storage' && <button className="text-button" onClick={onManage}>Manage storage</button>}
        {!serverDownload && <QualitySelect value={quality} onChange={setQuality} aria-label={`Retry quality for ${job.title}`} />}
        <button className="secondary-button compact" disabled={busy} onClick={() => act('retry', job.id, serverDownload ? {} : { quality })}>
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      </div>}
    </div>
    <div className="job-actions">
      {pendingStatuses.includes(job.status) && <button className="text-button neutral" disabled={busy} onClick={() => act('cancel', job.id)}>Cancel</button>}
      {saved && job.status === 'complete' && <button className="secondary-button compact" onClick={() => onPlay(saved)}><Icon name="play" size={13} /> Play</button>}
    </div>
  </article>;
}
export function Downloads({
  settings,
  queue,
  online,
  onManage,
  onPlay,
  videos,
  refreshQueue,
  composerRequest
}) {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState(settings.defaultQuality);
  const [estimate, setEstimate] = useState(null);
  const [estimateState, setEstimateState] = useState('idle');
  const [estimateError, setEstimateError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const input = useRef(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!url) setQuality(settings.defaultQuality);
  }, [settings.defaultQuality, url]);
  useEffect(() => {
    if (composerRequest) input.current?.focus();
  }, [composerRequest]);
  useEffect(() => {
    const request = ++generation.current;
    setEstimate(null);
    setEstimateError('');
    setEstimateState('idle');
    if (!validUrl(url) || !online) return;
    setEstimateState('loading');
    const timeout = setTimeout(async () => {
      try {
        const result = await window.offgrid.estimateDownload(url.trim(), quality);
        if (request === generation.current) {
          setEstimate(result);
          setEstimateState('ready');
        }
      } catch (error) {
        if (request === generation.current) {
          setEstimateState('error');
          setEstimateError(error.message || 'Could not read video details.');
        }
      }
    }, 600);
    return () => {
      clearTimeout(timeout);
      generation.current++;
    };
  }, [url, quality, online]);
  async function submit(event) {
    event.preventDefault();
    setError('');
    setConfirmation('');
    if (!validUrl(url)) {
      setError('Enter a valid YouTube video link.');
      return;
    }
    setBusy(true);
    try {
      const result = await window.offgrid.startDownload(url.trim(), quality);
      setUrl('');
      setConfirmation(result?.alreadySaved ? 'This video is already in your library.' : 'Added to your download queue.');
      await refreshQueue();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function act(action, ...args) {
    if (action === 'retry') await window.offgrid.retryDownload(...args);else await window.offgrid.cancelDownload(...args);
    await refreshQueue();
  }
  async function toggleQueue() {
    setQueueBusy(true);
    setError('');
    try {
      await window.offgrid.setQueuePaused(!queue.paused);
      await refreshQueue();
    } catch (error) {
      setError(error.message);
    } finally {
      setQueueBusy(false);
    }
  }
  const pending = queue.jobs.filter(job => pendingStatuses.includes(job.status));
  const history = queue.jobs.filter(job => !pendingStatuses.includes(job.status));
  return <>
    <header className="page-header">
      <div>
        <h1>Downloads</h1>
      </div>
      {queue.jobs.length > 0 && <button className="secondary-button" disabled={queueBusy} onClick={toggleQueue}>
        {queue.paused ? 'Resume queue' : 'Stop after current'}
      </button>}
    </header>
    <section className="download-composer">
      <h2>Add a video</h2>
      <form onSubmit={submit}>
        <div className="download-form">
          <label className="form-field grow">YouTube link<input ref={input} type="url" placeholder="Paste a video link" value={url} onChange={e => {
              setUrl(e.target.value);
              setConfirmation('');
            }} required /></label>
          <label className="form-field">Quality<QualitySelect value={quality} onChange={setQuality} /></label>
          <button className="primary-button" type="submit" disabled={busy || !url.trim()}>
            <Icon name="plus" size={16} />
            {busy ? 'Adding…' : 'Add to queue'}
          </button>
        </div>
        <div className="composer-note">
          <span>{quality === settings.defaultQuality ? 'Using your default quality' : 'Quality override for this video'} · {settings.saveComments ? 'Save available comments' : 'Without comments'}</span>
          <span>Settings apply to future jobs</span>
        </div>
      </form>
      {estimateState === 'loading' && <div className="estimate-preview" role="status">Reading video details…</div>}
      {estimate && <div className="estimate-preview">
        <Icon name="play" size={18} />
        <div>
          <strong>
            {estimate.title || 'Video details'}
          </strong>
          <p>{estimate.duration ? `${formatDuration(estimate.duration)} · ` : ''}{estimate.expectedBytes ? `Estimated download: ${formatBytes(estimate.expectedBytes)}` : 'Size unavailable'} · Final size may vary</p>
        </div>
      </div>}
      {estimateError && <p className="estimate-warning">Size unavailable. {estimateError} You can still add this video to the queue.</p>}
      <ErrorMessage>
        {error}
      </ErrorMessage>
      {confirmation && <p className="success-message" role="status">
        <Icon name="check" size={14} />
        {confirmation}
      </p>}
    </section>
    {queue.paused && <div className="info-banner">The queue is stopped. Any current download will finish; waiting videos stay queued.</div>}
    {!queue.jobs.length ? <EmptyState icon="download" title="A clear queue, a little more freedom">Paste a link above to save a video. Downloads stay here so you can check progress or retry later.</EmptyState> : <>
      {pending.length > 0 && <section className="queue-section">
        <div className="section-heading">
          <h2>In the queue</h2>
          <span>{pending.length} {pending.length === 1 ? 'video' : 'videos'}</span>
        </div>
        <div className="queue-list">
          {pending.map(job => <DownloadRow key={job.id} job={job} onAction={act} onManage={onManage} onPlay={onPlay} videos={videos} />)}
        </div>
      </section>}
      {history.length > 0 && <section className="queue-section">
        <div className="section-heading">
          <h2>Recent activity</h2>
          <span>{history.length} {history.length === 1 ? 'video' : 'videos'}</span>
        </div>
        <div className="queue-list">
          {history.map(job => <DownloadRow key={job.id} job={job} onAction={act} onManage={onManage} onPlay={onPlay} videos={videos} />)}
        </div>
      </section>}
    </>}
  </>;
}
