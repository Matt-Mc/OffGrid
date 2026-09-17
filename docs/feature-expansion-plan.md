# Offgrid feature expansion plan

Status: implemented in source, 2026-09-16. Approved scope based on the 0.3.1 checkout at `544a4d2`. The phase definitions below preserve the original plan; verification results are recorded at the end.

## Scope and delivery order

Build the three requested additions: batch downloads, resumable downloads, and quicker link capture. Include subtitles and smaller server copies from the previous recommendations as later phases. Trip packs, trip collections, and a separate trip dashboard are excluded.

Use the existing Downloads, Servers, Library, and Settings screens. Preserve the quiet Mac design described in `.impeccable.md`.

| Phase | Result for the user | Dependency | Relative effort |
| --- | --- | --- | --- |
| 1. Recoverable downloads | Pause a download and resume usable partial data after a connection failure or app restart | Existing queue and provider transfer adapters | Large |
| 2. Batch downloads | Review and queue YouTube playlists, multiple links, selected server titles, and whole seasons | Shared queue admission; phase 1 recommended before release | Large |
| 3. Send to Offgrid | Send a browser page or link into the download preview | Shared URL parser and phase 2 playlist preview | Medium |
| 4. Offline subtitles | Save selected captions/subtitles and use them without a connection | Asset ownership and playback integration | Medium–large |
| 5. Smaller server copies | Choose a smaller saved copy with clear processing and space requirements | Recovery, asset handling, and a feasibility checkpoint | Large; highest uncertainty |

Effort is comparative, not a calendar estimate. Each phase is independently reviewable. Phases 1–3 are the first delivery target; phases 4–5 extend media handling afterward.

## Baseline implementation and constraints (before this work)

- `electron/backend-core.cjs` owns a durable serial queue. It removes working files during startup reconciliation, retry, and failure handling. Its global pause means “Stop after current.”
- `electron/main.cjs` runs individual YouTube downloads and original Plex/Jellyfin transfers, admits work against storage limits, and commits finished items to the library.
- `electron/plex-client.cjs` and `electron/jellyfin-client.cjs` currently accept full-file `200` responses, create exclusive destinations, and delete interrupted transfers. Server browsing uses pages of 100 items.
- `src/components/Downloads.jsx` accepts one video link. `src/components/Plex.jsx` contains the shared browser for both server providers, with one download button per title.
- Existing duplicate checks avoid much duplicate work, but queue submission can report `accepted: true` when an existing queued job was returned. Batch summaries require an explicit outcome.
- Embedded tracks survive original server downloads. External subtitles and server artwork are not saved. Compatible YouTube files can use the HTML player; mpv provides broader playback.
- The package has no external URL scheme or browser extension. `main.cjs` has no single-instance or `open-url` capture flow.

Keep these contracts throughout the work:

1. Existing completed media and playback history survive migrations, retries, and failed operations.
2. Saved media, companion files, and retained partial downloads count toward the library limit. Keep the independent 2 GB free-disk reserve. Never delete saved videos automatically to admit work.
3. Keep one active media job. Metadata previews may use bounded concurrency; batch size must not create concurrent media transfers.
4. Validate server identities and connection revisions. Server credentials stay in the main process, in request headers, and on validated local connections. Keep redirect and public-destination restrictions.
5. Cancellation must stop writers before files are removed. Late metadata, thumbnail, subtitle, or conversion results cannot resurrect canceled jobs.

## Phase 1 — recoverable downloads

### User behavior

- Add per-item **Pause** and **Resume**. Pausing retains valid partial files; **Cancel download** discards the unfinished job's files. Keep **Stop after current** as the existing global queue control.
- Temporary connection failures retain reusable data and attempt recovery while Offgrid is open. Use a bounded retry schedule, initially three attempts at approximately 5, 15, and 60 seconds, then leave a visible retry action. A manual pause or global stop suppresses automatic restarts. Authentication, permission, and incompatible-source errors require user action. A usable local server must remain reachable without internet access.
- After reopening, interrupted active jobs offer **Resume**. Explicitly paused jobs remain paused; ordinary queued jobs retain their existing behavior. An unsupported resume is labeled as a restart rather than reporting preserved progress.
- Show retained bytes in the row and a short explanation when a changed source or quality selection requires a fresh download.
- Show unfinished downloads and their retained space in Settings → Storage, with explicit discard actions.

