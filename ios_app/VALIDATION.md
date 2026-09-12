# Apple app acceptance — 1.4.7

## Current status — consolidated 2026-09-10 KST

- iPad: final VLC4 startup fix compiled, installed in place, and user confirmed video plus sound (September 8). Basic playback is confirmed; distinct-media A→B→A, prolonged playback, fullscreen/interruption combinations and automatic PiP remain pending. iPhone has no equivalent device acceptance yet.
- Mac: regular `dist/apple/Muzio.app` launch target now contains the VLC build. Actual A playback with increasing frame/audio counters is confirmed. Prior VLC ABA evidence is recorded below; the final installed build was checked with A, not a fresh ABA timing run. Mac PiP is excluded by user request.
- Current engine: Mac VLCKit 3.7.3, iOS VLCKit 4.0.0-a24. Shared controls now use server UI1.4.7-r1; release display1.4.7/build2. Earlier device playback evidence below used1.4.6 and does not establish1.4.7 device acceptance.
- Final native builds and real iOS simulator playback regression passed. The earlier PiP test used a fake window controller; it is not real video/PiP acceptance. The real playback regression and final device response appear in the last section.
- 1.4.7 packages and server deployment are complete; no commit/push. Artifacts and hashes: `../dist/releases/1.4.7-20260910/manifest.json`. iPad update installed, but launch was rejected because the device is locked. Physical sync acceptance remains pending.

The following sections preserve chronological evidence. FAIL/BLOCKED/PENDING in an earlier section describes that run, not the current overall playback status.

## Environment and scope — 2026-09-08 KST

- Host: macOS15.3.2 (24D81), Apple silicon. Actual packaged app process confirmed at `dist/releases/1.4.6-20260908/Muzio.app/Contents/MacOS/Muzio`.
- Product1.4.6/build1, universal arm64/x86_64; source closeout `7bf27c0`. ZIP SHA-256 `a5f961a2bfe76f1ab27194800fee6484c0da607f6ff2ecedcc7abbab39f23ff2`. This is baseline acceptance for1.4.7, not a newly packaged1.4.7 app.
- App used its saved HTTPS server on port5173 with shared UI r20. Backend health returned Connected to muzio-backend. No server configuration, authentication or transport policy was changed.
- Actual PBXSourcesBuildPhase lists match:12 Swift source files in each of Muzio-iOS and Muzio-macOS. Both use server React UI; no separate patch-file synchronization exists. Read platform conditionals only: NSView/UIView host, macOS scoped bookmarks versus iOS bookmarks, iOS-only AVAudioSession/lifecycle behavior.
- UI actions used Computer Use on the actual app. Existing unit/compile passes were not rerun; no product changes or packaging occurred in this acceptance session.

## Observed results

| Area | Result | Actual evidence and limit |
| --- | --- | --- |
| Launch/server/settings | PASS | Final release app launches, saved HTTPS origin connects, Music/Settings renders and health probe succeeds. Settings displays1.4.6. |
| Network music | PASS for state/control | Selected an M4A, time advances0:20 onward, duration3:40:04 loads, Pause/Play toggles and resumes. Final speaker output was not recorded/listened to; do not infer absence of audible glitches from UI time. |
| Background/timer | PASS for state/control | Set1-minute custom timer at music0:49; hide app; later0:11 left/1:38, then Timer paused with Play button at1:48. Timer popup is glass and anchored immediately above its button. |
| Local bulk import | PASS for fixture catalog |1001 valid short M4A entries, embedded title/artist/cover. File picker returns with scanning status; later1001 items, pending0, title and artwork present. Poll interval means total import latency cannot be precisely measured. |
| Local playback/seek | PASS for state/control | Added independent90-second AAC fixture (1002 total), searched Playback90s and played; total1:29. Drag seek from0:21 to0:58 while paused, Play resumes and progresses1:09+. This fixture has no artwork; the bulk fixture separately verifies artwork metadata. |
| Bookmarks/restart | PASS | Quit/relaunch real app, same local item present and plays from saved1:19. Scope is local disk, not iCloud/network-provider/suspension behavior. |
| Filters/search/sort | PASS | Select Song ascending, Offline, Artist Muzio QA with text query. Quit/relaunch preserves all; search shows `Playback 90s #"Muzio QA"` and artist suggestion. Cleared test filters and restored latest/descending afterwards. |
| Playlist creation/dedup | PASS | Empty modal shows No playlists yet, header+ opens name input and blank-save disabled. Create temporary playlist with1 local item, add same item again to existing playlist: navigation count remains1. This is single-item actual UI acceptance; prior automated batch tests are not counted as physical long-press acceptance. |
| Image viewer | PASS | Open indexed PNG screenshot, actual image pixels render; Close returns to image list. |
| Video A | FAIL | Existing13.10GB /12:28:18 MP4 at saved5:57:20 stays black/Buffering after47s; collapse shows0:00/0:00 and disabled seek. |
| Video B | FAIL | Different8.08GB /6:01:27 MP4 at saved2:23:31 stays Buffering after47s; same mini-player0:00/0:00. |
| Fullscreen/PiP/ABA | BLOCKED | Since A/B do not reach playable state, no valid media fullscreen, PiP, continuous audio or ABA latency acceptance. |
| Other physical interactions | NOT VERIFIED | Actual speaker output, media keys/headphone interruptions, long-press multiselection, touch text-selection behavior, diverse codecs/providers and extended-duration playback. |

