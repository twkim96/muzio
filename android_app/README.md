# Muzio Android — shared web UI

Android now hosts the current `web_app` React/Tailwind UI in a WebView. Lists,
search, menus, dialogs, settings, images and player controls use the same source
as the browser. There is no separate Android CSS theme or screen translation.

## Source provenance and scope

The local `android` branch points to `4029ab7` and contains no Android source.
The restored native client is already in `main`, introduced by `eff5fac`.
This migration reuses that implementation's package (`com.twkim.videiomusic`),
server-profile DataStore, ExoPlayer/MediaSessionService, native playback policies
and progress metadata. The old Compose screens remain as reference code but
`MainActivity` no longer launches them. `FEATURE_PARITY.md` describes that old
Compose implementation, not acceptance evidence for this host.

Version: `1.4.5-web-dev`, versionCode `10`; minimum Android 8 / SDK 26, target SDK 36.

## Architecture

- Gradle builds the **current** React source and packages it under APK assets.
  It does not copy a pre-existing `web_app/dist`. Web UI changes appear in Android
  after rebuilding/installing the APK; browser deployment alone does not update
  an already installed APK.
- The host opens the selected server origin and intercepts app routes and static
  assets with the packaged UI. `/api/*` and `/healthz` retain same-origin network
  access, including SSE and HTTP Range. No backend CORS changes are needed.
- Android builds skip service-worker registration, avoiding a competing web
  release cache. Browser/PWA builds keep their existing behavior.
- Audio uses a native `PlaybackSession` adapter. ExoPlayer owns queue advancement,
  repeat, stop-after-current, sleep timer and system media controls while JS is
  suspended. The web audio element and duplicate browser audio MediaSession are
  disabled only in the Android host.
- Native snapshots restore the current source, queue and position after Activity
  recreation without starting playback again. Full process-death queue recovery
  is not implemented; the service resets runtime policy when recreated.
- Video uses the existing Vidstack/HLS.js web player and controls. Audio is paused
  before explicit video playback; native audio resumption pauses web video.
  Playing web video enters Android PiP when the app is minimized; paused video
  and music do not auto-enter. The same WebView video is preserved and displayed
  alone in PiP. Native video surfaces remain later work.
- Back closes dialogs/drawers/player overlays before returning to the library and
  backgrounding the app. OS bars and keyboard insets belong to the native host.

## Existing data

`server_profile` and its original keys are preserved. On first launch the host
copies the old `music.likes.v1`, `music.playlists.v1` and `music.activity.v1`
documents to the selected origin's WebView localStorage, only where a key is
missing. The original DataStore is not deleted. Migration is acknowledged only
after successful writes and can retry after a storage failure. Subsequent web
preferences live per server origin; browser storage outside this app is separate.

Changing the server validates `/healthz` and clears old native playback before
saving the new address. Progress destinations are also bound to each native
media item's original server so later profile changes cannot redirect writes.

## Build

Prerequisites: Node 22+, npm, JDK 21, Android SDK 36. Install web dependencies once:

```sh
cd web_app
npm ci
cd ../android_app
JAVA_HOME="/path/to/jdk-21" ANDROID_HOME="/path/to/android-sdk" \
  bash ./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Gradle invokes the web TypeScript/Vite build with `VITE_MUZIO_ANDROID=1`.
Output: `app/build/outputs/apk/debug/app-debug.apk`.

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.twkim.videiomusic/.MainActivity
```

A first installation shows a server connection screen. Existing installations
open the saved server automatically. Settings → Server connection → Change server
opens the connection screen again, including when the server is unavailable.
The WebView provider must support AndroidX WebMessageListener; unsupported
providers show an update message rather than falling back to an unsafe bridge.

## Verification and next stage

Automated coverage includes ordinary web behavior plus native command ordering,
queue transitions, restoration, source/URL policy, data migration and Android back
handling. APK build success does not establish real-device media acceptance.
Use an isolated backend/media collection when checking playback/progress writes.

Required device checks: theme/modal parity at the same viewport width, music
selection/queue/repeat/seek, lock-screen and headset controls, timer while locked,
Activity recreation, audio/video handoff, video HLS/seek and server switching.

Native background activity statistics currently remain in the native DataStore;
the initial migration copies existing history once. Continuous history reconciliation
and full process-death queue recovery remain follow-up work. Server playback
progress continues to be written by the native service.

After this shared-UI foundation is accepted, add native capabilities through the
bridge: local video/image access, widgets, richer notifications and persistent
playback recovery. These are not included in the initial UI migration.


## Local music folders

Settings → Local Music opens Android's local folder picker. Persisted read grants
and the cached audio catalog live on the device; only opaque IDs enter the shared
web list. Device music and server music share sorting, search, playlists and
artist/storage filters. Source filters label device files Offline and server
files Online. Server disconnection does not hide authorized local tracks.

Folder removal forgets the catalog/grant without deleting files. Re-scan after
changing folder contents; unavailable permissions are shown in settings. Local
progress is stored on the device and is not uploaded to the server. Local video,
images and automatic filesystem watching are later work. Embedded album art is
extracted into a private bounded JPEG cache and displayed in lists and players;
existing folders acquire covers lazily without re-registration. Files without
embedded art retain the default icon.