### Implementation

1. Introduce a versioned checkpoint schema in `downloads.json` or a companion manifest under the UUID job directory. Detect/migrate/reconcile state before the current `DurableQueue` constructor can clean files or persist defaults. Preserve unsupported future versions and corrupt state for recovery, surface the issue, and keep affected jobs inactive. Record provider/source identity, options, execution phase, expected size, reusable files, and validated transfer metadata. Derive paths in main; never accept destination paths from the renderer. Do not store credentials or signed media URLs.
2. Split cleanup into retaining validated inputs, discarding invalid working outputs, and canceling/removing the job. Add structured stop reasons so network errors, storage holds, user pause, cancellation, and shutdown have distinct policies. Update the queue status helpers and row actions together; paused jobs still participate in source deduplication.
3. On restart, validate owned paths, actual file lengths, manifests, and any completed library record before offering recovery. Legacy jobs without recoverable files remain restartable. Reject symlinks. Working artifacts must stay in the job directory; finalizing artifacts must match separate exact UUID paths derived in main under the media/asset directories.
4. Make shutdown wait for active transfer/process closure before final checkpoint persistence, with a bounded exit path. Reconcile forced termination from actual files at the next startup. Record finalization state so a crash between moving a completed file and saving library metadata neither deletes valid media nor creates duplicate library entries.
5. Adjust admission to reserve additional bytes as `max(0, required peak bytes - validated reusable bytes)`, while all existing files remain counted once in current usage. Invalidated files release space only after writers stop and deletion succeeds. Keep the current conservative YouTube processing allowance, original-server allowance, and active storage monitor. Other jobs' retained partials continue to consume the budget.

### YouTube recovery

