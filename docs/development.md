# Developing Offgrid

[Back to the README](../README.md)

Offgrid uses React + Vite for the renderer and Electron's main process for filesystem access, downloads, credentials, and native playback. The renderer communicates through a small preload API; it does not receive decrypted server tokens.

## Setup

Use Node.js 22+ and npm from the repository root:

```bash
npm ci
npm run dev
```

`npm run dev` starts Vite on loopback and launches Electron when the server is ready. `npm run build` only builds the renderer; `npm start` runs Electron against that build.

Install mpv for native playback. The general UI smoke test also needs an `ffmpeg` executable on PATH to generate its sample clip. The managed FFmpeg inside a normal Offgrid installation does not automatically satisfy that test requirement.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/main.jsx`, `src/components/` | Library, Downloads, Following, shared Plex/Jellyfin browser, Settings, and player UI |
| `src/styles.css`, `.impeccable.md` | Visual styles and agreed product design context |
| `electron/main.cjs` | App lifecycle, IPC, managed tools, shared download execution, and storage integration |
| `electron/backend-core.cjs` | Durable serial queue, storage admission, settings validation, and persistence helpers |
| `electron/preload.cjs` | Renderer-facing API |
| `electron/plex-client.cjs`, `electron/jellyfin-client.cjs` | Local server protocols, metadata normalization, and original-file transfers |
| `electron/*-connection.cjs` | Encrypted credentials and connection state |
| `electron/local-network.cjs` | Credential-free, bounded TCP reachability probe |
| `electron/mpv-player.cjs` | Native playback control and progress persistence |
| `tests/`, `scripts/smoke-*.cjs` | Backend fixtures and actual Electron UI checks |

## Verification

```bash
npm test
npm run build
npm run test:ui
npm run test:plex-ui
npm run test:jellyfin-ui
```

Backend tests exercise real application code with isolated files, mocked OS facilities, and local HTTP fixtures. They need permission to bind loopback sockets. They do not contact personal media servers or download actual YouTube content.

UI smoke scripts launch a separate Electron process with temporary app data and print the screenshot directory. They require a graphical desktop session. The server UI tests use disposable credentials and the real OS credential storage. Native mpv launching is disabled in those fixtures; actual native playback requires separate verification.

At the 0.2.0 implementation checkpoint, 96 backend tests and all three UI suites passed on macOS Apple Silicon. Packaged Plex and Jellyfin UI checks also passed. Those results are fixture verification, not proof of live YouTube/Jellyfin behavior or cross-platform support. A live Plex connection was confirmed separately during personal use.

For a packaged server UI test on macOS:

```bash
OFFGRID_SMOKE_APP="$PWD/release/mac-arm64/Offgrid.app/Contents/MacOS/Offgrid" node scripts/smoke-plex-ui.cjs
OFFGRID_SMOKE_APP="$PWD/release/mac-arm64/Offgrid.app/Contents/MacOS/Offgrid" node scripts/smoke-jellyfin-ui.cjs
```

Screenshots in the README come from disposable sample-library fixtures. Regenerate with `npm run test:ui`, inspect the result, and copy only the intended image from the printed temporary screenshot directory into `docs/images/`.

## Local configuration

No `.env` file is required. Pass application runtime overrides through your shell when needed. Examples below use a POSIX shell; in PowerShell use `$env:VARIABLE = 'value'` before the npm command.

| Variable | Purpose |
| --- | --- |
| `OFFGRID_DATA_DIR` | Override app data directory. For development, use an absolute path to an isolated folder such as the ignored `local-data/` directory. |
| `OFFGRID_PLEX_URL` | Suggest a Plex address on the connection form; contains no token. |
| `OFFGRID_JELLYFIN_URL` | Suggest a Jellyfin address, including a base path if needed. |
| `OFFGRID_YTDLP_PATH` | Provide a fallback yt-dlp executable. |
| `OFFGRID_FFMPEG_PATH` | Provide a fallback FFmpeg executable. |
| `OFFGRID_TEST_MODE=1` | Disable startup tool updates/channel checks and native playback for fixtures; requires explicit test downloader paths for YouTube operations. |
| `OFFGRID_TEST_MPV=1` | Allow real mpv while test mode is enabled, for deliberate native-player checks. |

Example:

```bash
OFFGRID_DATA_DIR="$PWD/local-data" OFFGRID_JELLYFIN_URL=http://192.168.1.20:8096 npm run dev
```

Do not commit application data, real server tokens, passwords, or private media. Changing the data directory is a development override, not a supported library migration feature. OS-bound credentials may need reconnecting when an installation or machine changes.

## Storage and cancellation contracts

- Count videos, thumbnails, and temporary media against the optional library cap; keep existing files when a new download does not fit.
- Reserve 2 GB of free disk space. YouTube jobs reserve three times the estimated size plus 16 MB; original Plex/Jellyfin files reserve one copy plus 16 MB.
- Check active jobs for storage violations. This is a logical budget, not an OS-enforced quota; buffering and changing estimates can briefly exceed it.
- Reject late writes after cancellation. Clean up owned partial files without deleting completed media.
- Preserve provider/source identities across retries and restarts. Disconnecting one server must not cancel another provider's work.
- Never send credentials to public destinations or redirects. Never put tokens in media URLs or renderer responses.

## Packaging

On macOS, build an Apple Silicon DMG:

```bash
npm run build
npx electron-builder --mac dmg --arm64
```

For an unpacked app directory:

```bash
npm run build
npx electron-builder --dir --mac --arm64
codesign --verify --deep --strict release/mac-arm64/Offgrid.app
```

`npm run dist` uses electron-builder's defaults for the host. It is not a command that produces supported releases for all platforms. Build output goes in the ignored `release/` directory.

The custom macOS signing hook adjusts the main executable's Mach-O UUID per app/version and replaces Electron's original signature. It uses a configured Apple identity when available and ad hoc signing otherwise. Local ad hoc builds are not notarized and do not establish stable distribution identity across updates. Installer builds must retain the local-network usage description in `package.json`.

Windows and Linux installer targets, native verification, and CI remain roadmap work. Merely producing an executable on another OS is not sufficient to call it supported.

## Preparing a GitHub release

1. Keep the MIT license with the source and check the licensing/redistribution requirements of any binaries included in the release. mpv is currently installed separately; managed download tools are fetched at runtime.
2. Run the relevant tests/build and inspect UI screenshots. For platform support claims, also test actual installs, keychain access, local-network prompts, playback/resume, cancellation, and restart on that OS.
3. Review Electron and other dependency versions before publishing a build intended for wider use.
4. Write release notes with supported OS/architecture, known limitations, and signing status. Attach installers to GitHub Releases, not Git history.
5. Exclude `node_modules/`, `dist/`, `release/`, local app data, and credentials. The repository's ignore rules cover the standard local directories; arbitrary external data-directory choices remain your responsibility.

The repository currently has no automated cross-platform release workflow. Publishing to GitHub and creating releases are separate steps from building the app locally.
