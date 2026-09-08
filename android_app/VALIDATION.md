# Shared web UI host validation — 2026-09-06

Base: `main` at `c283d52`; implementation branch: `codex/android-shared-web-ui`.
Android `1.2.0-web-dev` / versionCode 5. This is development acceptance, not a
physical-device or release-signing report.

## Automated evidence

- Full web suite: 54 files, 575 tests passed.
- Two later queue-identity regressions were added; the affected native audio and
  player-store suites passed all 81 tests (13 + 68). Other inputs were unchanged.
- Final Gradle `:app:testDebugUnitTest :app:assembleDebug` passed, including the
  current embedded web TypeScript/Vite build. JVM tests: 2 suites / 7 tests.
- Full diff whitespace check passed.

## Emulator evidence

A separate `MuzioSharedWebApi36` ARM64 AVD used an isolated local backend and
synthetic WAV/MP4 media. No personal media/progress or existing device was used.

- Fresh install → React server setup → `/healthz` validation → music library.
- APK update preserves server configuration and opens the shared UI again.
- Loaded script is the APK's `assets/index-DR_EPcG6.js`; viewport 412 × 815 CSS px.
- Music UI starts ExoPlayer; the system MediaSession reports the same item/queue.
- Home/background + media Next switches to the next track; the queue terminates
  at the last item without duplicate web advancement.
- Native sleep deadline while backgrounded paused at 15.696 seconds with
  `sleepTimerExpired=true` and no remaining deadline.
- Font-scale configuration change recreated the Activity/WebView (a JS marker
  disappeared), retained queue entry `queue-3-0e8a576eaea46352`, and advanced from
  66.5 seconds to 88.38 seconds without restarting the item.
- Android Back collapsed the full music player.
- An H.264/AAC MP4 rendered 320 × 180 video and completed its 8.01-second duration;
  native audio was paused during the video session.
- Dark/light switching changed root palette and OS bar contrast. Screenshots
  were inspected for music/player/video and settings; no pixel-diff parity claim.
- Invalid server connection displayed an error; Cancel recovered the saved app.
- MediaSession includes an Activity PendingIntent for notification entry.

## Artifact and limits

Local artifact: `dist/android-shared-web-ui/Muzio-1.2.0-web-dev.apk`

SHA-256: `2c398ff1855ce66553b967a36fc1f73558c5bc7fb1b29c57416bad1344d1814d`

Real-device screen-off power policy, headset/Bluetooth controls, HLS/codec/seek,
large-library gesture performance and personal-data upgrade migration still need
device acceptance. Migration safety is covered by unit tests, not by modifying a
personal installed app. Native video/PiP, local playback, widgets, richer system
notifications, full process-death recovery and continuous background activity
history reconciliation are outside this initial migration.

## Mobile UI follow-up — 1.2.1-web-dev / versionCode 6

- Full web suite passed: 54 files / 584 tests. After the final row-swipe
  refinement, the affected App suite passed 28 tests. Final APK assembly passed,
  including TypeScript and the embedded Vite build. Native code was unchanged.
- The same isolated Android emulator loaded bundled `assets/index-DLn6vJBi.js`.
  A first upward touch drag starting on video information moved the page from
  scrollTop 0 to 133.71px. Video top remained 0px while title top moved from
  247.86px to 114.14px; only the video stays sticky.
- Actual touch swipes over music/video rows switched Music → Video → Image
  and back without starting playback or opening navigation.
- At 412 × 815 CSS px, the mini title/progress had 185px width with no horizontal
  overflow. Visible actions were timer, queue, next, pause; button widths were
  32px and icons 20/20/20/24px. The primary Queue panel showed its close action.
- Updated the connected Samsung SM-S936N using `adb install -r`: Success.
  Package inspection confirmed versionCode 6 / 1.2.1-web-dev, and Activity launch
  and running process were verified. This update did not uninstall the app.
  Gesture behavior was checked on the emulator; personal-library touch feel on
  the Samsung device remains user acceptance.

Artifact: `dist/android-shared-web-ui/Muzio-1.2.1-web-dev.apk`

SHA-256: `03834f3f93339756abb1c004bc0f8283e716ae155e1694583710e5d3118433ec`


## 1.4.5 mobile controls and automatic PiP — 2026-09-07

- Web: 55 files / 592 tests; Android JVM: 7 tests. Final viewport sizing
  correction: 4 PiP tests and APK rebuild passed. Version surfaces match 1.4.5.
- API 36 emulator with synthetic media: Home entered pinned video PiP, retained
  playback (1.78 to 12.42 seconds), and displayed video alone. Video/root/visual
  viewport matched 228.19 × 128px after fixing a page-scale gap. Returning restored
  the original screen; dragging PiP to dismiss paused video.
- Settled paused video and background music did not auto-enter PiP. Music kept
  playing in the native service. Immediate pause/Home events can race the
  asynchronous web-to-native state notification.
