const { app, BrowserWindow, ipcMain, protocol, net, Menu, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const crypto = require("node:crypto");
const https = require("node:https");
const readline = require("node:readline");
const { QUALITIES, DISK_RESERVE_BYTES, atomicWriteJson, readJson, defaultSettings,
  validateSettings, getExpectedSize, directoryBytes, checkStorageAdmission,
  sourceIdFromUrl, DurableQueue } = require("./backend-core.cjs");
const { PlexConnection } = require('./plex-connection.cjs');
const { JellyfinConnection } = require('./jellyfin-connection.cjs');
const { normalizeServerUrl: normalizeJellyfinUrl } = require('./jellyfin-client.cjs');
const { createMpvPlayer } = require('./mpv-player.cjs');
const { requestLocalNetworkAccess } = require('./local-network.cjs');
const mediaServers = {
  plex: { name: 'Plex', connection: null, busy: false, revision: 0 },
  jellyfin: { name: 'Jellyfin', connection: null, busy: false, revision: 0 },
};
let localAccessController = null;
let player;
let settings;
let settingsPath;
let dataDirectory;
let workDirectory;
let deletedSourcesPath;
let deletedSources = [];
let queue;
const testMode = process.env.OFFGRID_TEST_MODE === "1";
if(process.env.OFFGRID_DATA_DIR) {
  const isolatedDirectory=path.resolve(process.env.OFFGRID_DATA_DIR);
  fs.mkdirSync(isolatedDirectory,{recursive:true});
  app.setPath("userData",isolatedDirectory);
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function assertActive(id, active = queue?.active) {
  if (!active || queue?.active !== active || active.id !== id || active.stopReason)
    throw new Error(active?.stopReason?.message || "This download is no longer active.");
}
async function awaitWhileActive(active, start) {
  assertActive(active.id,active);
  const result=await Promise.race([
    start(),
    active.stopped.then(reason=>{throw new Error(reason.message);}),
  ]);
  assertActive(active.id,active);
  return result;
}
function trackedSpawn(id, command, args) {
  assertActive(id);
  const child = spawn(command, args, { detached: process.platform !== "win32" });
  const active = queue?.active?.id === id ? queue.active : null;
  active?.children.add(child);
  child.on("close", () => active?.children.delete(child));
  child.on("error", () => active?.children.delete(child));
  return child;
}
function videoView(video) {
  let deletionBytes=0;
  for(const file of [video.filePath,video.thumbnailPath]) {
    try {if(file) deletionBytes+=fs.statSync(file).size;} catch(error) {if(error.code!=="ENOENT") throw error;}
  }
  return {...video,deletionBytes};
}
function libraryViews() {return library.map(videoView);}
function storageSnapshot() {
  let savedBytes = 0;
  for (const video of library) {
    for (const file of [video.filePath, video.thumbnailPath]) {
      if (file && fs.existsSync(file)) savedBytes += fs.statSync(file).size;
    }
  }
  const allMedia = directoryBytes(mediaDirectory) + directoryBytes(thumbnailsDirectory);
  let freeBytes = null;
  try { const disk = fs.statfsSync(dataDirectory); freeBytes = Number(disk.bavail) * Number(disk.bsize); } catch {}
  return {savedBytes, temporaryBytes:Math.max(0,allMedia-savedBytes),
    supportBytes:Math.max(0,directoryBytes(dataDirectory)-allMedia), freeBytes,
    maxLibraryBytes:settings.maxLibraryBytes, libraryPath:dataDirectory,
    diskReserveBytes:DISK_RESERVE_BYTES};
}
function emitStorage() { broadcast("storage:update",storageSnapshot()); }
function storageViolation() {
  const storage = storageSnapshot();
  if (storage.freeBytes === null || storage.freeBytes < DISK_RESERVE_BYTES) return "The 2 GB free disk reserve was reached. Free disk space and retry.";
  if (storage.maxLibraryBytes !== null && storage.savedBytes + storage.temporaryBytes > storage.maxLibraryBytes)
    return "The library limit was reached. Free space, lower quality or increase the limit, then retry.";
  return null;
}
function cleanupJob(job) {
  if (!/^[a-f0-9-]{36}$/.test(job.id) || library.some(video=>video.id===job.id)) return;
  // A UUID job directory and exact UUID output names establish ownership.
  fs.rmSync(path.join(workDirectory,job.id),{recursive:true,force:true});
  for (const directory of [mediaDirectory,thumbnailsDirectory]) {
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(`${job.id}.`) && fs.lstatSync(path.join(directory,name)).isFile()) fs.unlinkSync(path.join(directory,name));
    }
  }
}
function cancelPendingAutomaticJobs(subscriptionId, message) {
  for(const job of queue.jobs) {
    if(job.subscriptionId===subscriptionId && !job.manualTrigger && !job.explicitRetry && ["queued","waiting-storage","waiting-network"].includes(job.status)) {
      cleanupJob(job);
      queue.update(job.id,{status:"canceled",message,error:null});
    }
  }
}
function subscriptionView(subscription) {
  const interval = subscription.checkIntervalHours ?? settings.checkIntervalHours;
  return {...subscription,checkIntervalHours:interval,
    nextCheckAt:subscription.autoDownload && interval > 0 ? new Date((Date.parse(subscription.lastCheckedAt || subscription.addedAt)||Date.now())+interval*3600000).toISOString() : null};
}
function subscriptionViews() { return subscriptions.map(subscriptionView); }
function canRunJob(job) {
  if(mediaServers[job.provider]?.busy) return false;
  if (job.source === "manual" || job.manualTrigger || job.explicitRetry) return true;
  return subscriptions.some(subscription=>subscription.id===job.subscriptionId && subscription.autoDownload);
}
function queueVideo(args, source = "manual", extra = {}) {
  if (!args || !isSupportedUrl(args.url)) throw new Error("Paste a valid YouTube video URL.");
  const quality = args.quality ?? settings.defaultQuality;
  if (!QUALITIES.includes(quality)) throw new Error("Invalid download quality.");
  const sourceId = extra.sourceId || sourceIdFromUrl(args.url);
  const existing=library.find(video=>(sourceId && video.sourceId===sourceId) || video.url===args.url);
  if(existing) return {accepted:false,alreadySaved:true,videoId:existing.id};
  if(source === "manual" && sourceId && deletedSources.includes(sourceId)) {
    deletedSources=deletedSources.filter(id=>id!==sourceId); atomicWriteJson(deletedSourcesPath,deletedSources);
  }
  const job=queue.add({url:args.url,quality,saveComments:settings.saveComments,source,sourceId,title:extra.title || "YouTube video",...extra});
  return {accepted:true,id:job.id,job};
}

const YTDLP_RELEASES_URL =
	"https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const FFMPEG_RELEASES_URL =
	"https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest";
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

protocol.registerSchemesAsPrivileged([
	{
		scheme: "media",
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			stream: true,
		},
	},
]);

let mainWindow;
let library = [];
let libraryPath;
let mediaDirectory;
let toolsDirectory;
let toolStatePath;
let toolStatus = {
	status: "checking",
	version: null,
	latestVersion: null,
	message: "Checking yt-dlp…",
};
let toolUpdatePromise = null;
let ffmpegStatus = {
	status: "checking",
	version: null,
	latestVersion: null,
	message: "Checking FFmpeg…",
};
let ffmpegUpdatePromise = null;
let subscriptions = [];
let subscriptionsPath;
let thumbnailsDirectory;
let subscriptionSyncPromise = null;
let subscriptionSyncStatus = {
	status: "idle",
	progress: 0,
	message: "Channels have not been checked yet.",
	totalChannels: 0,
	currentChannel: 0,
	newVideos: 0,
};

