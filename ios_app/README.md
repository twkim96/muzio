# Muzio for iPhone, iPad and Mac — 1.4.7

Shared Swift source hosts the existing React UI in WKWebView and connects audio
to AVPlayer. In 1.4.7, video pixels use VLCKit (Mac 3.7.3; iOS 4.0.0-a24)
with the existing web controls; the released 1.4.6 package still uses HTML video.
iOS/iPadOS16+ and macOS13+ targets live in `Muzio.xcodeproj`.
Current acceptance (updated 2026-09-09): Mac VLC playback is confirmed in the normal
`dist/apple/Muzio.app` launch target. The corrected VLC4 build is installed on iPad,
and the user confirmed video and sound. iPad distinct-media ABA, long playback and
automatic PiP, plus iPhone device acceptance, remain pending. See
[validation evidence](VALIDATION.md) and [remaining checks](../update_1.4.7.md).

The historical 1.4.6 closeout Mac artifact is universal (arm64 + x86_64), in
`dist/releases/1.4.6-20260908/`. The optional build-macos.sh script below builds
for the current machine's architecture.

## UI and server contract

The Apple app loads the selected server's current web deployment. It does not
package a second copy of the UI. Use the 1.4.6 server UI or newer for capability
negotiation; a first launch needs server connectivity. Settings, themes, filters,
search, video and image screens share the web source. Server origins keep separate
WebKit website storage. The server continues to own network files and metadata.

HTTPS is supported with normal system trust. Local networking is declared in the
Info.plist; arbitrary HTTP public hosts and untrusted certificates are not exempted
from Apple transport security. Health checks reject redirects. The bridge is
restricted to the selected origin's main-frame app documents. External links open
outside the app. Native audio ignores arbitrary page URLs and constructs the
server's canonical `/api/media/{encodedId}` route.

## Implemented and remaining

| Feature | Status |
| --- | --- |
| iPhone/iPad responsive UI, Mac window | Shared host implemented; Mac UI verified; iOS signed build/iPad install and basic video/audio confirmed; broader device acceptance pending |
| Server connect/change/retry, saved origin | Implemented; Mac connect/settings verified |
| Audio play/pause/seek, queue/duplicate reorder/repeat | Implemented; real macOS AVPlayer fixture passed |
| Native sleep timer/stop-after-current | Implemented; timer expiry while no bridge polling verified on Mac |
| Now Playing / media keys | Title/artist/time/artwork and durable likes implemented; physical controls acceptance pending |
| iOS background audio/interruption/headphone removal | Implemented; requires iOS device validation |
| Video/image | 1.4.7: shared VLC video decoder for Mac/iPhone/iPad with Vidstack web controls; image viewer unchanged. Mac native playback regression and actual app playback passed; iPad basic video/audio confirmed; extended iOS device checks pending |
| Video PiP | 1.4.7 iOS adapter connects VLC sample-buffer PiP with automatic inline start and shared playback state; physical iPad acceptance pending. Mac PiP is excluded by user request. Released 1.4.6 HTML playback retains WebKit manual PiP |
| Local folders/catalog | Apple folder picker + persistent bookmarks + incremental metadata/artwork implemented; device acceptance pending |
| Background history/progress | Durable native outbox and shared web import implemented; device acceptance pending |
| Offline cold launch | Missing relative to Android bundled UI; an implementation gap, not an OS limitation |
| Widget / full process-death queue restore | Not implemented |

Native audio survives page reloads while the app process lives. macOS app quit or
process termination stops native playback. iOS uses the audio background mode;
actual background execution remains subject to iOS lifecycle rules.

## Local music

Settings → Local Music → 로컬 폴더 추가 opens the system folder picker on iPhone,
iPad and Mac. Selected files stay in their original folders; only bookmarks,
catalog metadata and small cover images are stored by Muzio. The filename catalog
appears before metadata enrichment finishes, and merges with network tracks.
Removing a root disconnects it without deleting the original files.

Security-scoped bookmarks preserve folder access across launches. Playback accepts
only catalog IDs and holds folder access for the lifetime of the selected player
item. Covers are delivered through the private `muzio-local` scheme from the cache;
arbitrary file paths are not exposed to the web page.

Metadata scanning runs off the UI thread and persists progress. iOS suspension can
pause the worker; reopening resumes outstanding work. Download files from iCloud
or other providers onto the device before relying on local playback. The Apple UI
still comes from the server: a cold launch needs connectivity even though the
native catalog and selected audio files are local. This does not implement a fully
offline bundled Apple UI or process-death playback restoration.

