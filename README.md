# Direct Download Module

![Works on my machine](https://img.shields.io/badge/works%20on-my%20machine-success?style=flat-square)

A Manifest V3 browser extension for direct downloads and HLS video saving. It
uses the browser download engine and does not require IDM, a native helper, or a
server.

## Fun Fact

The extension can turn hundreds of tiny HLS segments into one MP4 without
leaving the browser. The browser does the downloading, the bundled WebAssembly
engine does the remuxing, and the extension does the paperwork.

## Features

- Download links, images, audio, and video from the context menu.
- Download all links or selected links from a page.
- Detect media files and HLS playlists used by HTML5 video players.
- Choose an HLS quality and download the stream as an MP4 file.
- AES-128 HLS decryption, retries, byte-range segments, and packet cleanup.
- MPEG-TS streams are remuxed to MP4 inside the extension with bundled WebAssembly.
- Optional `Referer` and `Origin` handling for protected, non-DRM media.
- YouTube page detection with a one-click browser-native download attempt.
- Browser recording fallback for videos whose source URL cannot be downloaded.
- Close controls for hiding the on-video download overlay.
- Persistent popup toggle to disable and re-enable the extension.

## Install From Source

Works with Chromium-based browsers such as Chrome, Chromium, Brave, Edge,
Vivaldi, and Opera.

1. Download or clone this repository.
2. Open `chrome://extensions` or `brave://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder, the folder containing `manifest.json`.
6. Reload the extension after pulling updates, then reload open video pages.

Do not run two copies of the extension at once. Remove older unpacked copies to
avoid duplicate buttons and conflicting background workers.

## Usage

Use the toolbar popup to paste a URL, inspect media detected on the active tab,
or open the HLS downloader. On a playing video, use the blue **Download** button
to select a detected file or HLS quality. The context menu provides direct and
batch link downloads. The on-video overlay can be closed with its `X` button.
Use **Enable extension** in the popup to temporarily disable or re-enable the
overlay and download actions without removing the extension.
On a YouTube page, the popup can attempt a browser-native download of detected
media.

YouTube often exposes separate signed video and audio streams. A normal browser
extension cannot execute a native downloader or merge those streams, so those
videos require an external downloader such as `yt-dlp`.

## HLS Support

The downloader supports completed, unencrypted HLS and AES-128 encrypted HLS.
It joins fragmented MP4 streams directly and remuxes MPEG-TS streams to MP4
using the bundled ffmpeg.wasm runtime. Keep the downloader tab open until the
download finishes.

The following are not supported:

- DRM-protected video or SAMPLE-AES encryption.
- Live playlists without an `#EXT-X-ENDLIST` marker.
- Separate audio tracks that require a second playlist.
- Sites that reject replayed requests or use short-lived, player-only tokens.
- DASH as a built-in download format; the popup provides a `yt-dlp` command.

These restrictions are imposed by the stream or browser security model and
cannot be bypassed by a normal extension.

## Recording Fallback

When no usable media URL is detected, open the on-video menu and choose
**Record current video**. The extension uses the browser's `MediaRecorder` API
to capture the currently playing video and saves a `.webm` file. Recording
starts from the current playback position and stops when the user selects
**Stop recording and save**.

Recording quality and audio depend on the browser and the site. Some protected
players disable capture, and recordings are not guaranteed to match the
original MP4 container or quality.

## Project Layout

| File | Purpose |
|---|---|
| `manifest.json` | Extension metadata and permissions |
| `background.js` | Service worker, media detection, downloads, menus |
| `content.js` | On-video download button and quality menu |
| `hls-core.js` | Standalone HLS parsing, decryption, and segment logic |
| `hls.html` / `hls.js` | HLS downloader page and MP4 conversion |
| `popup.html` / `popup.js` | Toolbar popup |
| `links.html` / `links.js` | Batch link picker |
| `ffmpeg-core.wasm` | Bundled WebAssembly remuxing engine |

## Development

The extension has no build step. After editing, reload it from the extensions
page. Basic syntax checks can be run with:

```bash
node --check background.js
node --check content.js
node --check hls-core.js
node --check hls.js
node --check popup.js
```

## Privacy

The extension does not send downloads to a project server. Network requests are
made by the browser to the URLs selected by the user. The extension observes
media requests on open pages only to identify downloadable files and streams.

## License

Project source is licensed under the MIT License. See `LICENSE`. Bundled
third-party WebAssembly files retain their own licenses; see
`THIRD_PARTY_NOTICES.md`.