function persistLibrary() {
	atomicWriteJson(libraryPath, library);
	broadcast("library:update", libraryViews());
}

function sendUpdate(update) {
  if (queue && update.id) queue.update(update.id, {...update,status:update.status === "enriching" ? "processing" : update.status});
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("download:update", update);
	}
}

function sendToolUpdate(update) {
	toolStatus = { ...toolStatus, ...update };
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("tool:update", toolStatus);
	}
}

function sendFfmpegUpdate(update) {
	ffmpegStatus = { ...ffmpegStatus, ...update };
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("ffmpeg:update", ffmpegStatus);
	}
}

function readToolState() {
	if (!toolStatePath || !fs.existsSync(toolStatePath)) return {};
	try {
		return JSON.parse(fs.readFileSync(toolStatePath, "utf8"));
	} catch {
		return {};
	}
}

function writeToolState(state) {
	atomicWriteJson(toolStatePath, state);
}

function request(url, responseType = "json", redirects = 0, deadline = Date.now() + 60_000) {
  return new Promise((resolveResult, rejectResult) => {
    let clientRequest;
    const timer=setTimeout(()=>{
      const error=new Error("Network request timed out.");
      reject(error);
      clientRequest?.destroy(error);
    },Math.max(1,deadline-Date.now()));
    function resolve(value) {clearTimeout(timer); resolveResult(value);}
    function reject(error) {clearTimeout(timer); rejectResult(error);}
    if(redirects > 5) return reject(new Error("Too many redirects while fetching download components."));
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return reject(new Error("Invalid update URL."));
		}
		if (parsed.protocol !== "https:")
			return reject(new Error("Updates must use HTTPS."));
		const requestOptions = {
			headers: {
				"User-Agent": "Offgrid desktop app",
				Accept:
					responseType === "json"
						? "application/vnd.github+json"
						: "application/octet-stream",
			},
		};
		clientRequest=https.get(url, requestOptions, (response) => {
        response.on("error",reject);
        response.on("aborted",()=>reject(new Error("Network response was interrupted.")));
				if (
					[301, 302, 303, 307, 308].includes(response.statusCode) &&
					response.headers.location
				) {
					response.resume();
					let redirectUrl;
          try {redirectUrl=new URL(response.headers.location,url).toString();}
          catch {return reject(new Error("Invalid network redirect."));}
          return request(redirectUrl, responseType, redirects+1, deadline).then(
						resolve,
						reject,
					);
				}
				if (response.statusCode !== 200) {
					response.resume();
					return reject(
						new Error(`Update server returned HTTP ${response.statusCode}.`),
					);
				}
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const body = Buffer.concat(chunks);
					if (responseType === "json") {
						try {
							resolve(JSON.parse(body.toString("utf8")));
						} catch {
							reject(
								new Error("Could not read the yt-dlp release information."),
							);
						}
					} else resolve(body);
				});
			})
			.on("error", reject).setTimeout(30_000, function () { this.destroy(new Error("Network request timed out.")); });
	});
}

function managedYtdlpPath() {
	const binary = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
	return path.join(toolsDirectory, binary);
}

function releaseAssetName() {
	if (process.platform === "darwin") return "yt-dlp_macos";
	if (process.platform === "win32") return "yt-dlp.exe";
	if (process.arch === "arm64") return "yt-dlp_linux_aarch64";
	return "yt-dlp_linux";
}

function commandVersion(command) {
	return new Promise((resolve) => {
		const child = spawn(command, ["--version"]);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.on("error", () => resolve(null));
		child.on("close", (code) => {
			if (code !== 0) return resolve(null);
			const trimmed = output.trim();
			const ffmpegMatch = trimmed.match(/^ffmpeg version\s+([^\s]+)/i);
			resolve(ffmpegMatch?.[1] || trimmed.split(/\s+/)[0] || null);
		});
	});
}

function normalizedVersion(version) {
	return String(version || "")
		.replace(/^v/, "")
		.trim();
}

function managedFfmpegPath() {
	const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	return path.join(toolsDirectory, binary);
}

