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

Mac/Linux development runs use an installed mpv for native playback. Windows x64 runs provision a pinned upstream player into the app data tools folder. Packaged Mac builds require the app-private runtime described below. The general UI smoke test also needs an `ffmpeg` executable on PATH to generate its sample clip. The managed FFmpeg inside a normal Offgrid installation does not automatically satisfy that test requirement.

### Windows

Use Windows x64 with Node.js 22+. Player setup downloads a pinned official 7-Zip standalone extractor, so it does not depend on the compression support in the system archive tool. Run `npm run dist:win` for the NSIS installer and `npm run verify:win` for real player setup, offline reuse, named-pipe playback, pause/resume, progress, EOF, and descendant-process cancellation. The native verification creates and removes disposable media; its initial pinned player download requires internet.

Windows `mpv` starts idle and receives its local file over a random named pipe after event subscriptions are attached. Unix keeps inherited descriptor IPC. The renderer never supplies an executable path, pipe name, or player command. Windows download cancellation awaits `taskkill /T /F` before temporary-file cleanup. A termination failure pauses the queue and preserves working files.

The private player folder also includes a checksum-pinned x64 Vulkan loader from LunarG, so mpv can start without a preinstalled Vulkan runtime. Only the loader and its license are read from that verified ZIP, using Windows PowerShell's built-in ZIP support. The standalone 7-Zip extractor handles the player archive's LZMA compression, which older Windows system tar builds lack.

`electron/managed-mpv.cjs` pins the upstream player and extractor URLs, sizes, SHA256 values, and extracted player executable/DLL hashes. When upgrading it, update all pins together, verify the baseline x86_64 build (not x86_64-v3), and run the native checks. Setup verifies the standalone extractor before executing it, extracts only the named player executable and DLL, and deletes the temporary extractor. Upstream player install/update scripts are never run. No Windows mpv binaries are redistributed in the installer.

Some Windows developer machines need Developer Mode or an elevated terminal for electron-builder's downloaded tool archive, which contains unused macOS symlinks. File-symlink tests explicitly skip when Windows denies that privilege; directory-junction coverage still runs. Mac-only Homebrew path/provenance tests run on the Mac CI job.

`SHA256SUMS-windows` covers the Windows installer independently of the Mac checksum file. The update downloader requires the exact platform filename, checksum, size, and a valid PE header before opening a Windows installer. No signing certificate is configured yet.

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
| `electron/app-updates.cjs`, `electron/update-download.cjs` | Compatible GitHub release discovery and verified installer downloads |
| `tests/`, `scripts/smoke-*.cjs` | Backend fixtures and actual Electron UI checks |

## Verification

```bash
npm test
npm run build
npm run test:ui
npm run test:plex-ui
npm run test:jellyfin-ui
npm run test:updates-ui
```

Backend tests exercise real application code with isolated files, mocked OS facilities, and local HTTP fixtures. They need permission to bind loopback sockets. They do not contact personal media servers or download actual YouTube content.

UI smoke scripts launch a separate Electron process with temporary app data and print the screenshot directory. They require a graphical desktop session. The server UI tests use disposable credentials and the real OS credential storage. Native mpv launching is disabled in those fixtures; actual native playback requires separate verification.

At the 0.3.1 implementation checkpoint, 150 backend, packaging, and updater tests passed on macOS Apple Silicon. Plex/Jellyfin UI checks, update-banner fixtures, and native bundled-player playback, pause/resume, and saved-position checks also passed. Those results are fixture verification, not proof of live YouTube/Jellyfin behavior or cross-platform support. A live Plex connection was confirmed separately during personal use.

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

On an Apple Silicon Mac with Homebrew, prepare the complete runtime and its corresponding-source archive, then build the DMG:

```bash
brew install mpv
npm run bundle:mpv
npm run bundle:mpv-sources
node scripts/verify-bundled-mpv.cjs
npm run dist
```

After preparing the runtime and sources, build an unpacked app directory:

```bash
npm run build
npx electron-builder --dir --mac --arm64
codesign --verify --deep --strict release/mac-arm64/Offgrid.app
```

`npm run dist` builds a macOS ARM64 DMG. It does not produce releases for other platforms. Build output goes in the ignored `release/` directory; bundled runtime inputs and source caches go in ignored `vendor/`.

