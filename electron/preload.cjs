const { contextBridge, ipcRenderer } = require("electron");

function listen(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Expected an event callback.");
  const listener=(_event,payload)=>callback(payload);
  ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
}

contextBridge.exposeInMainWorld("offgrid", {
  getJellyfinConfig:()=>ipcRenderer.invoke('jellyfin:config'),
  requestJellyfinLocalAccess:baseUrl=>ipcRenderer.invoke('jellyfin:request-local-access',baseUrl),
  connectJellyfin:config=>ipcRenderer.invoke('jellyfin:connect',config),
  disconnectJellyfin:()=>ipcRenderer.invoke('jellyfin:disconnect'),
  jellyfinSections:()=>ipcRenderer.invoke('jellyfin:sections'),
  browseJellyfin:args=>ipcRenderer.invoke('jellyfin:browse',args),
  downloadJellyfin:id=>ipcRenderer.invoke('jellyfin:download',id),
  getPlexConfig:()=>ipcRenderer.invoke('plex:config'),
  requestPlexLocalAccess:baseUrl=>ipcRenderer.invoke('plex:request-local-access',baseUrl),
  openLocalNetworkSettings:()=>ipcRenderer.invoke('plex:open-local-settings'),
  connectPlex:config=>ipcRenderer.invoke('plex:connect',config),
  disconnectPlex:()=>ipcRenderer.invoke('plex:disconnect'),
  plexSections:()=>ipcRenderer.invoke('plex:sections'),
  browsePlex:args=>ipcRenderer.invoke('plex:browse',args),
  downloadPlex:id=>ipcRenderer.invoke('plex:download',id),
  playerStatus:()=>ipcRenderer.invoke('player:status'),
  playerState:()=>ipcRenderer.invoke('player:state'),
  openPlayer:id=>ipcRenderer.invoke('player:open',id),
  controlPlayer:action=>ipcRenderer.invoke('player:control',action),
  onPlayerUpdate:callback=>listen('player:update',callback),
  getSettings:()=>ipcRenderer.invoke("settings:get"),
  updateSettings:patch=>ipcRenderer.invoke("settings:update",patch),
  getStorage:()=>ipcRenderer.invoke("storage:get"),
  revealLibrary:()=>ipcRenderer.invoke("storage:reveal"),
  appVersion:()=>ipcRenderer.invoke("app:version"),
  listDownloads:()=>ipcRenderer.invoke("downloads:list"),
  setQueuePaused:paused=>ipcRenderer.invoke("downloads:pause",paused),
  cancelDownload:id=>ipcRenderer.invoke("downloads:cancel",id),
  retryDownload:(id,options={})=>ipcRenderer.invoke("downloads:retry",id,options),
  updateSubscription:(id,patch)=>ipcRenderer.invoke("subscriptions:update",id,patch),
  savePlayback:(id,progress)=>ipcRenderer.invoke("library:playback",id,progress),
  onQueueUpdate:callback=>listen("queue:update",callback),
  onStorageUpdate:callback=>listen("storage:update",callback),
  onSettingsUpdate:callback=>listen("settings:update",callback),
  onLibraryUpdate:callback=>listen("library:update",callback),
  onSettingsOpen:callback=>listen("settings:open",callback),
	listVideos: () => ipcRenderer.invoke("library:list"),
	startDownload: (url, quality) =>
		ipcRenderer.invoke("download:start", { url, quality }),
	estimateDownload: (url, quality) =>
		ipcRenderer.invoke("download:estimate", { url, quality }),
	toolStatus: () => ipcRenderer.invoke("tool:status"),
	updateTool: () => ipcRenderer.invoke("tool:update"),
	ffmpegStatus: () => ipcRenderer.invoke("ffmpeg:status"),
	updateFfmpeg: () => ipcRenderer.invoke("ffmpeg:update"),
	listSubscriptions: () => ipcRenderer.invoke("subscriptions:list"),
	subscriptionSyncStatus: () => ipcRenderer.invoke("subscriptions:sync-status"),
	subscribe: (data) => ipcRenderer.invoke("subscriptions:add", data),
	unsubscribe: (id) => ipcRenderer.invoke("subscriptions:remove", id),
	syncSubscriptions: (id) => ipcRenderer.invoke("subscriptions:sync", id),
	deleteVideo: (id) => ipcRenderer.invoke("library:delete", id),
	videoUrl: (id) => `media://video/${encodeURIComponent(id)}`,
	thumbnailUrl: (id) => `media://thumbnail/${encodeURIComponent(id)}`,
	onDownloadUpdate: (callback) => {
		const listener = (_event, update) => callback(update);
		ipcRenderer.on("download:update", listener);
		return () => ipcRenderer.removeListener("download:update", listener);
	},
	onToolUpdate: (callback) => {
		const listener = (_event, update) => callback(update);
		ipcRenderer.on("tool:update", listener);
		return () => ipcRenderer.removeListener("tool:update", listener);
	},
	onFfmpegUpdate: (callback) => {
		const listener = (_event, update) => callback(update);
		ipcRenderer.on("ffmpeg:update", listener);
		return () => ipcRenderer.removeListener("ffmpeg:update", listener);
	},
	onSubscriptionUpdate: (callback) => {
		const listener = (_event, update) => callback(update);
		ipcRenderer.on("subscription:update", listener);
		return () => ipcRenderer.removeListener("subscription:update", listener);
	},
	onSubscriptionSyncUpdate: (callback) => {
		const listener = (_event, update) => callback(update);
		ipcRenderer.on("subscription:sync-update", listener);
		return () =>
			ipcRenderer.removeListener("subscription:sync-update", listener);
	},
});