function ffmpegAssetName() {
	if (process.platform === "darwin")
		return `ffmpeg-darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
	if (process.platform === "win32") return "ffmpeg-win32-x64";
	if (process.arch === "arm64") return "ffmpeg-linux-arm64";
	return "ffmpeg-linux-x64";
}

async function findSystemFfmpeg() {
	const candidates = [
		process.env.OFFGRID_FFMPEG_PATH,
		"ffmpeg",
		...(process.platform === "darwin"
			? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
			: []),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (await commandVersion(candidate)) return candidate;
	}
	return null;
}

async function downloadManagedYtdlp(release, asset) {
	const expectedDigest = asset.digest?.replace(/^sha256:/i, "").toLowerCase();
	if (!expectedDigest)
		throw new Error("The yt-dlp release did not include a checksum.");
	const binary = await request(asset.browser_download_url, "binary");
	const actualDigest = crypto.createHash("sha256").update(binary).digest("hex");
	if (actualDigest !== expectedDigest)
		throw new Error("yt-dlp checksum verification failed.");
	const temporaryPath = `${managedYtdlpPath()}.download`;
	fs.writeFileSync(temporaryPath, binary, { mode: 0o755 });
	if (process.platform !== "win32") fs.chmodSync(temporaryPath, 0o755);
	const previousPath = `${managedYtdlpPath()}.previous`;
	if (fs.existsSync(managedYtdlpPath()))
		fs.renameSync(managedYtdlpPath(), previousPath);
	try {
		fs.renameSync(temporaryPath, managedYtdlpPath());
		writeToolState({
			...readToolState(),
			version: normalizedVersion(release.tag_name),
			checkedAt: Date.now(),
			digest: expectedDigest,
		});
		if (fs.existsSync(previousPath)) fs.unlinkSync(previousPath);
	} catch (error) {
		if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
		if (!fs.existsSync(managedYtdlpPath()) && fs.existsSync(previousPath))
			fs.renameSync(previousPath, managedYtdlpPath());
		throw error;
	}
}

async function updateManagedYtdlp({ force = false } = {}) {
  if(testMode) {if(process.env.OFFGRID_YTDLP_PATH) return process.env.OFFGRID_YTDLP_PATH; throw new Error("No test downloader configured.");}
	if (toolUpdatePromise) return toolUpdatePromise;
	toolUpdatePromise = (async () => {
		const managedPath = managedYtdlpPath();
		const state = readToolState();
		const currentVersion = await commandVersion(managedPath);
		if (
			!force &&
			currentVersion &&
			Date.now() - (state.checkedAt || 0) < UPDATE_INTERVAL_MS
		) {
			sendToolUpdate({
				status: "ready",
				version: currentVersion,
				latestVersion: state.version || currentVersion,
				managed: true,
				message: `yt-dlp ${currentVersion}`,
			});
			return managedPath;
		}
		sendToolUpdate({
			status: "checking",
			version: currentVersion,
			message: "Checking yt-dlp for updates…",
		});
		try {
			const release = await request(YTDLP_RELEASES_URL);
			const latestVersion = normalizedVersion(release.tag_name);
			const asset = release.assets?.find(
				(entry) => entry.name === releaseAssetName(),
			);
			if (!asset)
				throw new Error(
					`No yt-dlp build is available for ${process.platform}/${process.arch}.`,
				);
			if (
				currentVersion &&
				normalizedVersion(currentVersion) === latestVersion
			) {
				writeToolState({
					...state,
					version: latestVersion,
					checkedAt: Date.now(),
					digest: asset.digest || state.digest,
				});
				sendToolUpdate({
					status: "ready",
					version: currentVersion,
					latestVersion,
					managed: true,
					message: `yt-dlp ${currentVersion} · up to date`,
				});
				return managedPath;
			}
			sendToolUpdate({
				status: "updating",
				version: currentVersion,
				latestVersion,
				managed: true,
				message: `Installing yt-dlp ${latestVersion}…`,
			});
			await downloadManagedYtdlp(release, asset);
			sendToolUpdate({
				status: "ready",
				version: latestVersion,
				latestVersion,
				managed: true,
				message: `yt-dlp ${latestVersion} · up to date`,
			});
			return managedPath;
		} catch (error) {
			const fallback = process.env.OFFGRID_YTDLP_PATH || "yt-dlp";
			const fallbackVersion = await commandVersion(fallback);
			if (currentVersion) {
				sendToolUpdate({
					status: "ready",
					version: currentVersion,
					latestVersion: state.version || null,
					managed: true,
					message: `Using yt-dlp ${currentVersion} · update unavailable`,
				});
				return managedPath;
			}
			if (fallbackVersion) {
				sendToolUpdate({
					status: "fallback",
					version: fallbackVersion,
					latestVersion: null,
					managed: false,
					message: `Using system yt-dlp ${fallbackVersion}`,
				});
				return fallback;
			}
			sendToolUpdate({
				status: "error",
				version: null,
				latestVersion: null,
				message: error.message,
			});
			throw error;
		}
	})().finally(() => {
		toolUpdatePromise = null;
	});
	return toolUpdatePromise;
}

async function downloadManagedFfmpeg(release, asset) {
	const expectedDigest = asset.digest?.replace(/^sha256:/i, "").toLowerCase();
	if (!expectedDigest)
		throw new Error("The FFmpeg release did not include a checksum.");
	const binary = await request(asset.browser_download_url, "binary");
	const actualDigest = crypto.createHash("sha256").update(binary).digest("hex");
	if (actualDigest !== expectedDigest)
		throw new Error("FFmpeg checksum verification failed.");
	const temporaryPath = `${managedFfmpegPath()}.download`;
	fs.writeFileSync(temporaryPath, binary, { mode: 0o755 });
	if (process.platform !== "win32") fs.chmodSync(temporaryPath, 0o755);
	const previousPath = `${managedFfmpegPath()}.previous`;
	if (fs.existsSync(managedFfmpegPath()))
		fs.renameSync(managedFfmpegPath(), previousPath);
	try {
		fs.renameSync(temporaryPath, managedFfmpegPath());
		writeToolState({
			...readToolState(),
			ffmpegRelease: normalizedVersion(release.tag_name),
			ffmpegCheckedAt: Date.now(),
			ffmpegDigest: expectedDigest,
		});
		if (fs.existsSync(previousPath)) fs.unlinkSync(previousPath);
	} catch (error) {
		if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
		if (!fs.existsSync(managedFfmpegPath()) && fs.existsSync(previousPath))
			fs.renameSync(previousPath, managedFfmpegPath());
		throw error;
	}
}

async function updateManagedFfmpeg({ force = false } = {}) {
  if(testMode) {if(process.env.OFFGRID_FFMPEG_PATH) return process.env.OFFGRID_FFMPEG_PATH; throw new Error("No test FFmpeg configured.");}
	if (ffmpegUpdatePromise) return ffmpegUpdatePromise;
	ffmpegUpdatePromise = (async () => {
		const managedPath = managedFfmpegPath();
		const state = readToolState();
		const currentVersion = await commandVersion(managedPath);
		if (
			!force &&
			currentVersion &&
			state.ffmpegRelease &&
			Date.now() - (state.ffmpegCheckedAt || 0) < UPDATE_INTERVAL_MS
		) {
			sendFfmpegUpdate({
				status: "ready",
				version: currentVersion,
				latestVersion: state.ffmpegRelease,
				managed: true,
				message: `FFmpeg ${currentVersion}`,
			});
			return managedPath;
		}
		sendFfmpegUpdate({
			status: "checking",
			version: currentVersion,
			message: "Checking FFmpeg for updates…",
		});
		try {
			const release = await request(FFMPEG_RELEASES_URL);
			const latestVersion = normalizedVersion(release.tag_name);
			const asset = release.assets?.find(
				(entry) => entry.name === ffmpegAssetName(),
			);
			if (!asset)
				throw new Error(
					`No FFmpeg build is available for ${process.platform}/${process.arch}.`,
				);
			if (currentVersion && state.ffmpegRelease === latestVersion) {
				writeToolState({
					...state,
					ffmpegRelease: latestVersion,
					ffmpegCheckedAt: Date.now(),
					ffmpegDigest: asset.digest || state.ffmpegDigest,
				});
				sendFfmpegUpdate({
					status: "ready",
					version: currentVersion,
					latestVersion,
					managed: true,
					message: `FFmpeg ${currentVersion} · up to date`,
				});
				return managedPath;
			}
			sendFfmpegUpdate({
				status: "updating",
				version: currentVersion,
				latestVersion,
				managed: true,
				message: `Installing FFmpeg ${latestVersion}…`,
			});
			await downloadManagedFfmpeg(release, asset);
			const installedVersion = await commandVersion(managedPath);
			sendFfmpegUpdate({
				status: "ready",
				version: installedVersion || latestVersion,
				latestVersion,
				managed: true,
				message: `FFmpeg ${installedVersion || latestVersion} · up to date`,
			});
			return managedPath;
		} catch (error) {
			const fallback = await findSystemFfmpeg();
			if (currentVersion) {
				sendFfmpegUpdate({
					status: "ready",
					version: currentVersion,
					latestVersion: state.ffmpegRelease || null,
					managed: true,
					message: `Using FFmpeg ${currentVersion} · update unavailable`,
				});
				return managedPath;
			}
			if (fallback) {
				const fallbackVersion = await commandVersion(fallback);
				sendFfmpegUpdate({
					status: "fallback",
					version: fallbackVersion,
					latestVersion: null,
					managed: false,
					message: `Using system FFmpeg ${fallbackVersion || ""}`.trim(),
				});
				return fallback;
			}
			sendFfmpegUpdate({
				status: "error",
				version: null,
				latestVersion: null,
				message: error.message,
			});
			throw error;
		}
	})().finally(() => {
		ffmpegUpdatePromise = null;
	});
	return ffmpegUpdatePromise;
}

function isSupportedUrl(value) {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) && [
			"youtube.com",
			"www.youtube.com",
			"m.youtube.com",
			"youtu.be",
			"www.youtu.be",
		].includes(url.hostname);
	} catch {
		return false;
	}
}

function formatForQuality(quality) {
	return (
		{
			best: "bestvideo+bestaudio/best",
			"1080p": "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
			"720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
			"480p": "bestvideo[height<=480]+bestaudio/best[height<=480]",
		}[quality] || "bestvideo+bestaudio/best"
	);
}

function runMetadata(
	url,
	quality,
	ytdlpCommand = null,
	{ includeComments = false, jobId = null } = {},
) {
	return new Promise((resolve, reject) => {
		ytdlpCommand = ytdlpCommand || process.env.OFFGRID_YTDLP_PATH || "yt-dlp";
		const args = ["--dump-single-json", "--no-playlist", "--skip-download", "--socket-timeout", "20", "--retries", "2"];
		if (quality) args.push("--format", formatForQuality(quality));
		if (includeComments) args.push("--write-comments");
		args.push(url);
		const child = jobId ? trackedSpawn(jobId, ytdlpCommand, args) : spawn(ytdlpCommand, args);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0)
				return reject(
					new Error(stderr.trim() || "Could not read video metadata."),
				);
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(new Error("The downloader returned unreadable metadata."));
			}
		});
	});
}

function extractTopComments(metadata) {
	return (metadata.comments || [])
		.filter((comment) => comment && comment.text)
		.sort((a, b) => (Number(b.like_count) || 0) - (Number(a.like_count) || 0))
		.slice(0, 50)
		.map((comment) => ({
			author: comment.author || comment.uploader || "YouTube user",
			text: comment.text,
			likeCount: Number(comment.like_count) || 0,
			published: comment.timestamp || null,
		}));
}

function runChannelFeed(channelUrl, ytdlpCommand, count = settings.recentVideoCount) {
	return new Promise((resolve, reject) => {
		const feedUrl = channelUrl.replace(/\/$/, "").endsWith("/videos")
			? channelUrl
			: `${channelUrl.replace(/\/$/, "")}/videos`;
		const child = spawn(ytdlpCommand, [
			"--flat-playlist",
			"--dump-single-json",
			"--playlist-end",
			String(count),
			"--socket-timeout", "20", "--retries", "2",
			"--no-warnings",
			"--ignore-errors",
			feedUrl,
		]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0)
				return reject(
					new Error(stderr.trim() || "Could not read the channel feed."),
				);
			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(new Error("The channel feed returned unreadable data."));
			}
		});
	});
}

async function resolveSubscriptionChannel(data) {
	if (!data?.channelUrl || !isSupportedUrl(data.channelUrl)) {
		throw new Error("Enter a valid YouTube channel or video link.");
	}
	const ytdlpCommand = await updateManagedYtdlp();
	let parsed;
	try {
		parsed = new URL(data.channelUrl);
	} catch {
		throw new Error("Enter a valid YouTube channel or video link.");
	}
	const isVideoLink =
		parsed.hostname.includes("youtu.be") ||
		parsed.pathname === "/watch" ||
		parsed.pathname.startsWith("/shorts/") ||
		parsed.pathname.startsWith("/live/");
	const metadata = isVideoLink
		? await runMetadata(data.channelUrl, null, ytdlpCommand)
		: await runChannelFeed(data.channelUrl, ytdlpCommand);
	const channelUrl =
		metadata.channel_url ||
		metadata.uploader_url ||
		(!isVideoLink ? data.channelUrl.replace(/\/videos\/?$/, "") : null);
	if (!channelUrl) {
		throw new Error("Could not find a channel for that link.");
	}
	return {
		channel:
			data.channel ||
			metadata.channel ||
			metadata.uploader ||
			metadata.title?.replace(/\s*-\s*Videos$/i, "") ||
			"YouTube channel",
		channelId:
			data.channelId || metadata.channel_id || metadata.uploader_id || null,
		channelUrl,
	};
}

function saveFrameThumbnail(filePath, thumbnailPath, ffmpegPath, id) {
	return new Promise((resolve, reject) => {
		const child = trackedSpawn(id, ffmpegPath, [
			"-y",
			"-ss",
			"00:00:02",
			"-i",
			filePath,
			"-frames:v",
			"1",
			"-vf",
			"scale=640:-2",
			thumbnailPath,
		]);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0 && fs.existsSync(thumbnailPath))
				return resolve(thumbnailPath);
			reject(new Error(stderr.trim() || "Could not create a thumbnail frame."));
		});
	});
}

async function saveThumbnail({ id, metadata, filePath, ffmpegPath }) {
  const active=queue.active;
	assertActive(id,active);
	const thumbnailPath = path.join(thumbnailsDirectory, `${id}.jpg`);
	if (metadata.thumbnail) {
		try {
			const thumbnail = await awaitWhileActive(active,()=>request(metadata.thumbnail, "binary"));
			assertActive(id,active);
			fs.writeFileSync(thumbnailPath, thumbnail);
			return thumbnailPath;
		} catch {
			assertActive(id,active);
			// A local frame is a useful fallback when the remote thumbnail is unavailable.
		}
	}
	try {
		return await saveFrameThumbnail(filePath, thumbnailPath, ffmpegPath, id);
	} catch {
		return null;
	}
}

function persistSubscriptions() {
	atomicWriteJson(subscriptionsPath, subscriptions);
}

function sendSubscriptionUpdate() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("subscription:update", subscriptionViews());
	}
}

function sendSubscriptionSyncUpdate(update) {
	subscriptionSyncStatus = { ...subscriptionSyncStatus, ...update };
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(
			"subscription:sync-update",
			subscriptionSyncStatus,
		);
	}
}

async function syncSubscriptions(id = null, {scheduled = false, countOverride = null} = {}) {
  if (subscriptionSyncPromise) return subscriptionSyncPromise;
  subscriptionSyncPromise=(async()=>{
    if (!net.isOnline()) throw new Error("You are offline. Saved videos are ready to watch; check channels when connected.");
    const candidates=subscriptions.filter(subscription=>{
      if (id && subscription.id!==id) return false;
      if (!scheduled) return true;
      const interval=subscription.checkIntervalHours ?? settings.checkIntervalHours;
      const lastCheck=Date.parse(subscription.lastCheckedAt || subscription.addedAt) || 0;
      return subscription.autoDownload && interval > 0 && Date.now()-lastCheck>=interval*3600000;
    });
    if (!candidates.length) return {queued:0};
    sendSubscriptionSyncUpdate({status:"checking",progress:0,message:"Checking channels…",totalChannels:candidates.length,currentChannel:0,newVideos:0});
    const command=await updateManagedYtdlp();
    let queued=0,failed=0;
    for (const [index,subscription] of candidates.entries()) {
      try {
        const count=countOverride ?? subscription.recentVideoCount ?? settings.recentVideoCount;
        const feed=await runChannelFeed(subscription.channelUrl,command,count);
        // The channel may have been unfollowed while the request was running.
        if (!subscriptions.some(item=>item.id===subscription.id)) continue;
        if (scheduled && !subscription.autoDownload) continue;
        for (const entry of (feed.entries || []).filter(entry=>entry?.id).slice(0,count)) {
          if (deletedSources.includes(entry.id) || library.some(video=>video.sourceId===entry.id)) continue;
          const duplicate=queue.jobs.some(job=>job.sourceId===entry.id && !["complete","error","canceled"].includes(job.status));
          if (duplicate) continue;
          const result=queueVideo({url:entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`},"subscription",{
            subscriptionId:subscription.id,sourceId:entry.id,title:entry.title || "New channel video",manualTrigger:!scheduled});
          if (result.accepted) queued++;
        }
        subscription.lastCheckedAt=new Date().toISOString(); subscription.lastError=null;
      } catch(error) { failed++; subscription.lastError=error.message; subscription.lastCheckedAt=new Date().toISOString(); }
      persistSubscriptions(); sendSubscriptionUpdate();
      sendSubscriptionSyncUpdate({status:"checking",progress:Math.round((index+1)/candidates.length*100),message:`Checked ${index+1} of ${candidates.length} channels.`,currentChannel:index+1,newVideos:queued});
    }
    sendSubscriptionSyncUpdate({status:failed===candidates.length?"error":"complete",progress:100,message:`${queued ? `${queued} new videos added to Downloads.` : "No new videos to download."}${failed ? ` ${failed} channels could not be checked.` : ""}`,newVideos:queued,completedAt:new Date().toISOString()});
    return {queued,failed};
  })().catch(error=>{sendSubscriptionSyncUpdate({status:"error",message:error.message});throw error;}).finally(()=>{subscriptionSyncPromise=null;});
  return subscriptionSyncPromise;
}

