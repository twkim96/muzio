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