## Video failure evidence and next investigation

- A request at10:01:13 and B request at10:03:15 correlate with WebKit log `CachedResourceLoader::requestResource: Not allowed to request resource` in the app's WebContent process.
- `web_app/src/core/platform/videoIndexSource.ts` maps original Apple-host video URLs to token-protected HTTP127.0.0.1; loaded page origin is HTTPS. The Mac `~/Library/Caches/Muzio` directory remained empty, consistent with requests not reaching cache fill. This is evidence for investigating the resource policy/transport path, not final proof of a specific mixed-content or ATS rule.
- Plain HTTP probe to the same server port gives400 `Client sent an HTTP request to an HTTPS server.`; no app server change was made. No insecure setting or certificate bypass was applied.
- No claim of successful A→B→A optimization on Mac is possible from this run. The existing unit tests verify URL construction/cache logic, not WebKit's production resource permission decision.
- Next: compare same-origin direct media and loopback path in an actual HTTPS WKWebView, verify error/fallback delivery, then retest Mac plus affected iOS path. Retain the user-requested shared HTML video UI and withdrawal of custom AVPlayer automatic PiP.

## Evidence files and test hygiene

- Local evidence directory: `dist/validation/1.4.7-mac-20260908/` (ignored runtime artifacts). Numbered AX snapshots capture actions/results; `restart-state.txt`, `local-summary.json`, `sleep-timer.png`, `image-viewer.png`, `video-a-buffering.png`, `webkit-resource-block.log` supplement them. Screenshots and full AX records can include private library titles, so they are not committed/published.
- Bulk fixture used hardlinks to a small AAC file with metadata/cover. Initial fixture generation produced0.023s clips instead of90s; those were used only for catalog/enrichment. A separate verified90s audio file was generated for playback/seek. Do not treat the1001 duplicates as a diverse-codec or full-scale storage benchmark.
- Native file-picker keyboard automation initially selected the wrong zero-song folder. Its newly added root was removed without touching its source files. Folder-path entry was then performed with a fresh observed Go To field. This was a test invocation error, not an app import defect.
- AX set_value on media sliders did not seek; actual pointer drag on the visible full-player slider did. Do not classify the automation method's no-op as an app seek failure.
- After app quit, removed only this session's fixture root/items and exact temporary playlist, associated test progress/activity records; existing user records retained. Cleared test video search and restored original sorting. Localstorage backup is retained only in ignored evidence for recovery. The synthetic fixture files remain in `/tmp/muzio-147-mac-local-fixture` for a reproducible follow-up and are no longer connected to the app.
- This run updates acceptance documentation and corrects stale README status only.1.4.7 remains open because video startup failed; it is not a release acceptance pass.

## Follow-up fixes and engine comparison — 2026-09-08

Two app defects were corrected without changing the shared HTML player:

- Apple advertises the token-protected proxy as `http://localhost:<port>/...`, retaining an IPv4-only listener. The web mapper accepts localhost and legacy numeric loopback hosts. The actual revised Mac app created151MiB of prefix cache; an A-prefix request returned206 with `X-Muzio-Index-Cache: hit`. This supersedes the baseline's empty-cache observation.
- The Apple entry-document request now uses `.reloadIgnoringLocalCacheData`. Diagnostics showed the old app loading `index-BfkXfyBX.js` even while the server served `index-UfllVru5.js`; after this change the app loaded the current hash. Native hosts skip service-worker registration, so a service-worker revision bump alone did not refresh their entry document. Web shell revision is1.4.6-r21 during1.4.7 development; user-facing release versions remain1.4.6 until closeout.