function startVideoDownload({
	id,
	url,
	quality,
	metadata,
	expectedBytes,
	ytdlpCommand,
	ffmpegPath,
}) {
	return new Promise((resolve, reject) => {
		const command = ytdlpCommand || process.env.OFFGRID_YTDLP_PATH || "yt-dlp";
		const jobDirectory = path.join(workDirectory,id);
		fs.mkdirSync(jobDirectory,{recursive:true});
		const output = path.join(jobDirectory, `${id}.%(ext)s`);
		const child = trackedSpawn(id, command, [
      "--socket-timeout", "20", "--retries", "2",
			"--newline",
			"--progress-template",
			"download:OFFGRID_PROGRESS|%(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
			"--progress-template",
			"postprocess:OFFGRID_POSTPROCESS",
			"--progress-delta",
			"0.5",
			"--no-playlist",
			"--format",
			formatForQuality(quality),
			"--merge-output-format",
			"mp4",
			"--recode-video",
			"mp4",
			"--ffmpeg-location",
			ffmpegPath,
			"--print",
			"after_move:filepath",
			"--output",
			output,
			url,
		]);
		let stderr = "";
		let finalPath = null;
		let lastProgress = 0;
		const formatProgress = new Map();
		const requestedFormats = metadata.requested_formats?.length
			? metadata.requested_formats
			: [metadata];
		for (const format of requestedFormats) {
			const total = format.filesize ?? format.filesize_approx;
			if (format.format_id && Number.isFinite(total)) {
				formatProgress.set(String(format.format_id), { downloaded: 0, total });
			}
		}
		const outputReader = readline.createInterface({ input: child.stdout });
		outputReader.on("line", (line) => {
			const candidate = line.trim();
			if (path.dirname(candidate) === jobDirectory && fs.existsSync(candidate)) {
				finalPath = candidate;
				return;
			}
			if (candidate === "OFFGRID_POSTPROCESS") {
				sendUpdate({
					id,
					status: "processing",
					progress: 100,
					indeterminate: true,
					title: metadata.title,
					expectedBytes,
					message: "Combining audio and video…",
				});
				return;
			}
			if (!candidate.startsWith("OFFGRID_PROGRESS|")) return;
			const [, formatId, downloadedValue, totalValue, speedValue, etaValue] =
				candidate.split("|");
			const downloaded = Number(downloadedValue);
			const reportedTotal = Number(totalValue);
			const speedBytes = Number(speedValue);
			const etaSeconds = Number(etaValue);
			if (Number.isFinite(downloaded)) {
				const existing = formatProgress.get(formatId) || {
					downloaded: 0,
					total: null,
				};
				formatProgress.set(formatId, {
					downloaded: Math.max(existing.downloaded, downloaded),
					total: Number.isFinite(reportedTotal)
						? reportedTotal
						: existing.total,
				});
			}
			const totals = [...formatProgress.values()];
			const downloadedBytes = totals.reduce(
				(sum, progress) => sum + progress.downloaded,
				0,
			);
			const reportedTotalBytes = totals.reduce(
				(sum, progress) =>
					sum + (Number.isFinite(progress.total) ? progress.total : 0),
				0,
			);
			const totalBytes = reportedTotalBytes || expectedBytes;
			if (totalBytes > 0) {
				lastProgress = Math.max(
					lastProgress,
					Math.min(100, (downloadedBytes / totalBytes) * 100),
				);
			}
			sendUpdate({
				id,
				status: "downloading",
				progress: lastProgress,
				title: metadata.title,
				expectedBytes: totalBytes || expectedBytes,
				downloadedBytes,
				speedBytes: Number.isFinite(speedBytes) ? speedBytes : null,
				etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : null,
				message: "Downloading video…",
			});
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0)
				return reject(new Error(stderr.trim() || "Download failed."));
			const file =
				finalPath ||
				fs
					.readdirSync(jobDirectory)
					.filter(
						(name) => name === `${id}.mp4`,
					)
					.map((name) => path.join(jobDirectory, name))[0];
			if (!file || !fs.existsSync(file))
				return reject(
					new Error("The download finished without producing a video file."),
				);
			resolve({ filePath: file, sizeBytes: fs.statSync(file).size });
		});
	});
}