Retain yt-dlp `.part`, fragment state, and completed input streams within the job directory and use its continuation support. Store selected format identities and output options so changed formats or quality cannot append incompatible data. Re-extract expiring download information on retry. Keep stable job IDs and output naming; add `--ignore-config` so external configuration cannot change the planned continuation or destination behavior. yt-dlp documents partial-file and fragment continuation, but actual recovery still depends on the source. [yt-dlp file options](https://github.com/yt-dlp/yt-dlp#filesystem-options)

Treat downloading and FFmpeg processing separately: an interrupted conversion restarts from validated complete inputs. Do not try to append an unfinished MP4 conversion. Prove this behavior with a real yt-dlp process against a disposable local HTTP fixture as well as the existing fake-downloader harness.

### Plex/Jellyfin recovery

Add a shared transfer helper with provider-specific request adapters. Save a strong representation validator when available. Resume with `Range`/`If-Range` only when the representation can be validated; check the `206` response range, total, and body length before appending. A `200` response starts a fresh transfer; invalid ranges, changed identity, or a `416` require revalidation and safe restart. Never treat equal file sizes alone as proof that content is unchanged. [HTTP range and validator semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)

Accept partial-content responses only on the validated download route. Recheck server identity and original media selection before resuming. If a provider cannot supply reliable representation identity, report restart-only behavior for that item. Verify real Plex/Jellyfin response headers during this phase before advertising source-specific resume support.

Suggested code boundaries: `electron/download-checkpoints.cjs`, `electron/range-transfer.cjs`, the existing queue and provider clients, `main.cjs`, `preload.cjs`, Downloads, Settings, and shared status helpers.

### Acceptance criteria

- Interrupt a transfer, reopen Offgrid, and resume the same job to a byte-identical fixture file without downloading its validated prefix again.
- Cover `206`, ignored ranges (`200`), wrong offsets/totals, changed validators, absent validators, truncated responses, excess bytes, and `416` responses. No mixed-version file can be committed.
- Pause survives reopen; cancel discards only the target job's incomplete files; changing quality invalidates only incompatible artifacts.
- Retained files are counted once. Storage holds, a lowered limit, unknown size, and low free disk space remain safe.
- A nearly complete transfer can resume when the remaining bytes fit; changed quality cannot claim reclaimed space before deletion succeeds. Interrupted schema upgrades preserve completed media, playback history, queue order, and recoverable partials.
- Interrupt processing and finalization at each durable boundary; recovery commits one complete item with correct progress and assets.
- Retry limits and stop controls prevent loops or unexpected background transfers. Existing cancellation and late-write tests continue to pass under the new retention policy.

## Phase 2 — batch downloads

### Shared batch admission

Create a bounded main-process batch service returning an ordered result for every requested item: `added`, `alreadyQueued`, `alreadySaved`, or `rejected`, with reasons and totals. Deduplicate canonical source IDs across URL variants, accepted selections, current jobs, and saved media. Persist all accepted jobs once before starting the worker. Repeated submission must return the existing jobs accurately.

Keep individual queue jobs with frozen quality/options. A small batch identifier may support result feedback, but does not introduce a collection or trip entity. Preserve manual priority and item order within the batch. Rejected items must not obscure successfully queued work. A stale server connection aborts preparation before queue commit.

Proposed bounds: 100 entries per preview page, 500 entries per submission, at most three concurrent metadata estimates, subprocess time/output limits, and cancelable preview requests. Larger selections use another batch; incomplete enumeration is explicitly labeled and never presented as a complete playlist or season.

### YouTube playlists and pasted links

- Accept either one link, multiple newline-separated links, or a playlist URL in Downloads. Review resolved items before submitting the batch.
- A watch URL containing `list=` offers **This video** and **Playlist**, defaulting to the current single-video behavior.
- Show ordered rows with selection controls, title, duration, availability, and saved/queued status. Unavailable, deleted, private, or unsupported entries are disabled with an explanation.
- Show selected count, known runtime/size, and the number of unknown estimates. Changing quality invalidates affected estimates. Estimates for flat playlist entries require separate selected-video metadata requests.
- Discover playlists in a dedicated bounded extractor, using a fixed set of yt-dlp arguments. The current channel feed appends `/videos` and must not be reused unchanged. Canonicalize each selected item to an individual video URL; actual downloads continue to use one job and `--no-playlist`.
- Discard stale preview responses on input changes and stop their subprocesses. A preview request never queues work. Canonical URL parsing should be shared with capture and manual submission.

### Plex and Jellyfin selection

- Add checkboxes and a selection footer to the existing shared Servers browser. Preserve selection across pagination within the current context; clear it on server, provider, library, search, or parent-context changes.
- Label **Select this page** precisely. Add **Download season…** from season rows and inside a season; enumerate every page and open a review of the resulting episodes.
- Expose numeric season/episode fields from provider normalization and sort by those fields, with stable item-ID tie-breaking. Do not depend on title sorting or parse episode numbers from display text.
- Submit item IDs. The main process fetches authoritative metadata and checks provider revision, server ID, and address again before committing the accepted batch.
- Existing permission, original-file, multi-version, and multipart restrictions become per-item explanations. Unexpected changes during enumeration must produce an incomplete/retry state; never silently claim all episodes were selected.

### Space estimates and result feedback

Show the selected expected total and unknown count alongside queued work. Whole-queue projection models cumulative completed files plus each next job's processing workspace and retained partials; it must not multiply every queued video's final size by the full processing multiplier. Label projections as estimates. Actual admission is rechecked before each transfer, with remaining jobs waiting for space as needed.

The result should read, for example: **18 added · 2 already saved · 1 unavailable**, with expandable details for skipped/rejected items. Keep those details available after the selection closes.

Suggested code boundaries: `electron/batch-downloads.cjs`, `electron/youtube-playlists.cjs`, shared URL normalization, `DurableQueue.addMany`, provider metadata/browse adapters, preload, Downloads, and `src/components/Plex.jsx`.

### Acceptance criteria

- A playlist with duplicates, URL variants, unavailable entries, and unknown sizes yields accurate ordered results and no duplicate downloads.
- A season larger than 100 episodes includes all pages in numeric episode order. Repeated pages, shifting totals, timeouts, and limits cannot loop or appear complete silently.
- Disconnect/reconnect while preparing a batch cannot admit work under a stale server identity.
- Selecting across pages, keyboard selection, quality changes, and partial result summaries work in the real UI.
- A submitted batch survives restart in order. When it exceeds available storage, completed items remain saved and waiting items recover correctly.
- Explicit manual re-add retains existing deleted-source behavior; automatic channel downloads still respect deleted-source exclusions.

## Phase 3 — quicker link capture

### First delivery: installed app + browser action

1. Add a single-purpose `offgrid://add?url=<encoded URL>` handler backed by the shared YouTube video/playlist parser. Accept one allowlisted action and parameter; reject credentials, unknown schemes/hosts, duplicate parameters, malformed encoding, and oversized values. Treat incoming URLs as data.
2. Register the macOS URL scheme in package metadata and listen for `open-url` before asynchronous app initialization. Acquire a single-instance lock after applying any isolated data-directory override and before initializing queue/storage writers. Restore or create the window and focus Downloads.
3. Buffer captures until the renderer is ready and acknowledge them after delivery. Preserve an unfinished draft, with a small pending-link indicator inside Downloads for additional captures. Persist a bounded pending list of up to 20 captures across renderer reload/restart, deduplicating repeated deliveries. Show an explicit full-list message rather than silently dropping captures. Capturing opens a draft; **Add to queue** remains the explicit user action.
4. Add a minimal Chrome/Edge Manifest V3 extension under `extensions/chromium/` with a toolbar action and **Send link to Offgrid** context menu. Use `activeTab` and `contextMenus`; read the URL only on user invocation. The extension hands off to the URL scheme and does not need server tokens, page scraping, or general browsing access.
5. Prototype browser external-protocol handoff early, including browser prompts. Explain installation/manual-open recovery without claiming success based on an unreliable “app installed” detector. Document unpacked development installation; keep store publication as a separate distribution step.

Electron requires macOS protocol integration to be exercised in a packaged app, and launch events can arrive before readiness. [Electron deep-link guide](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app) Chrome's temporary tab permission suits a user-invoked capture action. [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

Validate the calling frame for capture and download IPC. Block unexpected app-window navigation and popups so captured web content is never loaded into the privileged renderer. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

### Native macOS Share menu

A browser action fulfills the initial quick-capture feature. Native Share integration can follow after a small proof of URL handoff, native `.appex` packaging, entitlements, and signing in the existing installer pipeline. It requires a separate Xcode/Swift target; do not assume an Electron menu option registers Offgrid as a share receiver. Safari-specific extension distribution belongs to the same later native-integration decision. [Apple app-extension creation](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html)

Suggested code boundaries: `electron/link-capture.cjs`, shared URL parser, `main.cjs` lifecycle, preload capture read/ack/events, `src/main.jsx`, Downloads, `package.json`, and `extensions/chromium/`.

### Acceptance criteria

- Test cold launch, warm launch, minimized/closed window, renderer not ready, reload, burst captures, duplicate delivery, and an existing unsent draft.
- A captured playlist uses the same review as a pasted playlist. An offline capture preserves the draft until details can be loaded.
- Unsupported URLs and untrusted IPC callers are rejected without requests, file writes, or navigation to the supplied page.
- Only one process writes a given app data directory; isolated test installations do not collide.
- Verify real Chrome and Edge handoff into the installed Apple Silicon app, including browser prompts and retry behavior. Unit lifecycle mocks alone are insufficient.

## Phase 4 — offline subtitles

### User behavior

- Offer **Subtitles: None / available language** during download review, with an optional default language in Settings. Keep existing jobs' options frozen. Label human-authored and automatically generated YouTube captions distinctly and make automatic-caption fallback opt-in.
- Preserve embedded tracks in original server files and additionally save selected external text subtitles. Start with VTT and SRT; unsupported external formats are identified rather than silently dropped.
- Make the selected downloaded subtitle available in both mpv and the built-in YouTube player. Selected subtitle failures leave a playable video with a visible missing-subtitle warning and an asset-only retry action.

### Implementation

1. Add a versioned companion-asset manifest to library records: asset ID, type, language, caption origin, format, owned file identity, byte size, and availability. Include assets in storage, deletion, retry, and finalization accounting. Existing records migrate with an empty asset list.
2. YouTube: request the selected language with yt-dlp's subtitle options, prefer manual captions, and honor the explicit auto-caption setting. Retrieve/convert VTT or SRT locally, within size and time bounds. [yt-dlp subtitle options](https://github.com/yt-dlp/yt-dlp#subtitle-options)
3. Plex: discover external tracks belonging to the selected media and fetch allowlisted subtitle stream IDs through its sidecar stream route. Jellyfin: discover external tracks for the selected media-source ID and retrieve the chosen text subtitle using the subtitle API. Keep authentication in provider adapters and validate all IDs; no server-provided arbitrary URLs enter the renderer or player. [Plex stream API](https://developer.plex.tv/pms/) · [Jellyfin subtitle API](https://typescript-sdk.jellyfin.org/classes/generated-client.SubtitleApi.html#getSubtitle)
4. Save files under main-derived asset paths. Validate response type, format, byte limits, and completion before commit. Default limits: two requested languages and 5 MB per text track, included in the phase-specific space reservation. A failed optional asset must not cause a successful video transfer to restart.
5. Supply mpv with explicit validated local subtitle paths and disable automatic discovery of unrelated external files. For HTML playback, provide VTT `<track>` elements through a strictly routed `media://subtitle/<videoId>/<assetId>` endpoint. Never resolve arbitrary caller-supplied filesystem paths. [mpv external subtitle options](https://github.com/mpv-player/mpv/blob/master/DOCS/man/options.rst)
6. Add a distinct asset-retry operation to the serial queue, deduplicated by video/asset identity. It rechecks source access and updates the existing library record atomically without re-downloading the video. Disable/reject it if the video is deleted while the retry is running.

Suggested code boundaries: `electron/media-assets.cjs`, provider metadata/asset methods, `main.cjs` finalization and media protocol, `mpv-player.cjs`, preload, Downloads, Settings, and the players in `Library.jsx`.

### Acceptance criteria

- Human/auto captions, language fallback, unavailable subtitles, and supported/unsupported external formats produce the correct saved assets and UI.
- Watch the same captioned fixture offline through both mpv and the built-in player, with correct cue timing and language labels.
- Missing subtitle retry fetches only the asset. Cancel/delete during asset download or format conversion cannot create a late file or stale library entry.
- Oversized, incomplete, unauthorized, redirected, or wrong-type responses fail safely. Companion files are accounted for and deleted with their owning video.

## Phase 5 — smaller server copies

### Feasibility checkpoint and chosen fallback

Test Plex's dedicated download-queue API before implementing a server preparation path. Its documented queue produces downloadable media and may report that processing is still underway; Plex also documents lower-quality offline downloads. Prove target profile, permissions/subscription requirements, supported server versions, polling, cancellation, exact output size, and offline playback against a real local server. Capture only Offgrid-owned queue item IDs and remove only those preparation items. Do not substitute a streaming URL for a verified finished artifact. [Plex server download queue](https://developer.plex.tv/pms/) · [Plex download options](https://support.plex.tv/articles/downloads-sync-faq/)

Jellyfin currently documents download access but not sync/transcoding for that download feature. Use local conversion for Jellyfin; use it for Plex if the dedicated download-queue proof fails. A future provider implementation needs its own versioned capability evidence. [Jellyfin download permissions and limitations](https://jellyfin.org/docs/general/server/users/adding-managing-users/)

This checkpoint must result in a small provider capability table and a working disposable-media proof, followed by implementation of the supported path. It is not a reason to leave the smaller-copy feature indefinitely unspecified: local FFmpeg conversion is the planned common fallback.

### User behavior

- Keep **Original** as the default server option. Offer **Smaller copy — up to 720p** first; add 1080p after the same pipeline is verified.
- Show where conversion happens. For local conversion, explain that Offgrid downloads the full original before preparing the smaller copy, so it saves final library space but takes processing time and temporary space. A server-prepared copy is advertised only when capability checks passed.
- Show separate **Downloading** and **Preparing smaller copy** stages, with size estimates clearly marked. Do not promise a smaller result from resolution alone.
- Apply the option to new downloads; preserve existing source-level deduplication and saved originals. If an item is already saved, identify that result rather than silently replacing it.
- If conversion fails or produces a larger file, offer retry or **Keep original**. Retain the valid input as incomplete job data until that choice; keeping it still requires storage admission and never overrides the user's selected mode silently.

### Implementation

1. Introduce provider-aware saved-copy options separate from YouTube's current `quality` enum. Record transfer bytes, output estimate, and required peak workspace separately so progress and admission remain accurate.
2. Probe the managed FFmpeg build for the required encoders and filters. Provide a verified media-inspection tool alongside it if FFprobe is required; do not depend on a developer's system installation. The proof must cover the packaged runtime and update tool notices/manifests if a new binary is distributed.
3. For local conversion, finish and validate the resumable original transfer, then convert only that local file to a new output path. Start with an SDR H.264/AAC MP4 preset, preserved aspect ratio, no upscaling, and explicit stream mapping. Selected text subtitles remain sidecars; define handling for embedded tracks and expose unsupported required tracks before queueing. HDR/Dolby Vision conversion is unavailable until tone mapping and output verification are proven; Original remains usable for those sources. [FFmpeg stream selection and transcoding](https://ffmpeg.org/ffmpeg.html)
4. Reserve source plus bounded output workspace plus companion files and overhead, in addition to the disk reserve. Reuse phase 1 accounting for retained inputs. Continue enforcing limits while encoding; estimated output size is not a hard guarantee.
5. Inspect resolution, duration, audio, required subtitle assets, decode health, and actual size. Commit only a verified usable result; retain the original input until the completed output and library record are durably committed. Conversion cancellation discards an invalid output and keeps a validated input for pause/retry; explicit job cancellation discards the unfinished job's owned artifacts.
6. For a proven Plex server-prepared path, add bounded preparation polling, durable own-item IDs, recovery after app restart, cancellation of Offgrid's preparation item, and conditional transfer resume only when the returned artifact supports it. Keep source identity separate from transient preparation identity and preserve the local-network restrictions.

Suggested code boundaries: `electron/media-conversion.cjs`, managed-tool capability/inspection support, provider download adapters, queue execution/finalization, download options in the shared server browser, Downloads progress, and storage projections.

### Acceptance criteria

- A disposable original produces a smaller, playable copy with the intended resolution, duration, selected audio, and subtitle behavior. Already-efficient inputs do not incorrectly report space savings.
- Interrupted transfer resumes; interrupted encoding restarts safely from its complete input. App restart, cancel, and a lowered storage cap cannot leave an invalid output marked complete.
- Missing encoders, unsupported HDR/required tracks, larger-than-input output, and conversion failure have explicit outcomes and preserve useful inputs for recovery.
- Peak-space accounting includes retained input, growing output, and companion files. **Keep original** cannot bypass the configured cap.
- Verify the supported path using a packaged Apple Silicon build and disposable content from both a real Plex server and a real Jellyfin server; record server versions and any account/capability requirements.

## Review and release plan

Suggested implementation PRs:

1. Versioned checkpoints, explicit stop reasons, migration, storage accounting, and durable finalization.
2. YouTube continuation and per-item pause/resume UI.
3. Validated Plex/Jellyfin range transfers and source capability reporting.
4. Shared batch admission plus server multi-select/season review.
5. YouTube playlist and multiline-link preview.
6. Packaged capture receiver and browser extension.
7. Offline subtitle assets and playback.
8. Smaller-copy feasibility checkpoint, followed by the supported conversion implementation.

Keep changes to `main.cjs` as orchestration; isolate new policy/protocol logic in focused modules instead of combining the whole roadmap into a refactor.

For each PR, extend the relevant existing backend/IPC fixtures, run `npm test` and `npm run build`, and run the affected Electron smoke scripts. Use `test:ui` for download/library changes, `test:plex-ui` and `test:jellyfin-ui` for server flows, and update UI smoke coverage when lifecycle changes affect startup. Use isolated data and disposable media.

Before shipping phases 1–3, exercise their combined flow in a packaged Mac build: capture a playlist, queue selected entries and a server season, interrupt transfers, reopen, resume, and watch the completed files with the network disconnected. Source-specific resume claims require real provider evidence in addition to fixtures. Record exactly which providers and versions were checked; fixture success does not establish live YouTube behavior or support for additional operating systems.

Update README limitations, development notes, and release notes as each capability is delivered. No release is implied by approval of this plan.


## Implementation and verification record

Implemented all five phases in this checkout. Trip packs remain excluded. The source version remains 0.3.1; this work has not been published as a new release.

| Area | Delivered and verified | Boundary |
| --- | --- | --- |
| Recovery | Schema migration; per-job pause/resume/discard; bounded retries; owned checkpoints; validated Range/If-Range; finalization journals; retained-byte admission | Strong validators are required for server byte append. A local Plex fixture proves main/queue/provider resume composition, including LAN use while internet status is offline. Actual personal-server headers remain unverified. |
| Batches | Multiple links and paginated playlists; unique selection; explicit outcomes; server selections across pages and whole seasons; cancellation; trusted estimate cache and cumulative space projection | Previews are bounded, unknown sizes remain explicit, and batches accept at most 500 items. |
| Capture | Packaged URI scheme, single instance, persistent inbox, draft/options saved before capture acknowledgment, unpacked Chrome/Edge extension | Browser store publication, actual Chrome/Edge external-app confirmation, minimized-window OS delivery, and native Share integration remain manual distribution checks. |
| Subtitles | Bounded VTT/SRT assets, optional auto captions, library ownership/storage/deletion, HTML/mpv integration, independent retries with durable asset journals | Actual Electron HTML cue loading passed. Provider subtitle routes are covered by local fixtures; live server subtitle compatibility is not established by them. |
| Smaller copies | Local managed-tool path, Original fallback, 720p H.264/AAC conversion, all audio tracks, supported embedded text subtitles, output checks and retained input recovery | Full original bytes transfer first. HDR, image subtitles, and more than two embedded subtitle tracks require Original. Server-side optimization is not enabled. |

### Checks completed

- `npm test`: 241 passed, no failures or skips. Includes corrupt/future queue state, byte-range adversarial cases, canceled writers, subtitle ownership, staged/final asset crash windows, batch cancellation/connection revision, conversion rejection and fallback, and real local FFmpeg encoding/decoding of generated media.
- `npm run test:ui`: passed with actual offline HTML subtitle cues, playback persistence, storage/deletion, and narrow-window layout.
- `npm run test:plex-ui`, `npm run test:jellyfin-ui`, `npm run test:updates-ui`: passed with disposable fixtures.
- `npm run test:features-ui`: passed including multi-page server selection, season cancellation, draft reload, duplicate playlist cursor handling, persistent batch results, queue projection, and pause/discard/subtitle controls.
- `npm run build` and `npx electron-builder --dir --mac --arm64`: passed. Built app has the expected `CFBundleURLTypes` entry. `codesign --verify --deep --strict` passed. Notarization was skipped; `spctl --assess --type execute` rejected this local build.
- `node scripts/smoke-packaged-capture.cjs`: passed against the new local Mac package. Cold argv capture, warm second-instance delivery/deduplication, typed and opened-capture drafts across restart, inbox persistence, no implicit queueing, and clean shutdown were verified. This does not invoke the global OS/browser protocol handler.
- `node scripts/smoke-download-runtime.cjs`: passed with real yt-dlp and bundled mpv. A generated byte-identical `.part` prefix of 270,409 bytes resumed through an observed `Range: bytes=270409-`; the 1,081,638-byte result matched the generated source SHA-256. The prefix is seeded, so this proves continuation rather than a real first-download interruption. Bundled mpv exposed the external VTT through its track-list IPC; it ran headlessly (`--vo=null`), so visible native subtitle rendering remains a separate check.

### Server preparation capability decision

Plex documents a dedicated Download Queue API, but documentation alone does not prove target-quality selection, account permission, readiness, cancellation, durable range identity, or playback for this app. No disposable configured Plex server was available for that full proof. Jellyfin's user documentation states that syncing/transcoding is not available under its download permission; playback transcoding does not establish a durable downloadable-artifact contract. Therefore both providers use the tested local conversion path; provider optimization is deferred behind a future live feasibility check. [Plex PMS API](https://developer.plex.tv/pms/), [Plex download FAQ](https://support.plex.tv/articles/downloads-sync-faq/), [Jellyfin users and download permission](https://jellyfin.org/docs/general/server/users/adding-managing-users/).