The remaining large-video failure is **not fixed**:

- A and B now show frames and duration through localhost, but A stays at21440.9 seconds /12:28:18 with `paused=false`, rate1, `seeking=false`, readyState3 and only a few seconds reported buffered. B similarly stays at8611.7 seconds. Muting and seeking near the start did not resolve it.
- A minimal independent WKWebView harness with plain HTML video and the original HTTPS URL reproduces the same stall, both with a resume fragment and from the beginning. Explicit CORS mode also reproduces it. It uses no Vidstack, native-video bridge or Swift index proxy. A synthetic30-second H264/AAC clip through the same HTTPS server advances22→28 seconds with readyState4. This separates a blanket player/configuration failure from the tested large-file path.
- A separate Python passthrough also reproduces the stall. Its request log shows repeated decreasing-end ranges and successful byte delivery; it can transfer hundreds of MiB while reported buffered time remains small. Therefore “no ongoing network download” is not established. An experimental8MiB response cap did not solve startup and was not adopted.
- **Actual Edge web UI comparison:** same A file, seek to5:57:50, play advances5:58:14 and then5:59:02; paused after observation. The Mac app remains at5:57:20. Initial AX clicks/slider value updates did not activate the intended actions; accepted evidence comes from visible pointer actions and subsequent advancing UI time. Edge's exact sample starts30 seconds later, not the identical frame. Sound output was not recorded; this proves clock/frame progression, not an audio-quality acceptance pass.
- Installed Safari is18.3.1; system WebKit CFBundleShortVersionString20620. WebKit bug277661, fixed by commit37c2e6ab592c3248e8ef2adae350c05b583b92be in October2025, fixes over-delivery to AVAssetResourceLoadingRequest and unsigned remaining-length underflow followed by an incorrect wait. This is a **candidate**, not a confirmed identification of this machine's failure. The first shipping release containing it has not been established. A newer WebKit comparison is pending; no OS update or private WebKit override was performed.