async function getDownloadEstimate({ url, quality } = {}) {
  if(!net.isOnline()) throw new Error("You are offline. Connect to estimate a download.");
	if (!isSupportedUrl(url)) throw new Error("Paste a valid YouTube URL.");
	quality = quality ?? settings.defaultQuality;
  if (!QUALITIES.includes(quality)) throw new Error("Invalid download quality.");
  const ytdlpCommand = await updateManagedYtdlp();
	const metadata = await runMetadata(url, quality, ytdlpCommand);
	return {
    sourceId:metadata.id || null, duration:metadata.duration || 0, channel:metadata.channel || metadata.uploader || "YouTube",
		title: metadata.title || "Untitled video",
		expectedBytes: getExpectedSize(metadata),
	};
}

async function downloadVideo(job, active) {
  if (job.provider === 'plex' || job.provider === 'jellyfin') return downloadServerVideo(job, active);
  const {id,url,quality}=job;
  if (!net.isOnline()) throw new Error("You are offline. Retry when connected.");
  const monitor=setInterval(()=>{
    try {
      const violation=storageViolation();
      if(violation) active.stop("waiting-storage",violation);
      emitStorage();
    } catch(error) { active.stop("waiting-storage",`Storage could not be checked: ${error.message}`); }
  },500);
  try {
    const ytdlpCommand=await awaitWhileActive(active,()=>updateManagedYtdlp()); assertActive(id,active);
    const metadata=await runMetadata(url,quality,ytdlpCommand,{jobId:id}); assertActive(id);
    const existing=library.find(video=>metadata.id && video.sourceId===metadata.id);
    if(existing) { sendUpdate({id,status:"complete",progress:100,title:existing.title,videoId:existing.id,message:"Already in your library"}); return; }
    if(job.source==="subscription" && deletedSources.includes(metadata.id)) {active.stop("canceled","This video was previously removed from your library."); assertActive(id);}
    const expectedBytes=getExpectedSize(metadata);
    queue.update(id,{sourceId:metadata.id || job.sourceId,title:metadata.title || "Untitled video",expectedBytes});
    const blocked=checkStorageAdmission(storageSnapshot(),expectedBytes);
    if(blocked) {active.stop("waiting-storage",blocked); assertActive(id);}
    const ffmpegPath=await awaitWhileActive(active,()=>updateManagedFfmpeg()); assertActive(id,active);
    if(!ffmpegPath) throw new Error("FFmpeg is not ready. Update download components in Settings and retry.");
    sendUpdate({id,status:"downloading",progress:0,title:metadata.title,expectedBytes,message:"Downloading video…"});
    const download=await startVideoDownload({id,url,quality,metadata,expectedBytes,ytdlpCommand,ffmpegPath}); assertActive(id);
    sendUpdate({id,status:"processing",progress:100,indeterminate:true,title:metadata.title,message:"Saving thumbnail…"});
    const thumbnailPath=await saveThumbnail({id,metadata,filePath:download.filePath,ffmpegPath}); assertActive(id);
    let comments=[];
    if(job.saveComments) {
      sendUpdate({id,status:"processing",progress:100,indeterminate:true,title:metadata.title,message:"Saving available comments…"});
      try {comments=extractTopComments(await runMetadata(url,null,ytdlpCommand,{includeComments:true,jobId:id}));}
      catch(error) {assertActive(id); console.warn("Comments unavailable:",error.message);}
    }
    assertActive(id);
    const violation=storageViolation();
    if(violation) {active.stop("waiting-storage",violation); assertActive(id);}
    const filePath=path.join(mediaDirectory,`${id}.mp4`);
    fs.renameSync(download.filePath,filePath);
    const video={id,sourceId:metadata.id || null,title:metadata.title || "Untitled video",
      channel:metadata.channel || metadata.uploader || "YouTube",channelId:metadata.channel_id || metadata.uploader_id || null,
      channelUrl:metadata.channel_url || metadata.uploader_url || null,duration:metadata.duration || 0,width:metadata.width || null,height:metadata.height || null,
      url,filePath,thumbnailPath,comments,sizeBytes:fs.statSync(filePath).size,expectedBytes,savedAt:new Date().toISOString(),playbackPositionSeconds:0,watched:false};
    library=[video,...library];
    try {persistLibrary();} catch(error) {library=library.filter(item=>item.id!==id); throw error;}
    fs.rmSync(path.join(workDirectory,id),{recursive:true,force:true});
    sendUpdate({id,status:"complete",progress:100,title:video.title,videoId:id,video:videoView(video),message:"Ready to watch",error:null});
  } finally {clearInterval(monitor); emitStorage();}
}