## Mac build without Xcode

Requires Apple Command Line Tools (Swift and macOS SDK), Python3 for tests.

```sh
bash ios_app/scripts/build-macos.sh
open dist/apple/Muzio.app
```

The script produces an ad-hoc signed local `.app`, not a notarized distribution.
Its icon is generated from the existing web icon without artwork changes.

## iPhone/iPad and Xcode

1. Install full Xcode with an iOS simulator runtime. Command Line Tools alone do
   not include UIKit/iOS SDK or `simctl`.
2. Open `ios_app/Muzio.xcodeproj`. Choose scheme `Muzio-iOS` for iPhone/iPad,
   `Muzio-macOS` for Mac. iPad orientations and audio background mode are declared.
3. For a physical device choose your signing Team and a suitable bundle identifier
   in Signing & Capabilities. No account, certificate or provisioning profile is
   embedded in the repository.
4. Choose a simulator/device and Build/Run. Connect to a reachable Muzio1.4.7 server.

```sh
xcodebuild -project ios_app/Muzio.xcodeproj -scheme Muzio-iOS \
  -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

The project is checked in; no generator installation is needed. After changing
Swift filenames regenerate it with `python3 ios_app/scripts/generate-project.py`.

## Verification

```sh
swiftc -swift-version 5 ios_app/Muzio/ServerPolicy.swift \
  ios_app/Tests/ServerPolicyTests.swift -o /tmp/muzio-server-policy-tests