Sources: [localhost media compatibility](https://github.com/WebKit/WebKit/commit/464e3e51f7c8b5a6d8ce6f077d0455307cf5721d), [numeric loopback follow-up](https://github.com/WebKit/WebKit/commit/93b599ee4b957ae9f803c133528d4bc33c88b02e), [WebKit bug277661](https://bugs.webkit.org/show_bug.cgi?id=277661), [loader length fix](https://github.com/WebKit/WebKit/commit/37c2e6ab592c3248e8ef2adae350c05b583b92be).

Local evidence: `dist/validation/1.4.7-mac-20260908/fix-*.txt`, `edge-a-*.txt`; `/tmp/muzio-147-video-state.log`, `/tmp/muzio-wk-{direct-play,direct-start,small,cors,uncapped,capped}.log`, `/tmp/muzio-uncapped-probe.log`. The temporary WebHost diagnostic logger was removed; its snippet is retained only at `/tmp/muzio-147-webhost-diagnostic-snippet.txt`. Diagnostic app/proxy processes were stopped and the synthetic served clip removed. No experimental response cap or native AVPlayer replacement was retained.

Initial checks: URL mapping5 and Vidstack engine32 tests passed (37 total), web build and native proxy integration passed. Mac/iOS initial xcodebuild logs ended `BUILD SUCCEEDED`; monitor exit metadata was unavailable, not a compile failure. The named `PersistentVidstackPlayer.test.tsx` filter matched no file and is not counted as passed. Final shared-host compile and proxy checks are recorded below separately. No release packaging/install or iPad acceptance is implied.

Final checks after removing instrumentation and completing shared-host changes: proxy integration exit0 (`/tmp/muzio-147-final-proxy-check.log`); Mac xcodebuild exit0 (`/tmp/muzio-147-final-mac.log`); iOS Simulator xcodebuild exit0 (`/tmp/muzio-147-final-ios.log`). Each command also wrote a matching `.exit` file. Native build logs end `BUILD SUCCEEDED`. Unchanged web37-test/build passes were reused. The final app is a temporary Debug compile at `/tmp/muzio-147-mac-fix/Build/Products/Debug/Muzio.app`; it is not a packaged1.4.7 release. Real-device large-video acceptance remains unresolved.

## 1.4.7 VLC integration — 2026-09-08

The user approved trying an open-source Apple engine and integrating it if the
failing samples worked. The development checkout now uses official VLCKit and
MobileVLCKit3.7.3 with the same `VLCVideoPlayer.swift` on Mac/iPhone/iPad. This
supersedes the earlier unresolved choice of a WebKit update/host replacement;
it does not claim the suspected WebKit bug was proven.

### Engine isolation and native contract

A standalone Cocoa/VLCKit probe used the original HTTPS A/B URLs (no WKWebView,
proxy, Vidstack or TLS bypass). A→B→A ran45 seconds per phase, pausing at15 seconds,
resuming at18, seeking forward at25 and backward at33. Both video frame and audio
output-buffer counts increased after each operation; all phases completed, exit0.
A was started at21440.9 seconds and B at8611.7 seconds. A's final reentry sample
reported2349 displayed frames and1978 audio output buffers, lost-audio count0.
The separate `start-paused` probe held frames/audio at0 before play, then both grew.
Logs and probe sources: `/tmp/muzio-vlc-validation/{aba.log,paused.log,Probe.m,PausedProbe.m}`.
Counters establish decoded/output progress, not a recording of speaker audibility.

The repository's opt-in `scripts/test-vlc-video.sh <origin> <video-url>` then drove
the actual Swift producer. It passed metadata readiness, play-clock progress,
paused seek with seeking-start/completion and target-position reporting, resume,
rejection of stale-generation play/clear, and current clear/shutdown. Runtime was
muted. Log: `/tmp/muzio-147-vlc-native-tests.log`, exit0. The initial harness used
local test-URL defaults; these were removed before the final diff so committed
code requires explicit CLI/environment inputs. The playback assertions are unchanged.

### Issues found during integration and fixes

- Early `canPause` could be true before duration was known, making Vidstack show
  LIVE and disable seek. Readiness now waits for a positive file duration.
- VLC can render a paused seek's new frame without updating its stopped clock.
  The adapter keeps the accepted paused target until the resumed clock catches up;
  it does not immediately clear seeking just because the setter returned.
- First selection after opening the saved full player reproduced duplicate pending
  loads: generation1 received `source-change`, generation2 reused the same source,
  but `currentSrc` was unavailable and no second change event was emitted. Its
  readiness/progress was rejected until the seek watchdog triggered fallback.
  `/tmp/muzio-147-vlc-readiness3.log` captured the empty current URL with the expected
  localhost source. The fix carries forward observed identity only for an identical
  pending, nonfailed source. Different media, changed fragment and failed retry
  regressions preserve the fresh-observation requirement.
- Web process termination clears native playback. Rejected stale video-play commands
  cannot relinquish current music. Mac OS fullscreen exit feeds back to the web
  surface, which retains the same video and controls across fullscreen transitions.
- Mac compositing clears WK backgrounds, including the `drawsBackground` KVC setting.
  This composition was exercised on the tested Mac OS version; iOS device acceptance
  remains separate. Temporary WK/JS readiness instrumentation was removed.

### Final checks and Mac runtime

| Check | Result | Evidence |
| --- | --- | --- |
| Vidstack engine + native provider regressions | 51 passed, exit0 | `/tmp/muzio-147-vlc-reload-tests.log` |
| Surface/fullscreen regressions | 5 passed, exit0 | `/tmp/muzio-147-vlc-final-surface.log` |
| Shared web build | Passed, exit0; existing chunk-size warning | `/tmp/muzio-147-vlc-final-web-build.log` |
| Mac Debug compile, current native sources/resources | Passed, exit0 | `/tmp/muzio-147-vlc-final-mac.log` |
| iOS Simulator Debug compile, current native sources/resources | Passed, exit0 | `/tmp/muzio-147-vlc-final-ios.log` |
| Actual VLC native producer | Passed, exit0 | `/tmp/muzio-147-vlc-native-tests.log` |

The surface test initially expected four fullscreen enter/exit pairs after a fifth
host-exit scenario was added. Only that expected sequence was corrected; the affected
file and previously blocked web build were rerun. Native compile passes were reused.
Earlier persistent-player/URL mapping checks remain valid for their unchanged inputs.

Final temporary Mac app:
`/tmp/muzio-147-vlc-mac/Build/Products/Debug/Muzio.app`.
On macOS15.3.2, the previously failing saved-full-player→collapse→list-selection path
now reached play without fallback. The final session ran B→A→B→A. Observed delay
from native load to the first positive frame/audio sample was1.428/1.802/2.085/1.701
seconds respectively (sampled counters, not exact first-pixel timing or an iPad
network benchmark). Each item continued advancing. The final A returned to its
saved6:08 position and progressed past6:09 with video/audio counters increasing.
B was sought while paused to about2:22:20; its target UI completed without playback,
and resume advanced from that position. Screen tap pause/resume, native Mac window
fullscreen with the existing web controls, and Escape back to inline also worked.
Playback was paused after testing.

Final native log: `/tmp/muzio-147-vlc-final-runtime.log`.
Local visual/AX evidence: `dist/validation/1.4.7-mac-20260908/vlc-final-*.{png,txt}`
(ignored/private test artifacts, not repository assets).

### Remaining limits

- At the initial VLC baseline, PiP was not integrated. The later iPad-only
  integration and its acceptance status are recorded below; Mac PiP is excluded
  by the subsequent user request.
- Front-index caching remains enabled. It does not cache an entire movie or guarantee
  immediate playback of arbitrary seek regions. The adapter exposes no invented
  buffered time ranges because VLCKit provides no equivalent range list here.
- iPhone/iPad VLC playback, prolonged playback, real speaker/headphone output and
  interruptions still need physical-device testing. Simulator compilation does not
  prove these, and no iPad install or new release package was produced in this turn.
- Shared UI r22 and native source changes are ready for the next release packaging
  gate; display version remains1.4.6 during1.4.7 development. No commit/push or
  release closeout is implied by the temporary test app.

## iPad automatic PiP integration — 2026-09-08

Scope: user explicitly requested automatic PiP on iPad, excluding Mac. This is a
new VLC integration, not restoration of the withdrawn AVPlayer implementation.
iOS uses checksum-pinned VLCKit 4.0.0-a24; Mac stays on 3.7.3. The shared web UI and
prefix cache remain in place. The actual archive SHA-256 and selected platform
slices were verified; preparation/generation checks were reused from the dependency
worker rather than repeated by the parent.

Source evidence: a24 `compileAndBuildVLCKit.sh` pins libVLC `5dd4aebda`; its PiP
renderer defaults `canStartPictureInPictureAutomaticallyFromInline` to YES for iOS.
The public drawable protocol is explicitly implemented. The owner retains the
inline view during background transition, and PiP controls update the same
native state/generation as the web UI. Foreground restoration does not auto-resume
paused media. Public VLC readiness is not claimed as AVKit isPossible; its wrapper
does not expose restore/failure delegates.

Sources: [a24 build recipe](https://code.videolan.org/videolan/VLCKit/-/blob/4.0.0-a24/compileAndBuildVLCKit.sh),
[pinned PiP implementation](https://github.com/videolan/vlc/blob/5dd4aebda/modules/video_output/apple/VLCPictureInPictureController.m).

| Check | Result | Evidence |
| --- | --- | --- |
| Mac Debug compile of shared native player | PASS, exit0 | `/tmp/muzio-147-pip-mac.log` |
| Actual Mac VLC regression | PASS, exit0; metadata, play clock, paused seek, resume, stale commands, cleanup | `/tmp/muzio-147-pip-mac-regression.log` |
| iOS affected Swift typecheck | PASS, exit0 | `/tmp/muzio-147-pip-typecheck.log` |
| iOS device Debug compile/sign | PASS, exit0 | `/tmp/muzio-147-pip-ipad-build.log` |
| Actual PiP adapter + fake window controller on iPad simulator | PASS, exit0; forwarding, seek completion, milliseconds, late callbacks after retirement, replacement isolation | `bash ios_app/scripts/test-vlc-pip.sh`; `/tmp/muzio-vlc-pip-tests.log` |
| Connected iPad installation | PASS, exit0 | `/tmp/muzio-147-pip-ipad-install.json`, `.log` |
| Automatic launch | BLOCKED by locked device, exit1 | `/tmp/muzio-147-pip-ipad-runtime.log`: FBSOpenApplicationErrorDomain7, Locked |
| Physical video → Home → automatic PiP → pause/resume → app return | PENDING user verification | Requested after install; no automatic-PiP pass inferred from simulator mocks or build |

The first device compile failed on Objective-C callback optionality. The narrowed
Swift typecheck then found VLC4's failable VLCMedia initializer. Both migration
issues were fixed before the successful typecheck and device build. Existing
unrelated AVFoundation deprecation/Swift6 migration warnings remain warnings in
Swift5 mode. No assertions were weakened to pass these checks.

The simulator harness does not instantiate a real PiP/video controller and does
not prove renderer/audio/background behavior. Mac playback proof is for stable
3.7.3 and cannot certify iOS4. Unchanged web regression/build passes from the prior
VLC work were reused; no web code was changed in this PiP follow-up.

Installed temporary validation app:
`/tmp/muzio-147-pip-ipad/Build/Products/Debug-iphoneos/Muzio.app`.
Existing app data was preserved by updating in place. Display version remains the
shared1.4.6 baseline while1.4.7 development is open. No release archive/package,
version closeout, commit or push was performed in this PiP follow-up.

## iPad real playback startup repair — 2026-09-08 evening

User reported no actual video playback on iPad and Mac. These had different evidence:

- Running Mac executable was `dist/apple/Muzio.app` dated September 7, with no VLCKit dependency in its debug dylib. The previous successful VLC UI test ran a `/tmp` app, so it had not replaced the normal launch target. Replaced that app with the existing validated VLC app, preserving the prior bundle under `dist/apple/Muzio-pre-vlc-20260908-200052.app`. Actual A video then advanced for over a minute with video/audio counters increasing, including pause/resume. Log `/tmp/muzio-mac-playback-current.log`. This was not a new release/version closeout.
- Physical iPad VLC4 console showed `cannot connect to localhost:51766` / `Connection refused` on both selected media. The private proxy binds IPv4 only. Native source validation now maps only the validated current proxy localhost URL to `127.0.0.1`, retaining token/port/path/query and existing origin restrictions. WebKit's exposed localhost address is unchanged. Regression verifies rejection of wrong token/port/userinfo and pre-validation IP aliases. Log `/tmp/muzio-ipad-playback-current.log`.
- Added actual UIKit/window + VLC4 simulator regression using generated H264/AAC and a Range HTTP fixture. The initial non-Range fixture was corrected; with Range support, load → metadata → seek saved position → play still stalled, whereas playing before seeking passed. `state=3` is VLC4 **paused**, not playing. Duration arrived while the input was opening; readiness based only on duration allowed play before `:start-paused` took effect. iOS now waits for initial paused preparation before advertising ready and queues any earlier play intent. Mac3 API path unchanged.
- Investigated delaying seek until isPlaying, clock movement, first frame, and changing PiP reported time. Those attempts did not pass the same regression and were removed. Active window geometry was verified, excluding a hidden/inactive fixture window in that reproduction. No speculative workaround from those attempts remains.
- Final unchanged seek-before-first-play scenario passed, plus paused seek, resume, stale generation rejection, reload, clear/shutdown. Frames 4→44→83 and audio 1→119→237. Log `/tmp/muzio-vlc-video-ios-prepared-tests.log`; command `bash ios_app/scripts/test-vlc-video-ios.sh`, exit 0. Reloads use the same generated fixture with different URL generations, not distinct real A/B media. Physical ABA/PiP acceptance remains separate.
- Fixed VLCKit preparation manifest declaring missing dSYM directories after intentionally excluding those files. The generated manifest now lists only extracted slices and existing symbol directories. Archive checksum validation remains intact. First affected device build failed on that missing directory; no product code was changed to bypass a compiler error.
- Native source policy executable passed; scripts pass `bash -n`. Device/Mac final compilation and installed-device outcome recorded below after completion.
- Final iOS and Mac builds passed exit0 (`/tmp/muzio-ipad-playback-fixed-build.log`, `/tmp/muzio-mac-playback-fixed-build.log`). iPad in-place install passed (`/tmp/muzio-ipad-playback-fixed-install.json`). Mac normal launch bundle updated from final build and ad-hoc signature verified. First automatic iPad launch was blocked by renewed device lock (`/tmp/muzio-ipad-playback-fixed-runtime.log`); user playback response requested, not counted as a playback pass.
- Final installed Mac build replayed A with decoded video/audio and progressing saved position (frames1573/audio1287 at5:24:28), then user paused it. `/tmp/muzio-mac-playback-final-runtime.log`. Further automated Mac interactions were stopped after user changed the app. This final run confirms A playback, not a new final-build ABA measurement.
- User confirmed the installed iPad fix produces both video and sound after being asked to play the same video for about10 seconds: “나옴”. Physical basic playback is therefore confirmed by user feedback. This does not claim distinct-media A→B→A, long playback or automatic PiP acceptance; those remain pending.

## 1.4.7 closeout — 2026-09-10 KST

- `xcodebuild -project ios_app/Muzio.xcodeproj -scheme Muzio-iOS -destination generic/platform=iOS -configuration Release -archivePath dist/releases/1.4.7-20260910/Muzio-iOS.xcarchive -derivedDataPath /tmp/muzio-147-release-ios CODE_SIGNING_ALLOWED=NO archive`: ARCHIVE SUCCEEDED, exit0. Common iPhone/iPad device code compiled.
- Development IPA exported from that archive using the existing Xcode-managed profile and automatic signing. Initial manual export failed because the existing profile is Xcode managed; correcting export signing style succeeded without recompilation. Signed payload passed `codesign --verify --deep --strict`. Existing development profile expires2026-09-14 21:00:14 KST; this is not an App Store release.
- `bash ios_app/scripts/build-macos.sh`, deep strict code-sign verification and ZIP creation passed. Mac app executable is arm64, ad-hoc signed; visible version1.4.7/build2 verified in both packaged plists. Mac1.4.6 universal artifact remains available separately. Existing Swift6-concurrency warning in LocalMusicLibrary is unchanged; current Swift5 build succeeded.
- iPad Pro11(3rd gen): `devicectl device install app` succeeded in place; app listing reports1.4.7/build2. Launch failed with Locked/Unable to unlock. No claim of successful1.4.7 launch, music sync, PiP or playback acceptance.
- Web notification-like connector tests cover Android/iOS/macOS; server synchronization uses the existing native notification commands. No new native bridge contract. Full web704 tests and separate real client/server concurrency integration passed; these are not physical cross-device acceptance.

### VLC video Now Playing / remote controls — 2026-09-11

- Shared iPhone/iPad/Mac `VideoNowPlaying` publishes title, duration, position and playback rate. Remote play/pause/toggle,10-second skips and bounded seeking route to the current VLC generation. Music/video ownership callbacks remove the previous command targets. The new capability prevents duplicate web metadata writes; old hosts retain their existing behavior.
- iOS Simulator Debug compile PASS (`/tmp/muzio-system-ios.log`), macOS Debug compile PASS (`/tmp/muzio-system-macos.log`). The initial destination discovery used the nonexistent `Muzio` scheme; corrected to the existing `Muzio-iOS` and `Muzio-macOS` schemes before compiling. No device archive or release packaging.
- `bash ios_app/scripts/test-vlc-video-ios.sh`: PASS with the existing generated Range fixture on iPad simulator. New metadata/remote command/ownership test passed before the real VLC metadata/play clock/paused seek/stale generation/clear/shutdown regression. Log `/tmp/muzio-system-ios-tests-output.log`.
- The same `VideoNowPlayingTests.swift` compiled and ran on macOS: PASS (`/tmp/muzio-system-nowplaying-tests`). These tests exercise the registered action dispatch method and system metadata, not a physical Control Center tap.
- Physical iPad/iPhone/Mac system UI, lock/unlock, Bluetooth and prolonged background playback remain unverified. New native functionality requires the next installed app; no release IPA/ZIP or device install was performed for this feature. The shared artist link is delivered with server UI1.4.7-r6.

### iPad 시스템 영상 제어 수정본 설치 — 2026-09-11

- 사용자 설치 요청으로 현재1.4.7/build2 iPhone/iPad 코드를 실제 기기용 Debug로 빌드·서명했다. `xcodebuild` 성공, `codesign --verify --deep --strict` 통과. 로그 `/tmp/muzio-system-ipad-build.log`.
- 연결된 iPad Pro11(3세대)에 앱 삭제 없이 `devicectl device install app` 성공. 설치 결과 `/tmp/muzio-system-ipad-install.json`, 기기 앱 목록1.4.7/build2 확인. 영상 Now Playing/remote controls 및 공용 서버 UI의 가수 필터 이동 적용 대상이다.
- 설치 후 기기가 다시 잠겨 자동 실행은 Locked/RequestDenied로 실패했다(`/tmp/muzio-system-ipad-launch.json`). 설치 성공과 실행/실기기 재생 검증은 구분한다. 화면을 끈 상태의 장시간 소리 재생은 아직 검증되지 않았으며, 이번 설치를 해당 중단 문제의 해결로 표시하지 않는다.