function savePlayback(id, progress) {
  const video=library.find(item=>item.id===id); if(!video) throw new Error('Video not found.');
  if(!progress || !Number.isFinite(progress.positionSeconds) || progress.positionSeconds<0 || (progress.watched !== undefined && typeof progress.watched!=='boolean')) throw new Error('Invalid playback progress.');
  const updated={...video,playbackPositionSeconds:Math.min(progress.positionSeconds,video.duration || progress.positionSeconds),lastPlayedAt:new Date().toISOString()};
  if(progress.watched !== undefined) updated.watched=progress.watched;
  const next=library.map(item=>item.id===id?updated:item);
  atomicWriteJson(libraryPath,next); library=next; broadcast('library:update',libraryViews());
  return videoView(updated);
}

async function queueServerVideo(provider, ratingKey) {
  const server = mediaServers[provider];
  const revision = server.revision;
  if (server.busy) throw new Error(`Wait for the ${server.name} connection to finish.`);
  const connection = server.connection.status();
  const client = server.connection.client();
  const metadata = await client.metadata(ratingKey);
  if (server.busy || server.revision !== revision || server.connection.status().serverId !== connection.serverId || server.connection.status().baseUrl !== connection.baseUrl)
    throw new Error(`The ${server.name} connection changed. Select the video again.`);
  const sourceId = `${provider}:${connection.serverId}:${metadata.id}`;
  const existing = library.find(video=>video.sourceId===sourceId);
  if (existing) return { accepted:false, alreadySaved:true, videoId:existing.id };
  const job = queue.add({ provider, source:'manual', sourceId,
    serverId:connection.serverId, ratingKey:metadata.id,
    url:`${provider}://${encodeURIComponent(connection.serverId)}/${metadata.id}`,
    quality:'original', title:metadata.title, expectedBytes:metadata.sizeBytes });
  return { accepted:true, id:job.id };
}

async function downloadServerVideo(job, active) {
  const provider = job.provider;
  const server = mediaServers[provider];
  const {id}=job;
  if (server.busy) throw new Error(`The ${server.name} connection is changing. Retry shortly.`);
  if (server.connection.status().serverId !== job.serverId) throw new Error(`Reconnect to the ${server.name} server used for this download, then retry.`);
  const client=server.connection.client();
  const monitor=setInterval(()=>{
    try {
      const violation=storageViolation();
      if(violation) active.stop('waiting-storage',violation);
      emitStorage();
    } catch { active.stop('waiting-storage','Storage could not be checked. Retry when storage is available.'); }
  },500);
  try {
    const identity=await awaitWhileActive(active,()=>client.identity({signal:active.controller.signal}));
    if(identity.serverId!==job.serverId) throw new Error(`This address now belongs to a different ${server.name} server. Reconnect before downloading.`);
    const metadata=await awaitWhileActive(active,()=>client.metadata(job.ratingKey,{signal:active.controller.signal}));
    const expectedSourceId=`${provider}:${job.serverId}:${metadata.id}`;
    if(expectedSourceId!==job.sourceId) throw new Error(`${server.name} returned a different video. Select the video again.`);
    const existing=library.find(video=>video.sourceId===job.sourceId);
    if(existing) {sendUpdate({id,status:'complete',progress:100,videoId:existing.id,message:'Already in your library'}); return;}
    queue.update(id,{title:metadata.title,expectedBytes:metadata.sizeBytes});
    const blocked=checkStorageAdmission(storageSnapshot(),metadata.sizeBytes,1);
    if(blocked) {active.stop('waiting-storage',blocked); assertActive(id);}
    const directory=path.join(workDirectory,id);
    fs.mkdirSync(directory,{recursive:true});
    if(!/^[a-z0-9]{1,10}$/.test(metadata.extension)) throw new Error(`${server.name} returned an unsupported file extension.`);
    const temporary=path.join(directory,`${id}.${metadata.extension}`);
    let lastUpdate=0;
    sendUpdate({id,status:'downloading',progress:0,message:'Downloading original file…'});
    await client.download(metadata,temporary,{signal:active.controller.signal,onProgress:progress=>{
      if(active.stopReason) return;
      if(Date.now()-lastUpdate<250 && progress.progress<100) return;
      lastUpdate=Date.now();
      sendUpdate({id,status:'downloading',progress:progress.progress,downloadedBytes:progress.downloadedBytes,
        expectedBytes:progress.totalBytes || metadata.sizeBytes,message:'Downloading original file…'});
    }});
    assertActive(id);
    const violation=storageViolation();
    if(violation) {active.stop('waiting-storage',violation); assertActive(id);}
    const filePath=path.join(mediaDirectory,`${id}.${metadata.extension}`);
    fs.renameSync(temporary,filePath);
    const video={id,provider,sourceId:job.sourceId,serverId:job.serverId,ratingKey:metadata.id,
      title:metadata.title,channel:metadata.channel || server.connection.status().serverName || `${server.name}`,
      duration:metadata.duration || 0,url:job.url,filePath,thumbnailPath:null,comments:[],
      sizeBytes:fs.statSync(filePath).size,expectedBytes:metadata.sizeBytes,savedAt:new Date().toISOString(),
      playbackPositionSeconds:0,watched:false};
    library=[video,...library];
    try {persistLibrary();} catch(error) {library=library.filter(item=>item.id!==id); throw error;}
    fs.rmSync(directory,{recursive:true,force:true});
    sendUpdate({id,status:'complete',progress:100,title:video.title,videoId:id,video:videoView(video),message:'Ready to watch',error:null});
  } finally {clearInterval(monitor); emitStorage();}
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1240,
		height: 820,
		minWidth: 820,
		minHeight: 640,
		title: "Offgrid",
		backgroundColor: "#f4f0e8",
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	mainWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			console.error("Offgrid renderer failed to load", {
				errorCode,
				errorDescription,
				validatedURL,
			});
		},
	);
	mainWindow.webContents.on(
		"console-message",
		(_event, level, message, line, sourceId) => {
			if (level >= 2)
				console.error("Offgrid renderer error", { message, line, sourceId });
		},
	);

	if (process.argv.includes("--dev")) {
		mainWindow.loadURL("http://127.0.0.1:5173");
		mainWindow.webContents.openDevTools({ mode: "detach" });
	} else {
		const entrypoint = path.join(__dirname, "..", "dist", "index.html");
		mainWindow
			.loadFile(entrypoint)
			.catch((error) =>
				console.error("Offgrid entrypoint failed to load", entrypoint, error),
			);
	}
}

