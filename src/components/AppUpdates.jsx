import { Icon } from './shared';

export function updateDescription(update) {
  const check=update?.check || {}, download=update?.download || {};
  if(download.state==='downloading') return `Downloading the installer… ${Math.round((download.progress || 0)*100)}%`;
  if(download.state==='error') return download.message || 'The update could not be downloaded. Try again when you’re online.';
  if(download.state==='ready') return 'The installer is ready. Quit Offgrid, then drag the new copy into Applications to finish updating.';
  if(check.state==='available') return 'Download and open the installer, then drag Offgrid into Applications. Your saved library stays in place.';
  if(check.state==='checking') return 'Checking GitHub for a newer release…';
  if(check.state==='up-to-date') return 'You have the latest release.';
  if(check.state==='unsupported') return check.message || 'An installer is not available for this system.';
  if(check.state==='unavailable') return 'Couldn’t reach a compatible release. You can keep watching offline and check again later.';
  return 'Packaged apps check GitHub at startup when online. Checks never interrupt offline playback.';
}

export function UpdateAction({update,onDownload,onCancel,onCheck}) {
  const check=update?.check || {}, download=update?.download || {};
  if(download.state==='downloading') return <button className="secondary-button compact" onClick={onCancel}>Cancel download</button>;
  if(check.state==='available') return <button className="primary-button compact" onClick={onDownload}>
    <Icon name="download" size={15}/>{download.state==='ready' ? 'Open installer' : `Update to ${check.release.version}`}
  </button>;
  return <button className="secondary-button compact" disabled={check.state==='checking'} onClick={onCheck}>{check.state==='checking' ? 'Checking…' : 'Check for updates'}</button>;
}

export function AppUpdateBanner({update,onDownload,onCancel,onDismiss}) {
  const version=update?.check?.release?.version;
  return <div className="app-update-banner" role="status">
    <div><strong>Offgrid {version} is available</strong><p>{updateDescription(update)}</p>
      {update.download?.state==='downloading' && <progress aria-label="Update download" max="1" value={update.download.progress || 0}/>}
    </div>
    <UpdateAction update={update} onDownload={onDownload} onCancel={onCancel}/>
    <button className="icon-button" aria-label="Remind me next time" title="Remind me next time" onClick={onDismiss}><Icon name="close" size={16}/></button>
  </div>;
}
