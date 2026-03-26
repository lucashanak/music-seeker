# Native Apps (macOS & Android)

MusicSeeker has native app wrappers built with [Tauri](https://tauri.app/) v2. The apps are thin WebView wrappers that load the MusicSeeker web interface — all features are served from your server, so the apps stay up to date automatically without reinstallation.

## Download

Download the latest version from **Settings > Native Apps** in MusicSeeker, or directly from [GitHub Releases](https://github.com/lucashanak/music-seeker/releases/latest).

- **macOS**: `MusicSeeker.dmg` (requires macOS 10.15+)
- **Android**: `MusicSeeker.apk` (requires Android 7.0+, arm64)

## macOS

### Installation

1. Open the DMG and drag MusicSeeker to Applications
2. On first launch, macOS may block the app ("damaged" warning) because it's unsigned
3. Fix with: `sudo xattr -cr /Applications/MusicSeeker.app`
4. Or: right-click > Open (bypasses Gatekeeper on first launch)

### Features

- Standalone window with dock icon (Cmd+Tab switching)
- **View menu**:
  - `Cmd+R` — Reload
  - `Cmd+Shift+R` — Hard reload
  - `Cmd+Shift+Delete` — Clear cache & reload
- Overlay title bar (macOS native look)

## Android

### Installation

1. Download the APK from Settings or GitHub Releases
2. Open the APK file and tap "Install"
3. If prompted, allow installation from unknown sources

### Features

- **Background audio playback** — music keeps playing when the screen is off or the app is in the background
- **Media notification** — persistent notification with:
  - Track title and artist
  - Play/Pause, Previous, Next buttons
  - Progress bar with elapsed/total time
  - Lock screen controls
- **Microphone access** — Shazam song recognition works in the app
- **Status bar handling** — proper edge-to-edge layout, content doesn't overlap system bars
- **Keyboard handling** — app adjusts when the on-screen keyboard appears

### Background Audio

The Android app uses a foreground service (`AudioService`) with `FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK` to keep audio alive in the background. The service:

- Starts automatically when you play a track
- Shows a media notification with playback controls
- Holds a partial wake lock to prevent CPU sleep
- Stops when you pause (notification remains briefly) or close the app

Notification buttons (play/pause/prev/next) route back to the WebView player via a JavaScript bridge.

### Permissions

| Permission | Purpose |
|------------|---------|
| `INTERNET` | Load web interface and stream audio |
| `RECORD_AUDIO` | Microphone for song recognition (Shazam) |
| `MODIFY_AUDIO_SETTINGS` | Required by WebView for mic access |
| `WAKE_LOCK` | Keep CPU awake during background playback |
| `FOREGROUND_SERVICE` | Run background audio service |
| `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | Android 14+ media playback type |
| `POST_NOTIFICATIONS` | Show media playback notification |

## Auto-Update

The app checks for updates automatically:

1. Tauri loads the URL with `?app_version=X.Y.Z` (baked into the build from the git tag)
2. The frontend reads this version and stores it in `localStorage`
3. On each visit to Settings, it checks GitHub Releases API for the latest version
4. If a newer version exists, an "Update available" banner appears with a download button
5. On Android, the download link is copied to clipboard (open in browser to install)
6. On macOS, the DMG downloads directly

The `app_installed_version` persists across Refresh and Clear All operations.

## Building

Builds are automated via GitHub Actions (`.github/workflows/build-desktop.yml`).

### Triggers

- **Git tag** (`v*`) — builds and creates a GitHub Release with DMG + APK
- **Manual** (`workflow_dispatch`) — builds artifacts without release

### Build process

Both platforms build in parallel:

**macOS** (`macos-latest`):
1. Install Rust + Node
2. Generate icons from SVG (rsvg-convert + iconutil)
3. `npx tauri build` → DMG bundle
4. Upload to GitHub Release

**Android** (`ubuntu-latest`):
1. Install Java 17, Android SDK/NDK, Rust (aarch64 target)
2. Generate icons, init Android project
3. Patch: AndroidManifest (permissions, service), MainActivity (bridge, edge-to-edge), AudioService (foreground service)
4. `npx tauri android build --apk --target aarch64`
5. Sign with persistent keystore (GitHub secret)
6. Upload to GitHub Release

### Version management

- `tauri.conf.json` has version `1.0.0` in source
- CI replaces it with the version from the git tag (e.g., `v1.5.1` → `1.5.1`)
- The URL also gets the version injected: `?app_version=1.5.1`
- APK is signed with a persistent keystore stored as a GitHub secret, enabling in-place updates without uninstalling

### Creating a release

```bash
git tag v1.5.2
git push origin v1.5.2
```

This triggers the build and creates a GitHub Release with both DMG and APK assets.