app.whenReady().then(() => {
  dataDirectory=process.env.OFFGRID_DATA_DIR || app.getPath("userData");
  fs.mkdirSync(dataDirectory,{recursive:true});
  libraryPath=path.join(dataDirectory,"library.json");
  subscriptionsPath=path.join(dataDirectory,"subscriptions.json");
  settingsPath=path.join(dataDirectory,"settings.json");
  deletedSourcesPath=path.join(dataDirectory,"deleted-sources.json");
  mediaDirectory=path.join(dataDirectory,"videos");
  thumbnailsDirectory=path.join(dataDirectory,"thumbnails");
  toolsDirectory=path.join(dataDirectory,"tools");
  workDirectory=path.join(mediaDirectory,".work");
  toolStatePath=path.join(toolsDirectory,"yt-dlp.json");
  const legacy=fs.existsSync(libraryPath) || fs.existsSync(subscriptionsPath);
  for(const directory of [mediaDirectory,thumbnailsDirectory,toolsDirectory,workDirectory]) fs.mkdirSync(directory,{recursive:true});
  library=readJson(libraryPath,[]); if(!Array.isArray(library)) library=[];
  subscriptions=readJson(subscriptionsPath,[]); if(!Array.isArray(subscriptions)) subscriptions=[];
  const savedSettings=readJson(settingsPath,defaultSettings(legacy));
  try {settings=validateSettings(savedSettings,defaultSettings(legacy));} catch {settings=defaultSettings(legacy);}
  atomicWriteJson(settingsPath,settings);
  deletedSources=readJson(deletedSourcesPath,[]); if(!Array.isArray(deletedSources)) deletedSources=[];
  subscriptions=subscriptions.map(subscription=>({...subscription,autoDownload:subscription.autoDownload ?? true,recentVideoCount:subscription.recentVideoCount ?? settings.recentVideoCount,checkIntervalHours:subscription.checkIntervalHours ?? settings.checkIntervalHours}));
  persistSubscriptions();
  library=library.map(video=>({...video,sizeBytes:video.filePath && fs.existsSync(video.filePath)?fs.statSync(video.filePath).size:video.sizeBytes || 0,playbackPositionSeconds:video.playbackPositionSeconds || 0,watched:Boolean(video.watched)}));
  mediaServers.plex.connection=new PlexConnection(dataDirectory,safeStorage);
  mediaServers.jellyfin.connection=new JellyfinConnection(dataDirectory,safeStorage);
  player=testMode && process.env.OFFGRID_TEST_MPV!=='1' ? {
    status:async()=>({available:false,path:null,message:'Native playback is disabled in isolated UI tests.'}),
    state:()=>({videoId:null,status:'idle',positionSeconds:0,duration:0,paused:false,error:null}),
    open:async()=>{throw new Error('Native playback is disabled in isolated UI tests.');},
    stop:async()=>{}, control:async()=>{},
  } : createMpvPlayer({
    onProgress:(id,progress)=>{if(library.some(video=>video.id===id)) savePlayback(id,progress);},
    onState:state=>broadcast('player:update',state),
  });
  queue=new DurableQueue({file:path.join(dataDirectory,"downloads.json"),execute:downloadVideo,cleanup:cleanupJob,
    notify:snapshot=>broadcast("queue:update",snapshot),canRun:canRunJob});

	protocol.handle("media", async (request) => {
		let mediaType;
		let id;
		try {
			const parsed = new URL(request.url);
			mediaType = parsed.hostname;
			id = decodeURIComponent(parsed.pathname.slice(1));
		} catch {
			return new Response("Invalid media request", { status: 400 });
		}
		const video = library.find((entry) => entry.id === id);
		const filePath =
			mediaType === "thumbnail" ? video?.thumbnailPath : video?.filePath;
		if (!video || !filePath || !fs.existsSync(filePath))
			return new Response("Media not found", { status: 404 });
		return net.fetch(pathToFileURL(filePath).toString());
	});

	ipcMain.handle("library:list", () => libraryViews());
  for (const [provider, server] of Object.entries(mediaServers)) {
    ipcMain.handle(`${provider}:config`,()=>({...server.connection.status(),suggestedBaseUrl:process.env[`OFFGRID_${provider.toUpperCase()}_URL`] || '',platform:process.platform}));
    ipcMain.handle(`${provider}:request-local-access`,async(_event,baseUrl)=>{
      if(localAccessController) throw new Error('A local network check is already running.');
      if(baseUrl !== undefined && typeof baseUrl !== 'string') throw new Error(`Enter your ${server.name} server address first.`);
      const controller=new AbortController();
      localAccessController=controller;
      try {
        // No credentials are decrypted, transmitted, or saved by this check.
        const configuredUrl=baseUrl === undefined ? server.connection.status().baseUrl : baseUrl;
        const probeUrl=provider==='jellyfin' ? new URL(normalizeJellyfinUrl(configuredUrl)).origin : configuredUrl;
        const result=await requestLocalNetworkAccess(probeUrl,{signal:controller.signal});
        return provider==='jellyfin' ? {...result,message:result.message.replaceAll('Plex','Jellyfin').replaceAll('32400','8096')} : result;
      } finally {if(localAccessController===controller) localAccessController=null;}
    });
    ipcMain.handle(`${provider}:connect`,async(_event,config)=>{
      if(server.busy) throw new Error(`A ${server.name} connection is already being checked.`);
      if(queue.active && queue.jobs.find(job=>job.id===queue.active.id)?.provider===provider)
        throw new Error(`Wait for the current ${server.name} download to finish or cancel it before changing servers.`);
      server.busy=true;
      server.revision++;
      try {return {...await server.connection.connect(config),platform:process.platform};} finally {server.busy=false;}
    });
    ipcMain.handle(`${provider}:disconnect`,async()=>{
      if(server.busy) throw new Error(`Wait for the ${server.name} connection to finish.`);
      server.busy=true;
      server.revision++;
      try {
        // Hold this provider's work until cancellation closes its HTTP stream.
        for(const job of queue.jobs) if(job.provider===provider && !['complete','canceled','error'].includes(job.status)) await queue.cancel(job.id);
        return server.connection.disconnect();
      } finally {server.busy=false;}
    });
    ipcMain.handle(`${provider}:sections`,()=>server.connection.client().sections());
    ipcMain.handle(`${provider}:browse`,(_event,args)=>server.connection.client().browse(args));
    ipcMain.handle(`${provider}:download`,(_event,id)=>queueServerVideo(provider,id));
  }
  ipcMain.handle('plex:open-local-settings',async()=>{
    if(process.platform!=='darwin') throw new Error('Local Network settings are available on macOS.');
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork');
    return {opened:true};
  });
  ipcMain.handle('player:status',()=>player.status());
  ipcMain.handle('player:state',()=>player.state());
  ipcMain.handle('player:open',(_event,id)=>{
    const video=library.find(item=>item.id===id);
    if(!video || !video.filePath || !fs.existsSync(video.filePath)) throw new Error('The saved video could not be found.');
    return player.open(video);
  });
  ipcMain.handle('player:control',(_event,action)=>{
    if(!['toggle-pause','stop'].includes(action)) throw new Error('Invalid player action.');
    return player.control(action);
  });
	ipcMain.handle("subscriptions:list", () => subscriptionViews());
	ipcMain.handle("subscriptions:sync-status", () => subscriptionSyncStatus);
	ipcMain.handle("subscriptions:add", async (_event, data) => {
		const channel = await resolveSubscriptionChannel(data);
		const existing = subscriptions.find(
			(subscription) =>
				(channel.channelId && subscription.channelId === channel.channelId) ||
				subscription.channelUrl === channel.channelUrl,
		);
		if (existing) return subscriptionView(existing);
		const subscription = {
			id: crypto.randomUUID(),
			...channel,
			addedAt: new Date().toISOString(),
			lastCheckedAt: null,
      autoDownload: data.autoDownload ?? settings.autoDownload,
      recentVideoCount: data.recentVideoCount ?? settings.recentVideoCount,
      checkIntervalHours: data.checkIntervalHours ?? settings.checkIntervalHours,
		};
    validateSettings({autoDownload:subscription.autoDownload,recentVideoCount:subscription.recentVideoCount,checkIntervalHours:subscription.checkIntervalHours});
    if(data.initialFetchCount !== undefined && ![0,1,3,5,10].includes(data.initialFetchCount)) throw new Error("Invalid initial fetch count.");
		subscriptions = [subscription, ...subscriptions];
		persistSubscriptions();
		sendSubscriptionUpdate();
		if(data.initialFetchCount > 0) syncSubscriptions(subscription.id,{countOverride:data.initialFetchCount}).catch(()=>{});
		return subscriptionView(subscription);
	});
	ipcMain.handle("subscriptions:remove", (_event, id) => {
		const before = subscriptions.length;
		subscriptions = subscriptions.filter(
			(subscription) => subscription.id !== id,
		);
		if (subscriptions.length !== before) {
      cancelPendingAutomaticJobs(id,"Channel unfollowed. Retry to download this video manually.");
			persistSubscriptions();
			sendSubscriptionUpdate();
		}
		return subscriptions.length !== before;
	});
	ipcMain.handle("subscriptions:sync", (_event,id) => syncSubscriptions(id));
	ipcMain.handle("tool:status", () => toolStatus);
	ipcMain.handle("tool:update", () => updateManagedYtdlp({ force: true }));
	ipcMain.handle("ffmpeg:status", () => ffmpegStatus);
	ipcMain.handle("ffmpeg:update", () => updateManagedFfmpeg({ force: true }));
  ipcMain.handle("settings:get",()=>settings);
  ipcMain.handle("settings:update",(_event,patch)=>{
    const next=validateSettings(patch,settings); atomicWriteJson(settingsPath,next); settings=next;
    broadcast("settings:update",settings); sendSubscriptionUpdate();
    const violation=storageViolation();
    if(queue.active) {
      const job=queue.jobs.find(item=>item.id===queue.active.id);
      const storage=storageSnapshot();
      const written=directoryBytes(path.join(workDirectory,job.id));
      const reservation=Number.isFinite(job.expectedBytes)?Math.max(0,Math.ceil(job.expectedBytes*(['plex','jellyfin'].includes(job.provider)?1:3))+16_000_000-written):0;
      if(violation || (next.maxLibraryBytes!==null && (job.expectedBytes===null || storage.savedBytes+storage.temporaryBytes+reservation>next.maxLibraryBytes)))
        queue.active.stop("waiting-storage",violation || "The new library limit leaves too little processing space for this download. Increase it or lower quality, then retry.");
    }
    emitStorage(); void queue.pump(); return settings;
  });
  ipcMain.handle("storage:get",()=>storageSnapshot());
  ipcMain.handle("storage:reveal",()=>shell.openPath(dataDirectory));
  ipcMain.handle("app:version",()=>app.getVersion());
  ipcMain.handle("downloads:list",()=>queue.snapshot());
  ipcMain.handle("downloads:pause",(_event,paused)=>queue.pause(paused));
  ipcMain.handle("downloads:cancel",(_event,id)=>queue.cancel(id));
  ipcMain.handle("downloads:retry",(_event,id,options)=>queue.retry(id,options));
  ipcMain.handle("subscriptions:update",(_event,id,patch)=>{
    const subscription=subscriptions.find(item=>item.id===id); if(!subscription) throw new Error("Channel not found.");
    if(!patch || Object.keys(patch).some(key=>!["autoDownload","recentVideoCount","checkIntervalHours"].includes(key))) throw new Error("Invalid channel settings.");
    validateSettings(patch);
    const updated={...subscription,...patch};
    const next=subscriptions.map(item=>item.id===id?updated:item);
    atomicWriteJson(subscriptionsPath,next); subscriptions=next;
    if(patch.autoDownload===false) cancelPendingAutomaticJobs(id,"Automatic downloads are off for this channel. Retry to download manually.");
    sendSubscriptionUpdate(); void queue.pump(); return subscriptionView(updated);
  });
  ipcMain.handle("library:playback",(_event,id,progress)=>{
    return savePlayback(id,progress);
  });
  ipcMain.handle("library:delete", async (_event, id) => {
    const video=library.find(entry=>entry.id===id); if(!video) return false;
    if(player.state().videoId===id) await player.stop();
    if(video.sourceId && !deletedSources.includes(video.sourceId)) {
      deletedSources.push(video.sourceId); atomicWriteJson(deletedSourcesPath,deletedSources);
    }
    for(const file of [video.filePath,video.thumbnailPath]) if(file && fs.existsSync(file)) fs.unlinkSync(file);
    library=library.filter(entry=>entry.id!==id); persistLibrary(); emitStorage(); return true;
  });
  ipcMain.handle("download:estimate",(_event,args)=>getDownloadEstimate(args));
  ipcMain.handle("download:start",(_event,args)=>queueVideo(args));

	createWindow();
  const settingsMenu={label:"Settings…",accelerator:"CmdOrCtrl+,",click:()=>{
    if(!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      mainWindow.webContents.once("did-finish-load",()=>broadcast("settings:open"));
    } else broadcast("settings:open");
    mainWindow.show();
  }};
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==="darwin" ? [{label:app.name,submenu:[{role:"about"},{type:"separator"},settingsMenu,{type:"separator"},{role:"hide"},{role:"hideOthers"},{role:"unhide"},{type:"separator"},{role:"quit"}]}] : [{label:"File",submenu:[settingsMenu,{role:"quit"}]}]),
    {role:"editMenu"},{role:"viewMenu"},{role:"windowMenu"}
  ]));
  if(testMode) {
    sendToolUpdate({status:"ready",version:"test",message:"Download components available in test mode"});
    sendFfmpegUpdate({status:"ready",version:"test",message:"FFmpeg available in test mode"});
  } else {
    updateManagedYtdlp().catch(()=>{}); updateManagedFfmpeg().catch(()=>{});
    setInterval(()=>updateManagedFfmpeg().catch(()=>{}),UPDATE_INTERVAL_MS);
    syncSubscriptions(null,{scheduled:true}).catch(()=>{});
    setInterval(()=>syncSubscriptions(null,{scheduled:true}).catch(()=>{}),60_000);
  }
  void queue.pump();
  setInterval(()=>{emitStorage(); void queue.pump();},10_000);

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  localAccessController?.abort();
  void player?.stop();
  if(queue) {queue.shuttingDown=true; queue.active?.stop("error","Offgrid closed before this download finished. Retry to start again."); queue.persist();}
});
