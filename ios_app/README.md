# Muzio for iPhone, iPad and Mac — 1.4.6

Shared Swift source hosts the existing React UI in WKWebView and connects audio
to AVPlayer. iOS/iPadOS16+ and macOS13+ targets live in `Muzio.xcodeproj`.
The current Mac artifact is built for the build machine's architecture (arm64).

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
| iPhone/iPad responsive UI, Mac window | Shared host implemented; Mac UI verified; iOS build/device pending |
| Server connect/change/retry, saved origin | Implemented; Mac connect/settings verified |
| Audio play/pause/seek, queue/duplicate reorder/repeat | Implemented; real macOS AVPlayer fixture passed |
| Native sleep timer/stop-after-current | Implemented; timer expiry while no bridge polling verified on Mac |
| Now Playing / media keys | Wired with title/artist/time; artwork and physical controls acceptance pending |
| iOS background audio/interruption/headphone removal | Implemented; requires iOS device validation |
| Video/image | Shared web player/viewer; iOS inline/PiP configuration enabled, device behavior unverified |
| Automatic video PiP on Home | Android behavior is not claimed for Apple; Apple acceptance/automatic transition remains pending |
| Local folders/offline catalog | Android only; Apple controls hidden via capabilities |
| Widget / full process-death queue restore | Not implemented |

Native audio survives page reloads while the app process lives. macOS app quit or
process termination stops native playback. iOS uses the audio background mode;
actual background execution remains subject to iOS lifecycle rules.

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
4. Choose a simulator/device and Build/Run. Connect to a reachable Muzio1.4.6 server.

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
```

The audio test creates a silent WAV and a loopback HTTP Range fixture; it cleans
its server/temp files and does not read personal media. Tests check native playback,
seek, duplicate queue reorder, timer expiry, source restrictions and clear.

This Mac has Command Line Tools but no full Xcode. Mac compile/launch/connection
and shared filter/settings UI were verified; iOS SDK compile, simulator, signing,
physical-device playback, interruptions and PiP have **not** been verified.

References: [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview/),
[media playback configuration](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback),
[NSViewRepresentable](https://developer.apple.com/documentation/swiftui/nsviewrepresentable).
