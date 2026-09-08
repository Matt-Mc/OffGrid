import { useEffect, useState } from 'react';
import { EmptyState, ErrorMessage, Icon, Toggle, formatDate, validUrl } from './shared';
function ChannelRow({
  subscription,
  settings,
  online,
  onUpdate,
  onCheck,
  onUnfollow
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function act(action) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  const count = subscription.recentVideoCount ?? settings.recentVideoCount;
  const interval = subscription.checkIntervalHours ?? settings.checkIntervalHours;
  return <article className="channel-row">
    <div className="channel-avatar">
      {(subscription.channel || 'C').slice(0, 1).toUpperCase()}
    </div>
    <div className="channel-details">
      <h3>
        {subscription.channel}
      </h3>
      <p>{count} recent {count === 1 ? 'video' : 'videos'} per check · {settings.defaultQuality === 'best' ? 'Best available' : `Up to ${settings.defaultQuality}`}</p>
      <p className="channel-timing">{subscription.lastCheckedAt ? `Last checked ${formatDate(subscription.lastCheckedAt)}` : 'Not checked yet'} · {subscription.autoDownload && interval ? `Next check ${subscription.nextCheckAt ? formatDate(subscription.nextCheckAt) : `in ${interval} hours`}` : 'Manual checks'}</p>
      <ErrorMessage>
        {error || subscription.lastError}
      </ErrorMessage>
      <details className="channel-options">
        <summary>Channel options</summary>
        <div className="channel-option-controls">
          <label>Recent videos<select aria-label={`Recent videos for ${subscription.channel}`} value={count} disabled={busy} onChange={e => act(() => onUpdate(subscription.id, {
              recentVideoCount: Number(e.target.value)
            }))}>
              {[1, 3, 5, 10].map(n => <option key={n} value={n}>
                {n}
              </option>)}
            </select></label>
          <label>Check frequency<select aria-label={`Check frequency for ${subscription.channel}`} value={interval} disabled={busy} onChange={e => act(() => onUpdate(subscription.id, {
              checkIntervalHours: Number(e.target.value)
            }))}>
              {[[0, 'Manual'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Daily']].map(([value, label]) => <option key={value} value={value}>
                {label}
              </option>)}
            </select></label>
          <button className="text-button danger" disabled={busy} onClick={() => onUnfollow(subscription)}>Unfollow…</button>
        </div>
      </details>
    </div>
    <div className="channel-actions">
      <label>Auto-download <Toggle label={`Automatic downloads for ${subscription.channel}`} checked={subscription.autoDownload} disabled={busy} onChange={value => act(() => onUpdate(subscription.id, {
          autoDownload: value
        }))} /></label>
      <button className="secondary-button compact" disabled={busy || !online} onClick={() => act(() => onCheck(subscription.id))}>
        {busy ? 'Working…' : 'Check now'}
      </button>
    </div>
  </article>;
}
export function Following({
  subscriptions,
  settings,
  online,
  syncStatus,
  refresh,
  onUnfollow,
  followRequest
}) {
  const [channelUrl, setChannelUrl] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [automatic, setAutomatic] = useState(settings.autoDownload);
  const [initialCount, setInitialCount] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (followRequest) {
      setChannelUrl(followRequest.channelUrl || '');
      setShowForm(true);
      setAutomatic(settings.autoDownload);
    }
  }, [followRequest]);
  useEffect(() => {
    if (!showForm) setAutomatic(settings.autoDownload);
  }, [settings.autoDownload, showForm]);
  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!validUrl(channelUrl)) {
      setError('Enter a valid YouTube channel link.');
      return;
    }
    setBusy(true);
    try {
      await window.offgrid.subscribe({
        channelUrl: channelUrl.trim(),
        autoDownload: automatic,
        recentVideoCount: settings.recentVideoCount,
        checkIntervalHours: settings.checkIntervalHours,
        initialFetchCount: initialCount
      });
      await refresh();
      setChannelUrl('');
      setShowForm(false);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function check(id) {
    await window.offgrid.syncSubscriptions(id);
    await refresh();
  }
  async function checkAll() {
    setChecking(true);
    setError('');
    try {
      await check();
    } catch (error) {
      setError(error.message);
    } finally {
      setChecking(false);
    }
  }
  async function update(id, patch) {
    await window.offgrid.updateSubscription(id, patch);
    await refresh();
  }
  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">KEEP YOUR FAVORITES CLOSE</p>
        <h1>Following</h1>
        <p>Fresh videos from the channels you come back to.</p>
      </div>
      <button className="primary-button" onClick={() => setShowForm(!showForm)} aria-expanded={showForm}><Icon name="plus" size={16} /> Follow channel</button>
    </header>
    {showForm && <section className="follow-composer">
      <h2>Follow a channel</h2>
      <form onSubmit={submit}>
        <label className="form-field">YouTube channel link<input autoFocus type="url" placeholder="https://www.youtube.com/@channel" value={channelUrl} onChange={e => setChannelUrl(e.target.value)} required /></label>
        <div className="follow-form-options">
          <label className="form-field">Download now<select value={initialCount} onChange={e => setInitialCount(Number(e.target.value))}>
              <option value={0}>None — just follow</option>
              {[1, 3, 5, 10].map(n => <option key={n} value={n}>{n} recent {n === 1 ? 'video' : 'videos'}</option>)}
            </select></label>
          <label className="checkbox-label"><input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} /> Automatically check for recent videos</label>
        </div>
        <p className="section-note">{automatic ? `${settings.recentVideoCount} recent videos per check, ${settings.checkIntervalHours ? `every ${settings.checkIntervalHours} hours` : 'when you check manually'}. ` : ''}Downloads use your default quality and library limit. Automatic checks run while Offgrid is open and online.</p>
        <div className="form-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setShowForm(false)}>Cancel</button>
          <button className="primary-button" disabled={busy || !channelUrl || !online}>
            {busy ? 'Following…' : initialCount ? `Follow & queue ${initialCount}` : 'Follow channel'}
          </button>
        </div>
      </form>
    </section>}
    <ErrorMessage>
      {error}
    </ErrorMessage>
    {subscriptions.length ? <section className="following-list">
      <div className="section-heading">
        <h2>{subscriptions.length} followed {subscriptions.length === 1 ? 'channel' : 'channels'}</h2>
        <button className="text-button" disabled={checking || !online} onClick={checkAll}>
          {checking ? 'Checking channels…' : 'Check all now'}
        </button>
      </div>
      {syncStatus.message && syncStatus.status !== 'idle' && <div className={`info-banner ${syncStatus.status === 'error' ? 'attention' : ''}`} role="status">
        {syncStatus.message}
      </div>}
      <div>
        {subscriptions.map(subscription => <ChannelRow key={subscription.id} subscription={subscription} settings={settings} online={online} onUpdate={update} onCheck={check} onUnfollow={onUnfollow} />)}
      </div>
      <p className="section-note">Unfollowing a channel keeps all its saved videos. Manually deleted videos stay excluded from automatic downloads.</p>
    </section> : <EmptyState icon="follow" title="Good channels, always within reach">Follow a channel to check for recent videos, or let Offgrid queue them for you while the app is open.</EmptyState>}
  </>;
}