- Mobile mini title/time/progress/thumb start matched x=70.76px; artist delimiter,
  three larger controls, playlist navigation, translucent sleep timer and 37.12px
  sheet header controls were checked. Edge/top-space swipes changed tabs.
- Samsung SM-S936N update install succeeded with settings retained; package is
  versionCode 7 / 1.4.5-web-dev. Activity launch and process confirmed. Samsung
  PiP/gesture acceptance and Android 8–11 fallback remain device checks.
- Artifact: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev.apk`
- SHA-256: `ed885d978a52326f278b493212af38f6e13cfedb8534af25129453c16bcf6a78`


## Local music, immediate selection and library filters — 2026-09-07 / versionCode 8

- Full web suite: 57 files / 605 tests. Android JVM: 10 tests. Corrected a
  TypeScript test fixture's required `completed` field; the affected progress
  suite passed 7 tests and TypeScript/Vite/APK assembly then passed. The final
  320px tab font adjustment passed App's 32 tests and APK rebuild.
- Actual Android SAF UI on API 36 added a synthetic Music/MuzioLocalQA folder.
  One local MP3 appeared alongside three network items. Offline source filtering
  selected only the local item. After stopping the isolated backend and cold
  restarting the app, the persisted local item played in ExoPlayer (50.413s).
- Removing the folder removed its library row while the original 720,652-byte
  MP3 remained on disk. No personal phone folders were added or removed.
- Search `#Sample artist` selected the artist chip and returned both matching
  local and network rows. The filter modal rendered top sorting, lower facets
  and a scrollable glass surface. At 320px, Image ended at 213.96px and the filter
  button began at 215.96px; document width stayed 320px.
- A synthetic four-item queue tap painted the selected/loading UI at 27.4ms,
  before native load dispatch at 48.3ms, with no duplicate queue command.
  This is emulator evidence, not a large personal-library latency benchmark.
- Samsung SM-S936N: update install succeeded, Activity and running process
  confirmed, versionCode 8 / 1.4.5-web-dev. Personal-library responsiveness and
  folder-provider/device power behavior remain user acceptance.
- Artifact: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc8.apk`
- Size: 23,157,603 bytes.
- SHA-256: `32d657ec20bcd532c4336e39dd23e2503d679f52e1a80654096240f3fdd2e0fa`


## Shared web release and filter layout — 2026-09-07 / versionCode 9

- Web release now serves 1.4.5-r4. Production HTTPS health and served JS/CSS
  byte parity passed. Local-folder settings remain hidden in the web browser.
- Desktop filter: 576 × 700px at 1440 × 1000, six sort columns, compact tags,
  body height/scrollHeight both 556px. Mobile retains 372px width at 412px and
  three sort columns. Artist pagination, tag search and sort synchronization
  were checked in the deployed web UI.
- Settings removes the empty filter host: topbar width 396.19 → 352.19px,
  search retained; returning to Music restores the filter button.
- Affected App suite: 32 tests passed. TypeScript/Vite/web deployment and final
  Android APK assembly passed. Samsung update install and Activity launch
  succeeded; package reports versionCode 9 / 1.4.5-web-dev.
- Artifact: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc9.apk`
- SHA-256: `802a0c04ddedeb1dc43454aed08d0f1307c7030c4cc0b047d8ace503f8e83d2d`


## Search filter previews and local artwork — versionCode 10 / 2026-09-07

- Search preview/component + LibraryScreen + App: 69 tests passed; the final
  App integration case passed with all 33 App tests. Kotlin compile and existing
  Android JVM 10 tests passed; final shared-web TypeScript/Vite/APK build passed.
- Deployed web 1.4.5-r5: partial artist search, eight-candidate cap, tag selection
  closes search and applies the central list. At 412px preview spans x12..400px.
- On API36, added a synthetic embedded-cover MP3 with the old APK. After updating
  without re-registering the folder and stopping the isolated backend, the new
  APK showed the 240x240 JPEG in both library row and mini-player; local playback
  advanced to 11.38s. Missing art/unregistered IDs return404 and retain fallback.
- Removing the root made its previous artwork URL return404; original MP3 stayed
  on disk. Personal phone folders/files were not changed during verification.
