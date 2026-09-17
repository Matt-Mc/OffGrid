# Send to Offgrid

Minimal Chrome/Edge Manifest V3 extension for YouTube videos and playlists. It opens a small handoff tab with an **Open in Offgrid** link; your browser may ask before opening an external app. Offgrid receives a draft for review and does not start a download automatically.

## Local installation

1. Build and install the packaged Offgrid macOS app. Open it once so the `offgrid://` protocol is registered. Running `electron .` does not register a macOS protocol handler.
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, and choose **Load unpacked**.
3. Choose this `extensions/chromium` directory. Pin **Send to Offgrid** if desired.
4. Open a YouTube video or playlist. Click the extension, then **Open in Offgrid**. Alternatively, right-click a YouTube link and choose **Send link to Offgrid**.
5. In Downloads, open the pending link and review quality/subtitles. A video with playlist context offers a choice to preview the playlist.

The extension needs `activeTab` for the current page URL when clicked and `contextMenus` for the explicit link action. It uses no cookies, content scripts, persistent host access, local HTTP service, or native messaging host. It cannot detect whether Offgrid is installed; the handoff page provides installation/retry guidance without making that claim.

## Manual release checks

- Toolbar and context-menu captures in current Chrome and Edge.
- Video, short URL, Shorts, playlist, and video-with-playlist links.
- Unsupported pages show a clear explanation and no external-app link.
- Offgrid closed, running, minimized, or without an open window.
- Existing Downloads draft is preserved; multiple captures remain available.
- Browser confirmation accepted and canceled; explicit handoff link can be retried.
- App absent: help remains accessible and the source URL can be copied.

Store submission, Safari packaging, and a native macOS Share extension are separate distribution work.
