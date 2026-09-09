import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Library, Player, ExternalPlayer } from './components/Library';
import { Downloads } from './components/Downloads';
import { Following } from './components/Following';
import { Settings } from './components/Settings';
import { Servers } from './components/Plex';
import { AppUpdateBanner } from './components/AppUpdates';
import { ConfirmDialog, Icon, StorageBar, formatBytes, pendingStatuses } from './components/shared';
import './styles.css';
const defaultSettings = {
  version: 1,
  defaultQuality: '720p',
  saveComments: false,
  maxLibraryBytes: null,
  autoDownload: false,
  checkIntervalHours: 6,
  recentVideoCount: 3
};
function App() {
  const [view, setView] = useState('library');
  const [serverProvider, setServerProvider] = useState('plex');
  const [loaded, setLoaded] = useState(false);
  const [videos, setVideos] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [storage, setStorage] = useState(null);
  const [queue, setQueue] = useState({
    jobs: [],
    paused: false
  });
  const [subscriptions, setSubscriptions] = useState([]);
  const [syncStatus, setSyncStatus] = useState({
    status: 'idle'
  });
  const [tool, setTool] = useState({
    status: 'checking',
    message: 'Checking downloader…'
  });
  const [ffmpeg, setFfmpeg] = useState({
    status: 'checking',
    message: 'Checking video processing…'
  });
  const [version, setVersion] = useState('');
  const [appUpdate,setAppUpdate]=useState({check:{state:'idle'},download:{state:'idle'}});
  const [dismissedUpdate,setDismissedUpdate]=useState(null);
  const [selected, setSelected] = useState(null);
  const [player, setPlayer] = useState({ available: false, message: 'Checking player…' });
  const [playback, setPlayback] = useState({ status: 'idle' });
  const [playerOpening, setPlayerOpening] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState('');
  const [storageRequest, setStorageRequest] = useState(0);
  const [composerRequest, setComposerRequest] = useState(0);
  const [followRequest, setFollowRequest] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const loadGeneration = useRef(0);
  const deletingIds = useRef(new Set());
  const api = window.offgrid;
  const refreshQueue = useCallback(async () => setQueue(await window.offgrid.listDownloads()), []);
  const refreshSubscriptions = useCallback(async () => setSubscriptions(await window.offgrid.listSubscriptions()), []);
  const refreshPlayer = useCallback(async () => {
    const result = window.offgrid.playerStatus ? await window.offgrid.playerStatus() : { available: false, message: 'mpv is not available.' };
    setPlayer(result);
    return result;
  }, []);
  const refreshStorage = useCallback(async () => setStorage(await window.offgrid.getStorage()), []);
  useEffect(() => {
    if (!api) {
      setError('Open Offgrid in the desktop app to access your local video library.');
      return;
    }
    let alive = true;
    const generation = ++loadGeneration.current;
    const initial = [[api.listVideos, setVideos], [api.getSettings, setSettings], [api.getStorage, setStorage], [api.listDownloads, setQueue], [api.listSubscriptions, setSubscriptions], [api.subscriptionSyncStatus, setSyncStatus], [api.toolStatus, setTool], [api.ffmpegStatus, setFfmpeg], [api.appVersion, setVersion]];
    if (api.playerStatus) initial.push([api.playerStatus, setPlayer]);
    if (api.playerState) initial.push([api.playerState, setPlayback]);
    if (api.appUpdateStatus) initial.push([api.appUpdateStatus,setAppUpdate]);
    Promise.allSettled(initial.map(async ([read, write]) => {
      const result = await read();
      if (alive && generation === loadGeneration.current) write(result);
    })).then(results => {
      if (!alive) return;
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) setError(`Some app data could not be loaded: ${failed.map(result => result.reason.message).join(' · ')}`);
      setLoaded(true);
    });
    const listeners = [api.onQueueUpdate(setQueue), api.onSettingsUpdate(setSettings), api.onStorageUpdate(setStorage), api.onLibraryUpdate(setVideos), api.onSubscriptionUpdate(setSubscriptions), api.onSubscriptionSyncUpdate(setSyncStatus), api.onToolUpdate(setTool), api.onFfmpegUpdate(setFfmpeg), api.onSettingsOpen(() => setView('settings'))];
    if (api.onPlayerUpdate) listeners.push(api.onPlayerUpdate(setPlayback));
    if (api.onPlayerAvailability) listeners.push(api.onPlayerAvailability(setPlayer));
    if (api.onAppUpdate) listeners.push(api.onAppUpdate(setAppUpdate));
    const updateOnline = () => {
      setOnline(navigator.onLine);
      if(navigator.onLine) api.checkAppUpdate?.(true).then(setAppUpdate).catch(()=>{});
    };
    const shortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setView('settings');
      }
    };
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    window.addEventListener('keydown', shortcut);
    const interval = setInterval(() => refreshStorage().catch(() => {}), 15000);
    return () => {
      alive = false;
      listeners.forEach(remove => remove());
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
      window.removeEventListener('keydown', shortcut);
      clearInterval(interval);
    };
  }, []);
  function addVideo() {
    setView('downloads');
    setComposerRequest(value => value + 1);
  }
  function manageStorage() {
    setView('settings');
    setStorageRequest(value => value + 1);
  }
  async function openVideo(video) {
    if (playerOpening) return;
    setPlayerOpening(true);
    setError('');
    try {
      const status = await refreshPlayer();
      if (status.available) {
        setSelected(null);
        if (view === 'player') setView('library');
        await api.openPlayer(video.id);
        setPlayback(await api.playerState());
      } else if (['plex', 'jellyfin'].includes(video.provider)) {
        setError(`Server downloads play in mpv. ${status.message || 'Refresh the player in Settings to check its availability.'}`);
        setView('settings');
      } else {
        setSelected(video);
        setView('player');
      }
    } catch (error) { setError(error.message); }
    finally { setPlayerOpening(false); }
  }
  function followVideo(video) {
    setFollowRequest({
      channelUrl: video.channelUrl,
      requestedAt: Date.now()
    });
    setView('following');
  }
  async function saveSettings(patch) {
    const result = await api.updateSettings(patch);
    setSettings(result);
    await refreshStorage();
  }
  async function saveProgress(id, progress, playbackError) {
    if (deletingIds.current.has(id)) return;
    if (playbackError) {
      setError(playbackError);
      return;
    }
    setVideos(current => current.map(video => video.id === id ? {
      ...video,
      playbackPositionSeconds: progress.positionSeconds,
      watched: progress.watched
    } : video));
    setSelected(current => current?.id === id ? {
      ...current,
      playbackPositionSeconds: progress.positionSeconds,
      watched: progress.watched
    } : current);
    try {
      await api.savePlayback(id, progress);
    } catch (error) {
      setError(`Could not save playback progress: ${error.message}`);
    }
  }
  async function markWatched(video, watched) {
    try {
      await api.savePlayback(video.id, {
        positionSeconds: watched ? video.duration || 0 : 0,
        watched
      });
      setVideos(await api.listVideos());
      setSelected(current => current?.id === video.id ? {
        ...current,
        watched,
        playbackPositionSeconds: watched ? video.duration || 0 : 0
      } : current);
    } catch (error) {
      setError(error.message);
    }
  }
  function requestDelete(items) {
    if (!items.length) return;
    setConfirmError('');
    setConfirmation({
      type: 'videos',
      items,
      title: items.length === 1 ? `Delete “${items[0].title}”?` : `Delete ${items.length} videos?`,
      description: `This permanently removes ${formatBytes(items.reduce((sum, video) => sum + (video.deletionBytes ?? video.sizeBytes ?? 0), 0))} of video and thumbnails, together with associated metadata. ${items.length === 1 ? 'This video' : 'These videos'} will stay excluded from automatic channel downloads.`,
      action: 'Delete permanently'
    });
  }
  function requestUnfollow(subscription) {
    setConfirmError('');
    setConfirmation({
      type: 'follow',
      subscription,
      title: `Unfollow ${subscription.channel}?`,
      description: 'Automatic checks for this channel will stop. Its saved videos stay in your library.',
      action: 'Unfollow'
    });
  }
  async function confirmAction() {
    setConfirmBusy(true);
    setConfirmError('');
    try {
      if (confirmation.type === 'videos') {
        for (const video of confirmation.items) {
          // Suppress late player callbacks while the file is being removed.
          deletingIds.current.add(video.id);
          if (selected?.id === video.id) {
            setSelected(null);
            if (view === 'player') setView('library');
          }
          if (playback.videoId === video.id && api.controlPlayer) await api.controlPlayer('stop');
          await api.deleteVideo(video.id);
        }
        setVideos(await api.listVideos());
        await refreshStorage();
      } else {
        await api.unsubscribe(confirmation.subscription.id);
        await refreshSubscriptions();
      }
      setConfirmation(null);
    } catch (error) {
      setConfirmError(error.message);
      const remainingVideos = await api.listVideos();
      setVideos(remainingVideos);
      remainingVideos.forEach(video => deletingIds.current.delete(video.id));
    } finally {
      setConfirmBusy(false);
    }
  }
  async function updateTool(kind) {
    const result = await (kind === 'tool' ? api.updateTool() : api.updateFfmpeg());
    if (result?.status) (kind === 'tool' ? setTool : setFfmpeg)(result);
  }
  async function appUpdateAction(action) {
    try {setAppUpdate(await api[action]());}
    catch {setAppUpdate(current=>({...current,download:{state:'error',message:'The update could not be completed. Try again when you’re online.'}}));}
  }
  const externalActive = ['starting', 'playing', 'paused'].includes(playback.status);
  const externalVideo = videos.find(video => video.id === playback.videoId);
  const activeCount = queue.jobs.filter(job => pendingStatuses.includes(job.status)).length;
  const used = (storage?.savedBytes || 0) + (storage?.temporaryBytes || 0);
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <span className="brand-glyph" />
        </span>
        <span>Offgrid</span>
      </div>
      <p className="sidebar-label">YOUR SPACE</p>
      <nav className="primary-nav" aria-label="Main navigation">
        {[["library", "Library", videos.length], ["downloads", "Downloads", activeCount], ["following", "Following", subscriptions.length], ["servers", "Servers", 0]].map(([destination, label, count]) => <button key={destination} className={`nav-item ${view === destination || destination === 'library' && view === 'player' ? 'active' : ''}`} aria-current={view === destination || destination === 'library' && view === 'player' ? 'page' : undefined} onClick={() => setView(destination)}>
          <Icon name={destination === 'downloads' ? 'download' : destination === 'following' ? 'follow' : destination === 'servers' ? 'folder' : destination} />
          <span>
            {label}
          </span>
          {count > 0 && <b>
            {count}
          </b>}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className={`connection-state ${online ? '' : 'offline'}`}>
          <span className="connection-dot" />
          {online ? 'Ready for your next trip' : 'Offline · library available'}
        </div>
        <button className="sidebar-storage" onClick={manageStorage}>
          <span>
            <strong>
              {formatBytes(used)}
            </strong>
            <small>
              {storage?.maxLibraryBytes ? `of ${formatBytes(storage.maxLibraryBytes)}` : 'saved locally'}
            </small>
          </span>
          <StorageBar storage={storage} />
        </button>
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')}>
          <Icon name="settings" />
          <span>Settings</span>
          <kbd>⌘ ,</kbd>
        </button>
      </div>
    </aside>
    <main className={`main-content ${externalActive || playback.error ? 'with-external-player' : ''} ${selected && view !== 'player' ? 'with-mini-player' : ''}`}>
      {appUpdate.check.state==='available' && appUpdate.check.release?.version!==dismissedUpdate && <AppUpdateBanner update={appUpdate}
        onDownload={()=>appUpdateAction('downloadAppUpdate')} onCancel={()=>appUpdateAction('cancelAppUpdate')}
        onDismiss={()=>setDismissedUpdate(appUpdate.check.release.version)}/>}
      {!online && <div className="offline-banner">
        <Icon name="offline" size={17} />
        <span>You’re offline. Saved videos are ready to watch, and your media servers can still work on your local network.</span>
      </div>}
      {error && <div className="app-error" role="alert">
        <p>
          {error}
        </p>
        <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
          <Icon name="close" size={16} />
        </button>
      </div>}
      {!loaded && api && <p className="loading-message" role="status">Opening your library…</p>}
      {loaded && <>
        <section className="screen" hidden={view !== 'library'} aria-label="Library">
          <Library videos={videos} onAdd={addVideo} onPlay={openVideo} onDelete={requestDelete} onWatched={markWatched} />
        </section>
        <section className="screen" hidden={view !== 'downloads'} aria-label="Downloads">
          <Downloads settings={settings} queue={queue} online={online} onManage={manageStorage} onPlay={openVideo} videos={videos} refreshQueue={refreshQueue} composerRequest={composerRequest} />
        </section>
        <section className="screen" hidden={view !== 'following'} aria-label="Following">
          <Following subscriptions={subscriptions} settings={settings} online={online} syncStatus={syncStatus} refresh={refreshSubscriptions} onUnfollow={requestUnfollow} followRequest={followRequest} />
        </section>
        {view === 'servers' && <Servers provider={serverProvider} onProviderChange={setServerProvider} onDownloads={() => setView('downloads')} />}
        <section className="screen" hidden={view !== 'settings'} aria-label="Settings">
          <Settings settings={settings} storage={storage} videos={videos} queue={queue} onSave={saveSettings} onDelete={requestDelete} storageRequest={storageRequest} tool={tool} ffmpeg={ffmpeg} version={version} onUpdateTool={updateTool} player={player} onRefreshPlayer={refreshPlayer}
            appUpdate={appUpdate} onCheckAppUpdate={()=>appUpdateAction('checkAppUpdate')} onDownloadAppUpdate={()=>appUpdateAction('downloadAppUpdate')} onCancelAppUpdate={()=>appUpdateAction('cancelAppUpdate')}/>
        </section>
      </>}
      {playerOpening && <p className="player-opening" role="status">Opening player…</p>}
      {(externalActive || playback.error) && <ExternalPlayer video={externalVideo} state={playback} onDismiss={() => setPlayback({ status: 'idle' })} />}
      {selected && <Player key={selected.id} video={selected} full={view === 'player'} onExpand={() => setView('player')} onBack={() => setView('library')} onClose={() => {
        setSelected(null);
        if (view === 'player') setView('library');
      }} onProgress={saveProgress} onFollow={followVideo} />}
    </main>
    <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={confirmAction} busy={confirmBusy} error={confirmError} />
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
