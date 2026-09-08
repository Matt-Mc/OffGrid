# Offgrid UI/UX refresh plan

Status: implemented. The three core phases below are delivered; the “Later” section remains deferred. This document retains the accepted design rationale and behavior contract.

Audience and tone confirmed by the owner: personal use and travel, with a quiet, native Mac feel.

## Product direction

Make it easy to prepare a small offline library before a trip, know what is ready to watch, and keep disk usage predictable. Prioritize Settings, a dependable download queue, and storage management before advanced automation.

Three possible scopes:

| Approach | Benefit | Tradeoff |
| --- | --- | --- |
| Settings only | Smallest change; exposes quality and channel defaults | Leaves downloading, browsing, and playback competing in Library |
| Focused refresh — recommended | Separate Library, Downloads, Following, and Settings; enforce storage limits | Needs persistent settings, queue state, and disk accounting |
| Full media manager | Collections, playlists, scheduling, retention rules, external libraries | Much larger build before the core travel experience improves |

## Current findings

- Library combines the add form, active downloads, an inline player, and saved videos (`src/main.jsx`).
- The settings icon opens downloader diagnostics; there is no dedicated settings screen or persisted user preferences.
- Manual downloads offer 720p, 1080p, and Best available. Size estimation requires a separate click.
- Following downloads the latest three videos at 720p, immediately after following and on scheduled checks every six hours (`electron/main.cjs`). Those values are hard-coded.
- Downloads have progress reporting, but no durable queue, cancellation API, or job history. A download error clears all visible jobs in the renderer.
- Video sizes are recorded, but no aggregate storage budget or free-disk protection is enforced.
- Estimates can omit an unknown audio/video stream size; treat incomplete totals as uncertain. MP4 conversion also needs temporary space and can change the final size.
- Deleting a video leaves its thumbnail behind. A followed channel can download that video again because sync only checks the current library.
- Playback position and watched state are not persisted.

## Screen structure

Persistent sidebar: **Library**, **Downloads** with active count, **Following**. Place **Settings** at the bottom with a small storage summary that opens Settings → Storage.

**Library**

- Saved videos are the primary content. Keep search, sort (recently saved, title, size), and an Add video button in the toolbar.
- Add video opens the composer in Downloads. Avoid a permanent large download form above the library.
- Open videos in a dedicated player view with Back to Library, preserving search and scroll position. Do not interrupt playback just because the user opens Settings or Downloads.
- Add watched/unwatched filters and Continue watching when playback progress persistence is implemented.
- Use explicit keyboard-accessible play controls and an overflow menu for secondary actions. Confirm permanent deletion with the video's title and size; do not offer an undo unless files are actually recoverable.

**Downloads**

- Paste a link → fetch title, duration, and estimated size → choose quality → Add to queue.
- Quality starts from Settings, with a visible override for this download. Label resolution choices as “Up to 720p”, etc.; never imply a source can be upgraded.
- Estimate automatically after a valid link and whenever quality changes. Cancel or ignore stale metadata responses. Show “Size unavailable” when necessary.
- Separate active/queued items from completed and failed items. Each job keeps its own status and recovery action.
- Distinguish Preparing, Downloading, Processing, Ready, Failed, Canceled, and Waiting for space/connection. “100% downloaded” is not yet “Ready to watch”.
- First release: cancel, retry, and Stop after current (holds queued jobs). Add in-progress pause/resume only after resumability is verified.
- Show a clear offline state while leaving the local library fully usable.

**Following**

- Each channel shows automatic downloads on/off, last check, next check, and a concise rule summary.
- Following a channel does not silently start downloading. Show the initial fetch count and automatic-download choice before confirming.
- Offer Check now. Route every resulting download through the same queue and storage checks as manually added videos.
- Keep one consistent verb: Follow / Unfollow. Unfollowing leaves saved videos intact.
- Say “while Offgrid is running and online”; do not promise scheduled checks while the app is quit or the Mac is asleep.

**Settings**

Use one page with clearly separated Downloads, Storage, Following, and About & Diagnostics sections. Add section navigation only if the page grows enough to need it. Settings must also open through the macOS app menu and ⌘,.

## Settings and proposed defaults

Defaults below are proposals for new installations. Preserve existing users' files and behavior during migration, and make new limits explicit.

| Section | Control | Proposed behavior/default |
| --- | --- | --- |
| Downloads | Default quality | Up to 720p; offer 480p, 720p, 1080p, Best available. Add 480p support to the downloader. |
| Downloads | Download available comments | Off for new installs; keep local thumbnails and basic metadata. Preserve the existing comments preference on migration. |
| Storage | Maximum library size | Suggest 20 GB, editable with 10 / 20 / 50 / 100 GB presets and Custom; allow No limit. First enablement requires an explicit saved choice. |
| Storage | Usage | Show saved media, temporary download files, library limit, and actual free disk space as distinct values. |
| Storage | When full | Hold new jobs and show Manage storage. Never delete saved videos automatically. |
| Storage | Manage storage | List videos by size or date, select items, and preview the actual bytes to remove before confirmation. |
| Storage | Library location | Display current folder and Reveal in Finder. Moving the library is a later feature. |
| Following | Automatic downloads | Off for new follows unless selected; preserve existing followed-channel behavior on migration. |
| Following | Check frequency | Manual, every 6 hours, every 12 hours, daily; 6 hours when automatic checks are enabled. |
| Following | Recent videos to fetch | 1 / 3 / 5 / 10 per channel per check; default 3. Explain this is a fetch count, not a retention limit. |
| Following | Quality | Use download default; add per-channel overrides later. |
| About & Diagnostics | Download components | Friendly readiness summary, app version, update action, expandable yt-dlp/FFmpeg details. |