Packaging fails unless every staged runtime file matches its hash and the matching source archive/notices are present. The bundled manifest records input hashes before app signing, which can change executable signatures. See [third-party runtime provenance](third-party.md) for source collection and rebuilding details. The release asset checksums cover the final DMG.

Test the actual packaged player with Homebrew excluded from its PATH:

```bash
node scripts/verify-bundled-mpv.cjs release/mac-arm64/Offgrid.app/Contents/Resources/mpv
```

`--headless` checks decoding and player IPC without a window, as used in CI. The normal invocation also exercises native graphics playback. Neither is a substitute for testing the installer on a clean recipient Mac. The minimum macOS version depends on the runtime libraries, is enforced by the app's Info.plist, and is recorded in the manifest and release notes; a locally built runtime can require a newer OS than the CI build.

The custom macOS signing hook adjusts the main executable's Mach-O UUID per app/version and replaces Electron's original signature. It uses a configured Apple identity when available and ad hoc signing otherwise. Local ad hoc builds are not notarized and do not establish stable distribution identity across updates. Installer builds must retain the local-network usage description in `package.json`.

Windows and Linux installer targets and native verification remain roadmap work. Merely producing an executable on another OS is not sufficient to call it supported.

## Preparing a GitHub release

1. Keep the MIT license with the source and check the licensing/redistribution requirements of any binaries included in the release. mpv is bundled with its license notices and matching source archive; managed download tools are fetched at runtime.
2. Run the relevant tests/build and inspect UI screenshots. For platform support claims, also test actual installs, keychain access, local-network prompts, playback/resume, cancellation, and restart on that OS.
3. Review Electron and other dependency versions before publishing a build intended for wider use.
4. Write release notes with supported OS/architecture, known limitations, and signing status. Attach installers to GitHub Releases, not Git history.
5. Exclude `node_modules/`, `dist/`, `release/`, local app data, and credentials. The repository's ignore rules cover the standard local directories; arbitrary external data-directory choices remain your responsibility.

## Automated releases

[Build macOS release](../.github/workflows/release.yml) runs on stable version tags (`v0.3.0`, for example), or manually from the Actions page. It uses a macOS 15 ARM64 runner, installs build tools, runs the backend tests, bundles mpv and matching sources, verifies native decoding/control, builds and verifies the DMG, then uploads checksummed assets. Only tag runs publish to GitHub Releases; manual runs provide temporary workflow artifacts.

To release a new patch from a clean, tested `main` checkout:

```bash
npm version patch
git push origin main --follow-tags
```

The tag must match `package.json`; prerelease version strings are rejected by this stable-release workflow. The publication job has `contents: write`, while the build job only has read access. No personal access token is needed: publishing uses the job's `GITHUB_TOKEN`. Actions must be enabled in the repository. Binaries are ad hoc signed; no Apple signing secrets are configured by this workflow.

A release is published with its DMG, SHA256 checksums, staged runtime manifest, and corresponding-source archive. A failed source collection or verification blocks publication. If uploading a new release fails, it remains a draft; a rerun can replace draft assets and finish publication. Already-published versions are never overwritten—bump the version for another build. GitHub chooses the Latest release automatically from release dates and versions.

The release uses the Homebrew bottles available on the runner and archives their exact installed recipes and matching sources. This records the inputs actually shipped; it does not claim that rerunning the workflow later selects the same bottles or produces byte-identical binaries.

## In-app update checks

Packaged apps schedule a bounded GitHub release check after startup, without delaying the library. The renderer requests another check when its connection returns; automatic checks are throttled to once per minute. Settings provides a manual check. Development and test runs do not check real releases.

The main process accepts only newer stable versions from `Matt-Mc/OffGrid`, with matching ARM64 DMG/checksum assets and a runtime manifest compatible with the current macOS version. Offline checks and GitHub failures stay quiet. The renderer cannot supply an installer URL or local path.

Choosing **Update** downloads to a private temporary directory under the app's `updates/` data folder. The downloader enforces size limits and a free-disk reserve, verifies the exact SHA256SUMS entry and GitHub's digest when supplied, checks the DMG footer, then opens the installer. Cancellation and failed verification remove partial files. A completed installer can be reopened after local integrity verification. Saved videos are untouched.

This is an installer update flow: the user quits Offgrid and replaces the app through Finder. [Electron's macOS automatic updater requires code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing); fully automatic replacement needs a proper Apple-signed update pipeline. Do not describe the current ad hoc release as a silent auto-updater. No GitHub token is stored in the app.
