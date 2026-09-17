// Runs the real Electron IPC implementation against an isolated filesystem.
// Electron, child processes, and HTTPS are mocked: tests cannot download media.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { fileURLToPath, pathToFileURL } = require("node:url");
const crypto = require('node:crypto');
const credentialKey = crypto.randomBytes(32);

const mainPath = path.resolve(__dirname, "../electron/main.cjs");

async function eventually(predicate, message = "Condition did not become true", timeout = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const result = await predicate();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(message);
}

async function createHarness({ directory, seed = {}, fixtures = {}, freeBytes = 1e12, encryptionAvailable = true, playerFactory, localAccessRequest,
  testMode = true, updatesFactory, updateDownloadFactory, appVersion = '0.1.0-test', launchUrls = [], beforeReady, singleInstance = true } = {}) {
  if (!testMode && (!updatesFactory || !updateDownloadFactory)) {
    throw new Error('Production-mode harness requires isolated updater factories.');
  }
	const dataDir = directory || fs.mkdtempSync(path.join(os.tmpdir(), "offgrid-test-"));
	for (const [filename, value] of Object.entries(seed)) {
		const target = path.join(dataDir, filename);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, Buffer.isBuffer(value) ? value : JSON.stringify(value));
	}
	const handlers = new Map();
	const protocols = new Map();
	const events = [];
	const calls = [];
  const externalUrls = [];
	const children = new Set();
	const timers = new Set();
	const intervals = new Set();
	const pendingResponses = new Map();
	let availableBytes = freeBytes;
	let online = true;
	let networkRequests = 0;
	let alive = true;
	let currentWindow;
	let appReady=false;
	const windows=[];
	const app = new EventEmitter();
	app.getPath = () => dataDir;
	app.setPath = () => {};
	app.getVersion = () => appVersion;
	app.getName = () => "Offgrid";
	app.whenReady = () => Promise.resolve().then(()=>{beforeReady?.(app);appReady=true;});
	app.isReady=()=>appReady;
	app.exit=code=>{app.exitCode=code;};
	app.quit = () => { app.quitCalls=(app.quitCalls || 0)+1; };
	app.requestSingleInstanceLock = () => singleInstance;
	app.setAsDefaultProtocolClient = () => true;
	app.releaseSingleInstanceLock = () => {};
	app.isPackaged = true;
	class BrowserWindow extends EventEmitter {
		constructor() {
			super();
			this.webContents = new EventEmitter();
			this.webContents.mainFrame={url:pathToFileURL(path.resolve(__dirname,'../dist/index.html')).href};
			this.webContents.getURL=()=>this.webContents.mainFrame.url;
			this.webContents.setWindowOpenHandler=handler=>{this.windowOpenHandler=handler;};
			this.webContents.send = (channel, value) => events.push({ channel, value: structuredClone(value) });
			this.webContents.openDevTools = () => {};
			this.destroyed=false;this.visible=false;this.minimized=false;this.focused=false;
			currentWindow=this;windows.push(this);
		}
		isDestroyed() { return this.destroyed; }
		show() { this.visible=true; }
		focus() { this.focused=true; }
		isMinimized() { return this.minimized; }
		restore() { this.minimized=false; }
		close() { this.destroyed=true;this.emit('closed'); }
		loadFile(file) {this.webContents.mainFrame.url=pathToFileURL(file).href;later(()=>this.webContents.emit('did-finish-load'));return Promise.resolve();}
		loadURL(url) {this.webContents.mainFrame.url=url;later(()=>this.webContents.emit('did-finish-load'));return Promise.resolve();}
		static getAllWindows() { return windows.filter(window=>!window.destroyed); }
	}
	const electron = {
		app, BrowserWindow,
		ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
		protocol: { registerSchemesAsPrivileged() {}, handle: (name, handler) => protocols.set(name, handler) },
		net: { isOnline: () => online, fetch: async (url) => new Response(fs.readFileSync(fileURLToPath(url))) },
		Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
		shell: { openPath: async () => "", showItemInFolder() {}, openExternal: async url => {externalUrls.push(url);} },
		safeStorage: {
      isEncryptionAvailable:()=>encryptionAvailable,
      getSelectedStorageBackend:()=> 'keychain',
      encryptString(value) {
        const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',credentialKey,iv);
        const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
        return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
      },
      decryptString(value) {
        const decipher=crypto.createDecipheriv('aes-256-gcm',credentialKey,value.subarray(0,12));
        decipher.setAuthTag(value.subarray(12,28));
        return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');
      },
    },
	};
	function later(fn, delay = 0) {
		const timer = setTimeout(() => { timers.delete(timer); if (alive) fn(); }, delay);
		timers.add(timer);
		return timer;
	}
	function spawn(command, args) {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		let closed = false;
		function finish(code) {
			if (closed) return;
			closed = true;
			child.stdout.end();
			child.stderr.end();
			children.delete(child);
			child.emit("exit", code);
			child.emit("close", code);
		}
		child.kill = () => { later(() => finish(null)); return true; };
		children.add(child);
		const call={command,args:[...args],child};calls.push(call);
		later(() => {
			if (closed) return;
			if (args.includes("--version") || args.includes("-version")) {
				child.stdout.write(command.includes("ffmpeg") ? "ffmpeg version 7.0\n" : "2026.09.01\n");
				return finish(0);
			}
			if (args.includes("-frames:v")) {
				fs.mkdirSync(path.dirname(args.at(-1)), { recursive: true });
				fs.writeFileSync(args.at(-1), Buffer.alloc(32, 1));
				return finish(0);
			}
			if(command.includes('ffmpeg')) {
				if(args.includes('-encoders')) {child.stdout.write(' V..... libx264\n A..... aac\n');return finish(0);}
				if(args.includes('-t')) {
					const input=args[args.indexOf('-i')+1],height=input.includes('smaller')?720:1080;
					child.stderr.write(`Duration: 00:02:00.00\nStream #0:0: Video: h264, yuv420p, 1280x${height}, 24 fps\nStream #0:1: Audio: aac, 48000 Hz\n`);return finish(0);
				}
				if(args.includes('-xerror')) return finish(0);
				const input=args[args.indexOf('-i')+1],output=args.at(-1);
				if(args.includes('-c:v')) {
					fs.writeFileSync(output,Buffer.alloc(Math.max(1,Math.floor(fs.statSync(input).size/2))));child.stdout.write('out_time_us=120000000\n');
					if(fixtures.ffmpeg?.hold) return;
					if(fixtures.ffmpeg?.error) {child.stderr.write('Fixture conversion failed');return finish(1);}
					return finish(0);
				}
				if(args.includes('webvtt')) {fs.writeFileSync(output,'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nEmbedded caption\n');return finish(0);}
			}
			const url = args.at(-1);
			const id = new URL(url).searchParams.get("v") || new URL(url).searchParams.get('list') || new URL(url).pathname.split("/").filter(Boolean).at(-1);
			const fixture = fixtures[id] || {};
			if (args.includes("--flat-playlist")) {
				const entries=fixture.entries || fixtures.feed || [];
				const start=args.includes('--playlist-start')?Number(args[args.indexOf('--playlist-start')+1])-1:0;
				const end=args.includes('--playlist-end')?Number(args[args.indexOf('--playlist-end')+1]):entries.length;
				child.stdout.write(JSON.stringify({ channel: "Test channel", channel_id: "channel-test", channel_url: "https://www.youtube.com/@test", playlist_count:fixture.playlistCount ?? entries.length, entries:entries.slice(start,end) }));
				return finish(0);
			}
			if (args.includes("--dump-single-json")) {
				if(fixture.metadataHold) return;
				if (fixture.metadataError) { child.stderr.write("Metadata unavailable"); return finish(1); }
				const metadata = { id, title: `Video ${id}`, channel: "Test channel", channel_id: "channel-test", channel_url: "https://www.youtube.com/@test", duration: 120, format_id: "18", filesize: fixture.expectedBytes === undefined ? 128 : fixture.expectedBytes, comments: [{ text: "Saved locally", like_count: 4 }], ...fixture.metadata };
				child.stdout.write(JSON.stringify(metadata));
				return finish(0);
			}
			if(args.includes('--skip-download') && (args.includes('--write-subs') || args.includes('--write-auto-subs'))) {
				if(fixture.captionError) {child.stderr.write('Fixture captions unavailable');return finish(1);}
				const language=args[args.indexOf('--sub-langs')+1];
				const output=args[args.indexOf('--output')+1].replace('%(ext)s',`${language}.vtt`);
				fs.mkdirSync(path.dirname(output),{recursive:true});
				fs.writeFileSync(output,fixture.captionText || 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFixture offline caption\n');
				if(fixture.captionErrorAfterWrite) {child.stderr.write('Fixture captions interrupted after writing');return finish(1);}
				return finish(0);
			}
			const output = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
			fs.mkdirSync(path.dirname(output), { recursive: true });
			const partial=`${output}.part`,resumed=args.includes('--continue') && fs.existsSync(partial)?fs.statSync(partial).size:0;
			call.resumedBytes=resumed;
			const target=fixture.hold ? fixture.partialBytes ?? fixture.actualBytes ?? 128 : fixture.actualBytes ?? 128;
			if(!resumed) fs.writeFileSync(partial,Buffer.alloc(target,fixture.byte || 0));
			else if(resumed<target) fs.appendFileSync(partial,Buffer.alloc(target-resumed,fixture.byte || 0));
			child.stdout.write(`OFFGRID_PROGRESS|18|64|${fixture.expectedBytes || 128}|1000|1\n`);
			if (fixture.hold) return;
			later(() => {
				if (closed) return;
				if (fixture.error) { child.stderr.write("Test download failed"); return finish(1); }
				fs.renameSync(`${output}.part`, output);
				child.stdout.write(`OFFGRID_POSTPROCESS\n${output}\n`);
				finish(0);
			}, fixture.delay || 10);
		});
		return child;
	}
	const nativeRequire = createRequire(mainPath);
	const fsMock = { ...fs, statfsSync: () => ({ bsize: 1, bavail: availableBytes, blocks: 2e12, bfree: availableBytes }) };
	let sandbox;
	const requireMock = (name) => {
		if (name === "electron") return electron;
		if (name === "node:fs" || name === "fs") return fsMock;
		if (name === "node:child_process") return { spawn };
    if (name === './mpv-player.cjs' && playerFactory) return {createMpvPlayer:playerFactory};
    if (name === './local-network.cjs' && localAccessRequest) return {requestLocalNetworkAccess:localAccessRequest};
    if (name === './managed-mpv.cjs') return { createManagedMpv: () => ({ status: () => ({available:false,source:'managed',message:'Isolated fixture'}), ensure: async () => {}, dispose: async () => {} }) };
    if (name === './process-tree.cjs') return { killProcessTree: async child => child.kill('SIGKILL') };
    if (name === './app-updates.cjs' && updatesFactory) return {createAppUpdates:updatesFactory};
    if (name === './update-download.cjs' && updateDownloadFactory) return {createUpdateDownload:updateDownloadFactory};
		if (name === "node:https") return { get(url, _options, onResponse) {
			networkRequests += 1;
			const request = new EventEmitter();
			request.setTimeout = () => request;
			request.destroy = error => { later(() => request.emit("error", error || new Error("Request destroyed"))); return request; };
			if (fixtures.http?.[url]?.hold) pendingResponses.set(url, onResponse);
			else later(() => request.emit("error", new Error("Network disabled in tests")));
			return request;
		} };
		if (name === "./backend-core.cjs") {
			const coreContext = vm.createContext({ ...sandbox, module: { exports: {} } });
			vm.runInContext(fs.readFileSync(path.join(path.dirname(mainPath), name), "utf8"), coreContext);
			return coreContext.module.exports;
		}
		return nativeRequire(name);
	};
	sandbox = {
		require: requireMock, module: { exports: {} }, exports: {}, __dirname: path.dirname(mainPath), __filename: mainPath,
		process: { pid: process.pid, platform: process.platform, arch: process.arch, argv: launchUrls, env: { OFFGRID_TEST_MODE: testMode?'1':'0', OFFGRID_TEST_MPV: playerFactory?'1':'0', OFFGRID_DATA_DIR: dataDir, OFFGRID_YTDLP_PATH: "fake-yt-dlp", OFFGRID_FFMPEG_PATH: "fake-ffmpeg" }, on() {}, kill(pid) { const child = [...children].find(item => item.pid === Math.abs(pid)); if (child) child.kill(); } },
		console, Buffer, URL, Response, AbortController, structuredClone,
		setTimeout: later, clearTimeout,
		setInterval: (fn, delay) => {
			if (delay > 1000) return { unref() {} };
			const interval = setInterval(() => { if (alive) fn(); }, delay);
			intervals.add(interval); return interval;
		},
		clearInterval: (interval) => { clearInterval(interval); intervals.delete(interval); },
		setImmediate, clearImmediate,
	};
	const context = vm.createContext(sandbox);
	vm.runInContext(fs.readFileSync(mainPath, "utf8"), context, { filename: mainPath });
	await eventually(() => handlers.has("library:list"), "Electron IPC registration did not finish");
	const trustedEvent=()=>({sender:currentWindow.webContents,senderFrame:currentWindow.webContents.mainFrame});
	let api;
	const preloadContext = vm.createContext({
		require: () => ({
			contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
			ipcRenderer: { invoke: async (name, ...args) => {
				if (!handlers.has(name)) throw new Error(`Unknown IPC: ${name}`);
				return structuredClone(await handlers.get(name)(trustedEvent(), ...args));
			}, on() {}, removeListener() {} },
		}),
	});
	vm.runInContext(fs.readFileSync(path.join(path.dirname(mainPath), "preload.cjs"), "utf8"), preloadContext);
	return {
		dataDir, fixtures, handlers, events, calls, externalUrls, app, api,
		get window(){return currentWindow;},
		trustedEvent,
		invokeWithEvent:async(name,event,...args)=>structuredClone(await handlers.get(name)(event,...args)),
		invoke: async (name, ...args) => {
			if (!handlers.has(name)) throw new Error(`Unknown IPC: ${name}`);
			return structuredClone(await handlers.get(name)(trustedEvent(), ...args));
		},
		media: (url) => protocols.get("media")({ url }),
		setFreeBytes: (bytes) => { availableBytes = bytes; },
		setOnline: (value) => { online = value; },
		respondHttp: (url, body) => {
			const onResponse = pendingResponses.get(url);
			if (!onResponse) throw new Error(`No pending HTTP fixture for ${url}`);
			pendingResponses.delete(url);
			const response = new EventEmitter();
			response.statusCode = 200; response.headers = {}; response.resume = () => {};
			onResponse(response);
			response.emit("data", Buffer.from(body)); response.emit("end");
		},
		get networkRequests() { return networkRequests; },
		read: (filename) => JSON.parse(fs.readFileSync(path.join(dataDir, filename), "utf8")),
		async dispose({ remove = true } = {}) {
			app.emit("before-quit", { preventDefault() {} });
			await new Promise((resolve) => setTimeout(resolve, 5));
			alive = false;
			for (const timer of timers) clearTimeout(timer);
			for (const interval of intervals) clearInterval(interval);
			for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
			if (remove) fs.rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

module.exports = { createHarness, eventually };