Save simple toggles and selectors immediately with inline error feedback and rollback on failure. Use an explicit Apply action for the numeric storage limit, showing its effect before saving. Setting changes affect future jobs; queued jobs retain their recorded options unless explicitly edited.

## Storage-limit contract

The label should be **Maximum library size**, not “Maximum app size”. Count saved media, thumbnails, and download working files toward the library budget. Show application support data and managed downloader binaries separately. Define and consistently display units; use decimal GB for this plan.

1. Enforce the budget in Electron's main process for every download source, not only by disabling a UI button.
2. Before starting a job, account for files already on disk, remaining reservations for other active jobs, the proposed download, and merge/transcoding working space. Do not double-count bytes that moved from a reservation to disk.
3. Check actual free disk space independently of the chosen library limit. Propose a 2 GB disk reserve in addition to estimated working space, with the precise working-space policy verified against the download pipeline.
4. Size estimates are imperfect. Monitor actual working-directory usage during download and processing, and stop the responsible job if it cannot stay within budget. Never publish a completed item into the library if doing so violates the budget. Filesystem buffering means a logical budget is not a guaranteed OS-level hard quota; bound and document transient overshoot.
5. When size is unknown, hold the job with a clear explanation and allow choosing lower quality or increasing/removing the library limit. Still retain free-disk protection. Do not display a fabricated estimate.
6. Lowering a limit below existing usage keeps all saved videos and holds new jobs. Example: “Your library uses 24 GB. New downloads will wait until usage is below 20 GB.”
7. If a changed limit affects active jobs, show that impact before Apply, then stop affected work safely. Never evict existing videos to make the new value appear satisfied.
8. Cancellation, failure, and restart recovery reconcile partial files and release reservations. Cleanup only removes positively identified Offgrid-owned files.
9. Manual deletion removes the associated thumbnail and metadata as well as the video. Preserve a source-ID exclusion for automatic channel sync so a deleted video stays deleted; explicitly adding its link can override that exclusion.
10. A storage-blocked job stays visible with Manage storage, Change quality, and Retry. Freeing space does not restart user-paused jobs. Newly eligible automatic jobs may resume only under the user's existing automatic-download preference.

## Visual direction

- Quiet native Mac utility: restrained color, clear typography, subtle separators, familiar form rows, comfortable spacing.
- Retain Offgrid's muted green identity; use thumbnails as the main visual emphasis in Library.
- Avoid wrapping every setting in its own card. Group related rows and keep explanatory text beside the control it explains.
- Use a compact, labeled storage bar, with saved and temporary usage distinguishable without relying only on color.
- Errors remain next to affected settings or jobs until resolved; reserve disappearing notices for nonessential confirmations.
- Support keyboard navigation, visible focus, readable secondary text, reduced motion, and narrower desktop windows. Theme support can follow the core refresh.

## Implementation sequence

### 1. Establish preferences and navigation

Split `src/main.jsx` into a shell and screen components. Add validated, versioned preferences owned by Electron, atomic persistence, and typed/validated IPC contracts through `electron/preload.cjs`. Build Settings and its app-menu shortcut. Move diagnostics there; connect quality, comments, and channel defaults to their actual behaviors. Migrate existing users without deleting data or silently enabling a cap.

### 2. Make downloads and storage dependable

Add durable jobs with stable IDs, per-job errors, recorded options, process handles, cancel/retry, and restart reconciliation. Start with one active download. Route channel and manual jobs through the same scheduler, deduplicate by source ID, and prioritize manually added jobs over pending automatic jobs. Build real disk accounting, reservations, the library budget, cleanup, and the storage manager. Fix deletion and automatic-redownload behavior in this phase.

### 3. Refine watching and trip preparation

Finish the Library and player layouts, persist playback position and watched state, add Continue watching and watched filters, and improve Following summaries and empty states. A compact “ready to watch / still downloading” summary supports trip preparation without introducing a separate trip-planning feature.

### Later

Bandwidth limit; 1–3 simultaneous downloads once reservations are concurrency-safe; verified in-progress pause/resume; per-channel quality overrides; subtitles and language preferences; external-library migration; appearance preference. Consider optional watched-video cleanup only after watched state is reliable and users can protect videos from deletion.

Defer playlists, custom codecs, arbitrary downloader arguments, complex calendars, and “Wi-Fi only” for the first refresh. Wi-Fi alone does not distinguish a home connection from a phone hotspot; manual control is clearer until network policies are deliberately designed.

## Acceptance checks for implementation

- Preferences survive restart and are validated in the main process; legacy libraries migrate intact.
- Quality changes apply to new manual and automatic jobs consistently, with visible per-job overrides.
- One failed job leaves all other queue entries visible and accurate.
- Cancel and app restart reconcile partial files, job status, and reserved space.
- Manual and channel jobs cannot bypass the storage budget; cover estimates that grow, unknown sizes, processing workspace, and low free disk space.
- Lowering the cap never deletes existing videos; cleanup reflects real filesystem usage, including thumbnails.
- Deleted followed-channel videos do not reappear after sync; explicit manual re-add still works.
- Offline playback, thumbnails, search, Settings, and saved progress work without network access.
- Keyboard-only navigation reaches every primary action; changing screens preserves playback and library context.

Implementation verification: isolated backend tests cover preferences, migration, queue lifecycle, storage admission and live monitoring, playback persistence, and channel deletion exclusions. The real Electron smoke test exercises Settings controls (including a fractional custom GB limit), queue cancel/retry, local playback across navigation, deletion during playback, and an 820 px window. Rendered Library, Downloads, Following, and Settings screens were visually inspected. Test media and application data are disposable fixtures; live YouTube downloading was not exercised during this refresh. See README for test and launch commands.