- Samsung update install and Activity launch succeeded, versionCode10.
- Artifact: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc10.apk`
- SHA-256: `a8a823503a907ad50ec333f0fef0743323582a0c43eed8195ab2af5f0c06cf69`


## Anchored glass sleep timer — versionCode 11 / 2026-09-07

- Shared timer replaces duplicate mini/full controls, with themed presets,
  input, Set and close buttons. Body portal avoids dock backdrop containing blocks.
- Web1280px mini and mobile412px full-player both placed panel12px above trigger;
  viewport clamping kept it onscreen. Escape dismissed only timer, retaining full
  player. Computed glass surface/filter and translucent Set confirmed visually.
- MiniPlayer/FullPlayer68 tests plus anchor/scroll/control/Escape regression1 test
  passed. TypeScript/Vite, web deployment and final APK assembly passed.
- Web PWA1.4.5-r6 served assets match build. Samsung update install, launch and
  versionCode11 confirmed; phone touch acceptance remains a separate check.
- Artifact: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc11.apk`
- SHA-256: `d2948d0e90953f656f8668cd0a94427e1a5e4d7ee456c8c5f3e1c05778aa9a8d`


## Compact shared filter sorting — versionCode 12 / 2026-09-07

- Queue-style Sort glass title and round close button; six icon sort criteria
  and one ascending/descending toggle share a row on web and Android.
- LibraryScreen/App68 tests pass, including applied ascending/descending order
  and reopen behavior. Latest retains its fixed newest-first contract.
- Web412px and1280px visually checked. At320px all seven controls share the same
  y-coordinate with document width320px. Desktop modal576x635px.
- TypeScript/Vite, deployed web assets/PWA1.4.5-r7, version check and APK build pass.
- No adb devices connected: versionCode12 installation and phone touch acceptance
  remain pending. Last installed Samsung version is11.
- Artifact: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc12.apk`
- SHA-256: `155bd8fd127e57ca0e34f291d6a5256ee7477539499ce02ba601df5220391208`


## Incremental local catalog — versionCode 13 / 2026-09-07

- Filename catalog precedes metadata; add scans selected root only. Process-owned
  background enrichment persists pending flags and validates revisions/grants
  before commits. Interrupted enumeration and legacy empty-root recovery supported.
- Native JVM 13 tests and local-library/settings 9 web tests pass. Web/Android
  TypeScript/Vite builds, web deployment, APK assembly and version checks pass.
- API36 emulator: 1,001 synthetic MP3 files registered via real SAF permission.
  Catalog persisted 1.221s after Allow input, pending1001/artist0. This measures
  persistence, not phone UI paint latency. After Home4s, artist56/pending945.
- Force-stop preserved945 pending. Reopen resumed it; all1,001 artists completed
  at73.011s including shutdown/relaunch. Local MediaSession showed PLAYING with
  advancing position while233 entries remained pending, without test server access.
- Progress poll stops at completion; delayed polls cannot resurrect removed roots.
  Read-only integration review found no additional blocking concurrency issue.
- PWA1.4.5-r8 served JS/CSS match deployed build. Emulator versionCode13 installed.
  Personal phone installation deferred until user reconnects after work.
- Enumeration can still wait on a slow DocumentsProvider; process death resumes
  on next app startup rather than promising execution while force-stopped.
- Artifact: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc13.apk`
- SHA-256: `975cd09f0bcb28f64d6ec9dde08083bed99822cf25461c0aa28fbee958c9b1d8`


## Landscape fullscreen restoration — 1.4.6 / 2026-09-08

- WebView custom fullscreen now requests sensor landscape, hides system bars,
  removes root insets, and restores the previous window state on exit. Rotation
  keeps the same WebView and video; PiP/focus return reapplies fullscreen state.
- Native JVM25 tests pass (fullscreen lifecycle3), debug APK assembly passes.
  Build log: `/tmp/muzio-android-fullscreen-final-build.log`.
- API36 emulator, portrait rotation locked: actual APK WebView with an isolated
  synthetic inline video enters a landscape839×320 CSS viewport /2200×840 window.
  System bars are hidden. Both DOM exit and Android Back restore portrait;
  two cycles retain one video load and continuous playback.
- The initial UI-automation hierarchy dump changed the emulator rotation lock.
  Retesting without that side effect passed with the existing Back handling;
  the proposed extra Back callback was excluded from the final change.
- Runtime log: `/tmp/muzio-android-fullscreen-runtime-final.log`.
  APK: `app/build/outputs/apk/debug/app-debug.apk`.
- Only the emulator was connected. Physical Android installation and the user's
  real media/player gesture/PiP acceptance remain pending. The synthetic check
  verifies the native fullscreen lifecycle, not network playback performance.


## 1.4.6 closeout — 2026-09-08

- Physical installation and acceptance move to `../update_1.4.7.md` at the user’s request. The completed JVM/emulator evidence above remains valid.
- The final APK includes shared web UI r20; the earlier fullscreen-only APK did not include the subsequent selection/playlist UI. No physical device was installed or tested during closeout.
- Final artifact: `dist/releases/1.4.6-20260908/Muzio-1.4.6-web-r20-vc14.apk`; SHA-256 `47baf18addf8d343cb56943103a10dde406046d4be83ac8cbf0dc390886b9fd1`. Assembly exit0, r20 service worker verified inside the APK. Log: `/tmp/muzio-146-close-android-build.log`.