/tmp/muzio-server-policy-tests
bash ios_app/scripts/test-audio.sh
bash ios_app/scripts/test-local-music.sh
swiftc ios_app/Muzio/ApplePlaybackHistory.swift ios_app/Tests/ApplePlaybackHistoryTests.swift -o /tmp/muzio-history-tests
/tmp/muzio-history-tests
```

The audio test creates a silent WAV and a loopback HTTP Range fixture; it cleans
its server/temp files and does not read personal media. Tests check native playback,
seek, duplicate queue reorder, timer expiry, source restrictions and clear.

Xcode16.4 is installed. Whole-source macOS13 and iOS16 arm64 compile/link passed.
Xcode initial setup and iOS platform installation are complete.
The Muzio-iOS Debug iphoneos build including assets/plist passed with signing disabled.
Personal Team signed build and installation on iPad Pro11 (3rd generation) passed.
Launch passed after user trust for the developer app on the iPad. Later VLC4 startup repair and installation passed; the user confirmed basic iPad
video/audio. Extended playback, interruptions and automatic PiP remain unverified.
Compilation does not substitute for device acceptance.

References: [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview/),
[media playback configuration](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback),
[NSViewRepresentable](https://developer.apple.com/documentation/swiftui/nsviewrepresentable).

## 컴파일 검증과 릴리스 패키징

네이티브 변경 시 영향받는 Android·iOS·macOS 타깃의 컴파일과 관련 테스트를 수행한다. 설치·배포 패키징은 버전 마무리 때 타깃별 1회로 모으며, 실기기 검증은 별도로 기록한다. SDK가 없는 타깃은 미검증으로 남긴다. 상세 기준: [프로젝트 검증 정책](../AGENTS.md).

Shared web changes target web, Android and Apple together. Mobile features target
both native hosts unless an OS/API limitation is documented; missing implementation
is tracked separately. All user-visible platform versions are 1.4.7 (Apple build2).

## Historical shared HTML video playback (released 1.4.6)

This section describes the closed 1.4.6 behavior. The current development build
uses VLC as described below.

iPhone, iPad and Mac in that release use the shared Vidstack HTML video player in WKWebView.
The Apple host no longer advertises `nativeVideo`, constructs NativeVideoPlayer,
or inserts a separate AVPlayerLayer beneath the web view. Controls, gestures,
track menus and fullscreen follow the web implementation and WebKit support.
Native music playback and local music access are retained.

Automatic inline PiP through the custom native video engine was withdrawn at
the user's request after unresolved audio loss and buffering regressions.
This is a product rollback, not a claim that Apple cannot support automatic PiP.
WebKit's available manual video PiP remains enabled; automatic PiP is not an
acceptance requirement for this playback path.

The shared player still receives `videoIndexBaseUrl` and reads eligible original
MP4/MOV streams through the private loopback cache. It stores the validated front
index plus up to 16MiB of startup data, capped at 128MiB per entry and 640MiB/5 entries
overall. Existing index entries upgrade without redownloading the index. Revision,
range, length and checksum validation, cancellation, and direct-source fallback
remain in place. This is a bounded prefix cache, not a full-video download or a
promise of instant playback at every seek position. HLS keeps its existing path.

Library filters, artist-tag queries, search and sort persist per Music/Video/Image
in origin-scoped localStorage across web and app reopening. Clearing browser/app
website data clears those preferences; this is not cross-device synchronization.

Playback, audio continuity, fullscreen transitions and cache timing on the device
are tracked separately from compilation and automated regression checks.


Device acceptance carried forward from the closed 1.4.6 release is tracked in
[update_1.4.7.md](../update_1.4.7.md). The old AVPlayer experiment remains withdrawn. The separate VLC PiP integration
below follows the new iPad request. Basic iPad playback is now confirmed, while
extended playback and automatic PiP acceptance remain separate.

Mac acceptance results for 1.4.7 are in [VALIDATION.md](VALIDATION.md). Launch,
native music/local folders and shared UI passes do not imply video playback passes.

## VLC development checks (1.4.7)

Run `bash ios_app/scripts/prepare-vlckit.sh` before compiling the Apple project.
[Dependency provenance](ThirdParty/README.md) records the pinned official archives,
checksums, platform slices and bundled notices. The frameworks are generated and
ignored; do not commit their binaries.

`VLCVideoPlayer.swift` is compiled by both Apple targets. The same message protocol
connects play/pause, seek, volume/rate, embedded track selection and video geometry.
Mac fullscreen also enters the native window fullscreen and synchronizes an OS exit
back to the web controls. The native engine exposes no built-in playback controls.
Web/Android without the nativeVideo capability retain their HTML provider.

The existing front-index proxy remains available. It caches a validated file prefix,
not the entire movie or all sought positions. VLC does not expose time-buffer ranges
through this adapter, so the web buffer track is left empty rather than fabricated.

The Mac real-engine regression accepts a test server and video (at least 20 seconds):

```sh
bash ios_app/scripts/test-vlc-video.sh "$MUZIO_VIDEO_TEST_ORIGIN" "$MUZIO_VIDEO_TEST_MEDIA_URL"
```

It checks metadata, play clock, paused seeking, resume, stale-generation rejection,
and cleanup without substituting mocked playback state. Test playback is muted.
`MUZIO_VIDEO_DIAGNOSTICS=1` enables native state/frame/audio counters for a temporary
run. See [validation results](VALIDATION.md); compilation is not iOS device acceptance.

### iOS real playback regression

With an iPad simulator booted (Xcode iOS runtime required), run:

```sh
MUZIO_IOS_SIMULATOR_UDID="<booted-iPad-UDID>" bash ios_app/scripts/test-vlc-video-ios.sh
```

The script uses ffmpeg to generate an H264/AAC fixture and serves HTTP Range
responses, then runs the actual VLC4 player in a UIKit window. It checks the real
web order: load → ready → saved-position seek → play, followed by paused seek,
resume, stale commands and reload. Frame counters must show decoded output.
Reloads use the same fixture with different URLs/generations; this is not a
benchmark of two distinct large videos or physical-device PiP.

The iOS startup fix waits for the initial paused input to be prepared before
advertising readiness; duration can arrive earlier. Native playback maps only
validated current localhost proxy URLs to the cache listener's IPv4 address.
The dependency preparation script also removes manifest references to dSYM files
and platform slices omitted from extraction.

`bash ios_app/scripts/test-vlc-pip.sh` is a separate adapter test with a fake PiP
window controller. Its pass must not be reported as real rendering or Home/PiP
acceptance.

### iPad automatic PiP (1.4.7 development)

The iOS target uses the official VLCKit 4.0.0-a24 public PiP drawable/media/window
protocols. This is a pinned prerelease dependency, isolated from Mac's stable 3.7.3.
Video pixels remain beneath the existing WK controls. VLC's sample-buffer renderer
sets automatic inline PiP to true by default; the existing playback audio session
and background audio capability remain enabled. There is no background stop or
drawable replacement when switching apps. Mac does not gain PiP.

PiP play/pause/seek controls use the same generation-scoped native commands as the
web UI. Retired media cannot control the next video. Foreground return restores the
web video screen without forcing playback. VLC's public ready callback means the
window controller exists; it does not expose AVKit isPictureInPicturePossible or
failure/restore delegates, so this adapter does not fabricate those states.

Automatic PiP still depends on iPad system PiP support/settings and an active video
surface. Compile/test results and physical Home→PiP→pause/resume→return acceptance
are recorded separately in [VALIDATION.md](VALIDATION.md).
