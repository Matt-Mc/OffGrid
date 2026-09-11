import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Icon, Thumbnail, formatBytes, formatDuration } from './shared';
function VideoCard({
  video,
  onPlay,
  onDelete,
  onWatched
}) {
  const progress = video.duration ? Math.min(100, (video.playbackPositionSeconds || 0) / video.duration * 100) : 0;
  return <article className="video-card">
    <button className="card-visual" onClick={() => onPlay(video)} aria-label={`Play ${video.title}`}>
      <Thumbnail video={video} />
      <span className="play-indicator">
        <Icon name="play" size={16} />
      </span>
      <span className="duration">
        {formatDuration(video.duration)}
      </span>
      {video.watched && <span className="watched-badge"><Icon name="check" size={12} /> Watched</span>}
      {progress > 0 && !video.watched && <span className="watch-progress">
        <i style={{
          width: `${progress}%`
        }} />
      </span>}
    </button>
    <div className="card-info">
      <div>
        <button className="video-title" onClick={() => onPlay(video)}>
          {video.title}
        </button>
        <p>
          {video.channel}
        </p>
        <span className="video-size">
          {video.provider === 'plex' ? 'Plex · ' : video.provider === 'jellyfin' ? 'Jellyfin · ' : ''}{formatBytes(video.sizeBytes)}
        </span>
      </div>
      <details className="overflow-menu">
        <summary aria-label={`Actions for ${video.title}`}>
          <Icon name="more" />
        </summary>
        <div className="menu-items">
          <button onClick={e => {
            e.currentTarget.closest('details').open = false;
            onWatched(video, !video.watched);
          }}>Mark as {video.watched ? 'unwatched' : 'watched'}</button>
          <button className="danger" onClick={e => {
            e.currentTarget.closest('details').open = false;
            onDelete([video]);
          }}>Delete video…</button>
        </div>
      </details>
    </div>
  </article>;
}
export function Library({
  videos,
  onAdd,
  onPlay,
  onDelete,
  onWatched
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [filter, setFilter] = useState('all');
  const filtered = useMemo(() => videos.filter(video => `${video.title} ${video.channel}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'watched' ? video.watched : !video.watched))).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'size' ? b.sizeBytes - a.sizeBytes : new Date(b.savedAt) - new Date(a.savedAt)), [videos, query, sort, filter]);
  const continuing = videos.filter(video => !video.watched && video.playbackPositionSeconds > 10).slice(0, 3);
  const cardProps = {
    onPlay,
    onDelete,
    onWatched
  };
  return <>
    <header className="page-header">
      <div>
        <h1>Library</h1>
        {videos.length > 0 && <p>
          {`${videos.length} ${videos.length === 1 ? 'video' : 'videos'} ready to watch · ${formatBytes(videos.reduce((sum, video) => sum + (video.sizeBytes || 0), 0))}`}
        </p>}
      </div>
      <button className="primary-button" onClick={onAdd}><Icon name="plus" size={16} /> Add video</button>
    </header>
    {videos.length > 0 && <>
      <div className="library-toolbar">
        <label className="search-field">
          <Icon name="search" size={16} />
          <input aria-label="Search library" placeholder="Search your library" value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <div className="segmented-control" aria-label="Filter videos">
          {[['all', 'All videos'], ['unwatched', 'Unwatched'], ['watched', 'Watched']].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}
          </button>)}
        </div>
        <select aria-label="Sort videos" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="recent">Recently saved</option>
          <option value="title">Title A–Z</option>
          <option value="size">Largest first</option>
        </select>
      </div>
      {continuing.length > 0 && !query && filter === 'all' && <section className="continue-section">
        <div className="section-heading">
          <h2>Continue watching</h2>
          <span>Pick up where you left off</span>
        </div>
        <div className="continue-list">
          {continuing.map(video => <button key={video.id} onClick={() => onPlay(video)}>
            <span className="continue-image">
              <Thumbnail video={video} />
              <Icon name="play" size={15} />
            </span>
            <span>
              <strong>
                {video.title}
              </strong>
              <small>{formatDuration(Math.max(0, video.duration - video.playbackPositionSeconds))} remaining</small>
            </span>
          </button>)}
        </div>
      </section>}
      <div className="section-heading">
        <h2>
          {filter === 'all' ? 'Saved videos' : filter === 'watched' ? 'Watched videos' : 'Unwatched videos'}
        </h2>
        <span>{filtered.length} {filtered.length === 1 ? 'video' : 'videos'}</span>
      </div>
    </>}
    {!videos.length ? <EmptyState icon="library" title="Your next watch, ready to go" action={<button className="secondary-button" onClick={onAdd}><Icon name="plus" size={16} /> Add your first video</button>}>Save a video before you head out. Everything in your library plays without an internet connection.</EmptyState> : !filtered.length ? <EmptyState icon="search" title="No videos found">Try a different search or filter.</EmptyState> : <div className="video-grid">
      {filtered.map(video => <VideoCard key={video.id} video={video} {...cardProps} />)}
    </div>}
  </>;
}
export function Player({
  video,
  full,
  onExpand,
  onBack,
  onClose,
  onProgress,
  onFollow
}) {
  const element = useRef(null);
  const lastSave = useRef(0);
  const metadataReady = useRef(false);
  const latest = useRef({
    video,
    onProgress
  });
  latest.current = {
    video,
    onProgress
  };
  const persist = (force = false, ended = false) => {
    const player = element.current;
    if (!metadataReady.current || !player || !Number.isFinite(player.currentTime) || !force && Date.now() - lastSave.current < 5000) return;
    lastSave.current = Date.now();
    onProgress(video.id, {
      positionSeconds: player.currentTime,
      watched: ended || video.watched || player.duration > 0 && player.currentTime / player.duration >= .95
    });
  };
  useEffect(() => {
    const player = element.current;
    const save = () => {
      if (metadataReady.current && player && Number.isFinite(player.currentTime)) latest.current.onProgress(latest.current.video.id, {
        positionSeconds: player.currentTime,
        watched: latest.current.video.watched || player.duration > 0 && player.currentTime / player.duration >= .95
      });
    };
    window.addEventListener('beforeunload', save);
    return () => {
      save();
      window.removeEventListener('beforeunload', save);
    };
  }, []);
  return <section className={`player-panel ${full ? 'player-full' : 'player-mini'}`} aria-label="Video player">
    {full && <div className="player-nav">
      <button className="text-button" onClick={onBack}><Icon name="back" size={16} /> Back to Library</button>
      <button className="icon-button" aria-label="Close player" onClick={() => {
        persist(true);
        onClose();
      }}>
        <Icon name="close" />
      </button>
    </div>}
    <div className="player-frame">
      <video ref={element} src={window.offgrid.videoUrl(video.id)} autoPlay controls onLoadedMetadata={() => {
        metadataReady.current = true;
        if (video.playbackPositionSeconds && !video.watched) element.current.currentTime = Math.min(video.playbackPositionSeconds, element.current.duration || Infinity);
      }} onTimeUpdate={() => persist()} onPause={() => persist(true)} onEnded={() => persist(true, true)} onError={() => onProgress(video.id, null, 'This video could not be played. The saved file may be missing or unsupported.')} />
    </div>
    <div className="player-details">
      <div>
        <h1>
          {video.title}
        </h1>
        <p>{video.channel} · {formatDuration(video.duration)} · {formatBytes(video.sizeBytes)}</p>
      </div>
      {!full && <div className="mini-actions">
        <button className="text-button" onClick={onExpand}>Open player</button>
        <button className="icon-button" aria-label="Close player" onClick={() => {
          persist(true);
          onClose();
        }}>
          <Icon name="close" size={16} />
        </button>
      </div>}
      {full && <>
        <div className="player-actions">
          {video.channelUrl && <button className="secondary-button" onClick={() => onFollow(video)}>Follow channel…</button>}
        </div>
        {video.comments?.length > 0 && <details className="comments">
          <summary>{video.comments.length} saved comments</summary>
          <ol>
            {video.comments.map((comment, index) => <li key={index}>
              <strong>
                {comment.author}
              </strong>
              <p>
                {comment.text}
              </p>
            </li>)}
          </ol>
        </details>}
      </>}
    </div>
  </section>;
}

export function ExternalPlayer({ video, state, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function control(action) {
    setBusy(true); setError('');
    try { await window.offgrid.controlPlayer(action); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  const active = ['starting', 'playing', 'paused'].includes(state.status);
  return <aside className="external-player" aria-label="External video player">
    <div className="external-player-info"><Icon name="play" size={19} /><div><strong>{video?.title || 'mpv player'}</strong><p role="status">{state.error || (state.status === 'starting' ? 'Opening in a separate window…' : `${state.paused || state.status === 'paused' ? 'Paused' : 'Playing'} in mpv · ${(state.positionSeconds ? formatDuration(state.positionSeconds) : '0:00')} / ${formatDuration(state.duration || video?.duration)}`)}</p>{error && <p className="inline-error" role="alert">{error}</p>}</div></div>
    <div className="plex-actions">{active ? <><button className="secondary-button compact" disabled={busy || state.status === 'starting'} onClick={() => control('toggle-pause')}>{state.paused || state.status === 'paused' ? 'Resume' : 'Pause'}</button><button className="text-button neutral" disabled={busy} onClick={() => control('stop')}>Stop</button></> : <button className="text-button" onClick={onDismiss}>Dismiss</button>}</div>
  </aside>;
}
