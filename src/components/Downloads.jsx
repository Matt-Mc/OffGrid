import { useEffect, useRef, useState } from 'react';
import { BatchSelection, BatchResults, batchSummary, EmptyState, ErrorMessage, Icon, QualitySelect, SubtitleOptions, formatBytes, formatDuration, pendingStatuses, validUrl } from './shared';
const DRAFT_KEY = 'offgrid.download-composer.v1';
const MAX_DRAFT_LENGTH = 500 * 4097;
function readComposerDraft() {
  try {
    const raw=localStorage.getItem(DRAFT_KEY);
    if(!raw) return {};
    if(raw.length > MAX_DRAFT_LENGTH * 2) throw new Error('Draft too large');
    const value=JSON.parse(raw);
    if(value?.version !== 1) return {warning:'A saved draft could not be opened by this version of Offgrid.',preserve:true};
    if(typeof value.url !== 'string' || value.url.length > MAX_DRAFT_LENGTH || !['video','links','playlist'].includes(value.mode) || !['480p','720p','1080p','best'].includes(value.quality) || typeof value.language !== 'string' || value.language !== '' && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value.language) || typeof value.automatic !== 'boolean') throw new Error('Invalid saved draft');
    return value;
  }catch{return {warning:'Your saved draft could not be restored. Paste your links again.',preserve:true};}
}
const statusLabels = { queued: 'Queued', preparing: 'Preparing', downloading: 'Downloading', processing: 'Processing', complete: 'Ready to watch', error: 'Failed', canceled: 'Canceled', paused: 'Paused', 'waiting-storage': 'Waiting for space', 'waiting-network': 'Waiting for connection' };
function DownloadRow({ job, onAction, onManage, onPlay, videos }) {
  const [quality, setQuality] = useState(job.quality);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const recoverable = ['error','canceled','waiting-storage','waiting-network','paused'].includes(job.status);
  const active = ['preparing','downloading','processing'].includes(job.status);
  const server = ['plex','jellyfin'].includes(job.provider);
  const saved = videos.find(video => video.id === job.videoId || video.sourceId && video.sourceId === job.sourceId);
  async function act(action, options) {
    setBusy(true); setError('');
    try { await onAction(action, job.id, options); setDiscard(false); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  const canResume = job.resumable || job.status === 'paused';
  return <article className={`download-row status-${job.status}`}>
    <span className="job-glyph"><Icon name={job.status === 'complete' ? 'check' : 'download'} size={18} /></span>
    <div className="job-details"><div className="job-title"><h3>{job.title || job.url}</h3><span className={`status-label ${job.status}`}>{statusLabels[job.status] || job.status}</span></div>
      <p>{server ? `${job.copyQuality === '720p' ? 'Smaller copy · Up to 720p' : 'Original quality'} · ${job.provider === 'jellyfin' ? 'Jellyfin' : 'Plex'}` : job.quality === 'best' ? 'Best available' : `Up to ${job.quality}`} · {job.expectedBytes ? `About ${formatBytes(job.expectedBytes)}` : 'Size unavailable'}{job.source === 'subscription' ? ' · Followed channel' : ''}{job.saveComments ? ' · Comments included' : ''}</p>
      {active && <div className={`progress-track ${job.status !== 'downloading' ? 'indeterminate' : ''}`} role="progressbar" aria-label={statusLabels[job.status]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.status === 'downloading' ? Math.round(job.progress || 0) : undefined}><i style={{ width: `${Math.min(100,Math.max(0,job.progress || 0))}%` }} /></div>}
      {job.status === 'downloading' && <p className="progress-copy">{Math.round(job.progress || 0)}% downloaded{job.speedBytes ? ` · ${formatBytes(job.speedBytes)}/s` : ''}{Number.isFinite(job.etaSeconds) ? ` · ${Math.ceil(job.etaSeconds / 60)} min remaining` : ''}</p>}
      {job.message && job.status !== 'downloading' && <p className={['error','waiting-storage'].includes(job.status) ? 'job-message attention' : 'job-message'}>{job.error || job.message}</p>}
      {job.retainedBytes > 0 && <p className="section-note">{formatBytes(job.retainedBytes)} kept for this download. {job.resumeMessage || (job.resumable ? 'Resume to continue from saved progress.' : 'The source may require a fresh download.')}</p>}
      <ErrorMessage>{error}</ErrorMessage>
      {recoverable && <div className="recovery-actions">
        {job.status === 'waiting-storage' && <button className="text-button" onClick={onManage}>Manage storage</button>}
        {!server && <QualitySelect value={quality} onChange={setQuality} aria-label={`Retry quality for ${job.title}`} />}
        <button className="secondary-button compact" disabled={busy} onClick={() => act(canResume && (server || quality === job.quality) ? 'resume' : 'retry',server ? {} : {quality})}>{busy ? 'Working…' : canResume && (server || quality === job.quality) ? 'Resume' : 'Retry'}</button>
        {server && job.copyQuality === '720p' && <button className="text-button" disabled={busy} onClick={() => act('retry',{copyQuality:'original'})}>Keep original instead</button>}
        {!server && quality !== job.quality && job.retainedBytes > 0 && <span className="section-note">Changing quality starts a fresh download.</span>}
      </div>}
      {discard && <div className="discard-confirm" role="group" aria-label="Discard incomplete download"><p>Discard {formatBytes(job.retainedBytes)} of saved progress? You can download this video again later.</p><button className="text-button danger" disabled={busy} onClick={() => act('cancel')}>Discard download</button><button className="text-button" onClick={() => setDiscard(false)}>Keep progress</button></div>}
    </div>
    <div className="job-actions">{active && <button className="text-button" disabled={busy} onClick={() => act('pause')}>Pause</button>}{(pendingStatuses.includes(job.status) || job.retainedBytes > 0) && <button className="text-button neutral" disabled={busy} onClick={() => job.retainedBytes > 0 ? setDiscard(true) : act('cancel')}>{job.retainedBytes > 0 ? 'Discard…' : 'Cancel'}</button>}{saved && job.status === 'complete' && <button className="secondary-button compact" onClick={() => onPlay(saved)}><Icon name="play" size={13} /> Play</button>}</div>
  </article>;
}
export function Downloads({settings,queue,storage,online,onManage,onPlay,videos,refreshQueue,composerRequest,captures = {items:[]},onAcknowledgeCapture}) {
  const [savedDraft] = useState(readComposerDraft);
  const [draftWarning,setDraftWarning] = useState(savedDraft.warning || '');
  const [url,setUrl] = useState(savedDraft.url || '');
  const [mode,setMode] = useState(savedDraft.mode || 'video');
  const [quality,setQuality] = useState(savedDraft.quality || settings.defaultQuality);
  const [language,setLanguage] = useState(savedDraft.language ?? settings.defaultSubtitleLanguage ?? '');
  const [automatic,setAutomatic] = useState(savedDraft.automatic ?? !!settings.allowAutoCaptions);
  const [estimate,setEstimate] = useState(null);
  const [estimateState,setEstimateState] = useState('idle');
  const [estimateError,setEstimateError] = useState('');
  const [preview,setPreview] = useState(null);
  const [selected,setSelected] = useState([]);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [queueBusy,setQueueBusy] = useState(false);
  const [confirmation,setConfirmation] = useState('');
  const [batchResults,setBatchResults] = useState([]);
  const input = useRef(null);
  const generation = useRef(0);
  const previewRequest = useRef(null);
  const previewGeneration = useRef(0);
  const options = {subtitleLanguages:language ? [language] : [],allowAutoCaptions:automatic};
  const draftWritten=useRef(false);
  useEffect(() => {
    if(savedDraft.preserve && !url && !draftWritten.current) return;
    try {
      if(url.length > MAX_DRAFT_LENGTH) {setDraftWarning('This draft is too large to keep after restart. Use up to 500 links.');return;}
      if(url) localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,url,mode,quality,language,automatic}));
      else localStorage.removeItem(DRAFT_KEY);
      draftWritten.current=true;setDraftWarning('');
    }catch{setDraftWarning('This draft could not be saved on this Mac. Keep your links until they are queued.');}
  },[url,mode,quality,language,automatic,savedDraft]);
  useEffect(() => { if(!url) {setQuality(settings.defaultQuality);setLanguage(settings.defaultSubtitleLanguage || '');setAutomatic(!!settings.allowAutoCaptions);} },[settings.defaultQuality,settings.defaultSubtitleLanguage,settings.allowAutoCaptions,url]);
  useEffect(() => {if(composerRequest) input.current?.focus();},[composerRequest]);
  useEffect(() => {
    setPreview(null); setSelected([]); previewGeneration.current++;
    const id = previewRequest.current; previewRequest.current = null;
    if(id) window.offgrid.cancelPreview?.(id).catch(() => {});
    return () => { const pending = previewRequest.current; previewGeneration.current++; if(pending) window.offgrid.cancelPreview?.(pending).catch(() => {}); };
  },[url,quality,mode,language,automatic]);
  useEffect(() => {
    const request = ++generation.current; setEstimate(null);setEstimateError('');setEstimateState('idle');
    if(mode !== 'video' || !validUrl(url) || !online) return;
    setEstimateState('loading');
    const timeout = setTimeout(async() => {
      try {const result = await window.offgrid.estimateDownload(url.trim(),quality);if(request === generation.current){setEstimate(result);setEstimateState('ready');}}
      catch(error){if(request === generation.current){setEstimateState('error');setEstimateError(error.message || 'Could not read video details.');}}
    },600);
    return () => {clearTimeout(timeout);generation.current++;};
  },[url,quality,online,mode]);
  async function loadPreview(more = false) {
    const current = ++previewGeneration.current;
    const requestId = crypto.randomUUID(); previewRequest.current = requestId;
    setBusy(true);setError('');setConfirmation('');
    try {
      const result = await window.offgrid.previewDownloads({input:url.trim(),mode:mode === 'playlist' ? 'playlist' : 'video',quality,start:more ? (preview.nextStart ?? preview.start + preview.items.length) : 0,...options,requestId});
      if(current !== previewGeneration.current) return;
      const seen=new Set(more ? preview.items.map(item=>item.id) : []);
      const fresh=result.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});
      const items=more ? [...preview.items,...fresh] : fresh;
      setPreview({...result,items}); if(!more) setSelected([]);
    } catch(error) {if(current === previewGeneration.current) setError(error.message);}
    finally {if(previewRequest.current === requestId) {previewRequest.current = null;setBusy(false);}}
  }
  async function submit(event) {
    event.preventDefault();setError('');setConfirmation('');
    if(mode !== 'video') return loadPreview();
    if(!validUrl(url)){setError('Enter a valid YouTube video link.');return;}
    setBusy(true);
    try {const result = await window.offgrid.startDownload(url.trim(),quality,options);setUrl('');setConfirmation(result?.alreadySaved ? 'This video is already in your library.' : result?.accepted === false ? 'This video is already in the queue.' : 'Added to your download queue.');await refreshQueue();}
    catch(error){setError(error.message);}finally{setBusy(false);}
  }
  async function addBatch() {
    setBusy(true);setError('');
    try {
      const result = await window.offgrid.addDownloadBatch({urls:preview.items.filter(item => selected.includes(item.id)).map(item => item.url),quality,...options});
      setConfirmation(batchSummary(result));setBatchResults(result.results);setSelected([]);
      setPreview(current => ({...current,items:current.items.map(item => {
        const index = preview.items.filter(entry => selected.includes(entry.id)).findIndex(entry => entry.id === item.id);
        const outcome = index >= 0 ? result.results[index] : null;
        return outcome ? {...item,outcome:outcome.outcome === 'added' ? 'alreadyQueued' : outcome.outcome,reason:outcome.reason} : item;
      })}));await refreshQueue();
    }catch(error){setError(error.message);}finally{setBusy(false);}
  }
  async function act(action,...args) {await window.offgrid[{retry:'retryDownload',resume:'resumeDownload',pause:'pauseDownload',cancel:'cancelDownload'}[action]](...args);await refreshQueue();}
  async function toggleQueue(){setQueueBusy(true);setError('');try{await window.offgrid.setQueuePaused(!queue.paused);await refreshQueue();}catch(error){setError(error.message);}finally{setQueueBusy(false);}}
  async function capture(item,open){
    setError('');
    try {
      if(open){
        const nextMode=new URL(item.url).pathname === '/playlist' ? 'playlist' : 'video';
        // Persist the review draft before acknowledging the durable inbox entry.
        localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,url:item.url,mode:nextMode,quality,language,automatic}));
        setUrl(item.url);setMode(nextMode);input.current?.focus();
      }
      await onAcknowledgeCapture(item.id);
    }catch(error){setError(error.message);}
  }
  const pending = queue.jobs.filter(job => pendingStatuses.includes(job.status));
  const history = queue.jobs.filter(job => !pendingStatuses.includes(job.status));
  return <>
    <header className="page-header"><div><p className="eyebrow">PREPARE FOR YOUR NEXT TRIP</p><h1>Downloads</h1><p>Add a link now. Watch wherever you end up.</p></div>{queue.jobs.length > 0 && <button className="secondary-button" disabled={queueBusy} onClick={toggleQueue}>{queue.paused ? 'Resume queue' : 'Stop after current'}</button>}</header>
    {(captures.items?.length > 0 || captures.warning) && <section className="capture-inbox" aria-label="Links sent to Offgrid"><div className="section-heading"><h2>Sent to Offgrid</h2><span>{captures.items?.length || 0} waiting</span></div>{url && <p className="section-note">Finish or clear your current draft to open another link.</p>}{captures.warning && <p className="estimate-warning">{captures.warning}</p>}{captures.items?.map(item => <div className="capture-item" key={item.id}><span>{item.url}</span><button className="secondary-button compact" disabled={!!url || busy} onClick={() => capture(item,true)}>Open</button><button className="text-button" disabled={busy} onClick={() => capture(item,false)}>Dismiss</button></div>)}</section>}
    <section className="download-composer"><div className="section-heading"><h2>Add a video</h2><select aria-label="Link type" value={mode} disabled={busy} onChange={event => setMode(event.target.value)}><option value="video">Single video</option><option value="links">Multiple links</option><option value="playlist">YouTube playlist</option></select></div>
      <form onSubmit={submit}><div className="download-form"><label className="form-field grow">{mode === 'links' ? 'YouTube links' : 'YouTube link'}{mode === 'links' ? <textarea ref={input} rows={3} placeholder="Paste one video link per line" value={url} disabled={busy} onChange={event => {setUrl(event.target.value);setConfirmation('');}} required /> : <input ref={input} type="url" placeholder={mode === 'playlist' ? 'Paste a playlist link' : 'Paste a video link'} value={url} disabled={busy} onChange={event => {setUrl(event.target.value);setConfirmation('');}} required />}</label><label className="form-field">Quality<QualitySelect value={quality} onChange={setQuality} disabled={busy} /></label><button className="primary-button" type="submit" disabled={busy || !url.trim()}><Icon name="plus" size={16}/>{busy ? 'Working…' : mode === 'video' ? 'Add to queue' : 'Preview videos'}</button></div>
        <details className="composer-options"><summary>Subtitle options{language ? ` · ${language}` : ''}</summary><SubtitleOptions language={language} onLanguage={setLanguage} automatic={automatic} onAutomatic={setAutomatic} disabled={busy}/><p className="section-note">Save available text subtitles for offline playback. Automatic captions are optional.</p></details>
        <div className="composer-note"><span>{quality === settings.defaultQuality ? 'Using your default quality' : 'Quality override'} · {settings.saveComments ? 'Save available comments' : 'Without comments'}</span>{url && <button type="button" className="text-button" disabled={busy} onClick={() => {setUrl('');setConfirmation('');}}>Clear draft</button>}</div>
      </form>
      {mode === 'video' && /[?&]list=/.test(url) && <p className="section-note">This link includes a playlist. Only the current video will be added. <button type="button" className="text-button" disabled={busy} onClick={() => setMode('playlist')}>Preview playlist instead</button></p>}
      {mode === 'video' && estimateState === 'loading' && <div className="estimate-preview" role="status">Reading video details…</div>}
      {mode === 'video' && estimate && <div className="estimate-preview"><Icon name="play" size={18}/><div><strong>{estimate.title || 'Video details'}</strong><p>{estimate.duration ? `${formatDuration(estimate.duration)} · ` : ''}{estimate.expectedBytes ? `Estimated download: ${formatBytes(estimate.expectedBytes)}` : 'Size unavailable'} · Final size may vary</p></div></div>}
      {estimateError && mode === 'video' && <p className="estimate-warning">Size unavailable. {estimateError} You can still add this video to the queue.</p>}
      {busy && previewRequest.current && <p className="section-note" role="status">Reading videos… <button className="text-button" onClick={() => {const id = previewRequest.current;previewGeneration.current++;previewRequest.current = null;setBusy(false);if(id) window.offgrid.cancelPreview(id).catch(() => {});}}>Cancel preview</button></p>}
      {preview && <BatchSelection preview={preview} selected={selected} onSelected={setSelected} busy={busy} onAdd={addBatch} onMore={() => loadPreview(true)} onClose={() => setPreview(null)}/>}
      {draftWarning && <p className="estimate-warning" role="status">{draftWarning}</p>}
      <BatchResults results={batchResults}/>
      <ErrorMessage>{error}</ErrorMessage>{confirmation && <p className="success-message" role="status"><Icon name="check" size={14}/>{confirmation}</p>}
    </section>
    {pending.length > 0 && storage?.queueProjection && <p className="section-note">Queue space: about {formatBytes(storage.queueProjection.additionalPeakBytes)} more at its largest{storage.queueProjection.unknownCount ? ` · ${storage.queueProjection.unknownCount} sizes still unknown` : ''}. {storage.queueProjection.fits === false ? 'Some downloads will wait for more storage.' : 'Includes temporary processing space; final sizes may vary.'}</p>}
    {queue.warning && <p className="estimate-warning" role="status">{queue.warning}</p>}
    {queue.paused && <div className="info-banner">The queue is stopped. Any current download will finish; waiting videos stay queued.</div>}
    {!queue.jobs.length ? <EmptyState icon="download" title="A clear queue, a little more freedom">Paste a link above to save a video. Downloads stay here so you can check progress or retry later.</EmptyState> : [[pending,'In the queue'],[history,'Recent activity']].map(([jobs,title]) => jobs.length > 0 && <section className="queue-section" key={title}><div className="section-heading"><h2>{title}</h2><span>{jobs.length} {jobs.length === 1 ? 'video' : 'videos'}</span></div><div className="queue-list">{jobs.map(job => <DownloadRow key={job.id} job={job} onAction={act} onManage={onManage} onPlay={onPlay} videos={videos}/>)}</div></section>)}
  </>;
}
