package com.twkim.videiomusic.playback

import android.content.Intent
import android.app.PendingIntent
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.twkim.videiomusic.data.MediaType
import com.twkim.videiomusic.data.LibraryPreferencesStore
import com.twkim.videiomusic.data.MuzioApi
import com.twkim.videiomusic.data.ProgressSource
import com.twkim.videiomusic.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns the single app-wide player. Keeping it in a MediaSessionService makes
 * playback, the queue and Android's media notification survive Activity and
 * screen lifecycle changes.
 */
class PlaybackService : MediaSessionService(), PlaybackRuntimeActions {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val api = MuzioApi()
    private lateinit var libraryPreferencesStore: LibraryPreferencesStore
    private lateinit var player: ExoPlayer
    private var mediaSession: MediaSession? = null
    private var lastSample: ProgressSample? = null
    private var lastSyncedAtMs = 0L
    private var progressLoop: Job? = null

    override fun onCreate() {
        super.onCreate()
        libraryPreferencesStore = LibraryPreferencesStore(applicationContext)
        player = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .setUsage(C.USAGE_MEDIA)
                    .build(),
                true,
            )
            setHandleAudioBecomingNoisy(true)
            addListener(playerListener)
        }
        PlaybackRuntime.update { PlaybackRuntimeState() }
        PlaybackRuntime.actions = this
        publishVolumeState()
        val openApp = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        mediaSession = MediaSession.Builder(this, player).setSessionActivity(openApp).build()

        progressLoop = scope.launch {
            while (isActive) {
                delay(PROGRESS_SAMPLE_INTERVAL_MS)
                tickSleepTimer()
                val sample = sampleCurrent() ?: continue
                lastSample = sample
                if (player.isPlaying && System.currentTimeMillis() - lastSyncedAtMs >= PROGRESS_SYNC_INTERVAL_MS) {
                    sync(sample)
                }
            }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        sync(sampleCurrent())
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        sync(sampleCurrent())
        progressLoop?.cancel()
        player.removeListener(playerListener)
        mediaSession?.run {
            player.release()
            release()
        }
        mediaSession = null
        if (PlaybackRuntime.actions === this) PlaybackRuntime.actions = null
        scope.cancel()
        super.onDestroy()
    }

    private val playerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (!isPlaying) sync(sampleCurrent())
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_ENDED) sync(sampleCurrent(completed = true))
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            val previous = lastSample
            if (previous != null) {
                sync(previous.copy(completed = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO))
            }
            if (
                reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO &&
                PlaybackRuntime.state.value.stopAfterCurrent
            ) {
                player.pause()
            }
            mediaItem?.let(::recordPlay)
            lastSample = sampleCurrent()
        }
    }

    @UnstableApi
    override fun toggleStopAfterCurrent() {
        val enabled = !PlaybackRuntime.state.value.stopAfterCurrent
        player.pauseAtEndOfMediaItems = enabled
        PlaybackRuntime.update { it.copy(stopAfterCurrent = enabled) }
    }

    override fun startSleepTimer(minutes: Double) {
        if (!minutes.isFinite() || minutes <= 0.0) return
        val durationSec = (minutes * 60.0).toInt().coerceAtLeast(1)
        PlaybackRuntime.update {
            it.copy(
                sleepTimerEndsAtMs = System.currentTimeMillis() + durationSec * 1_000L,
                sleepTimerRemainingSec = durationSec,
                sleepTimerExpired = false,
            )
        }
    }

    override fun cancelSleepTimer() {
        PlaybackRuntime.update {
            it.copy(sleepTimerEndsAtMs = null, sleepTimerRemainingSec = 0, sleepTimerExpired = false)
        }
    }

    override fun setVolume(volume: Float) {
        val normalized = volume.coerceIn(0f, 1f)
        val state = PlaybackRuntime.state.value
        if (!state.muted) player.volume = normalized
        PlaybackRuntime.update { it.copy(volume = normalized) }
    }

    override fun toggleMute() {
        val state = PlaybackRuntime.state.value
        val muted = !state.muted
        player.volume = if (muted) 0f else state.volume
        PlaybackRuntime.update { it.copy(muted = muted) }
    }

    private fun tickSleepTimer() {
        val state = PlaybackRuntime.state.value
        val endsAt = state.sleepTimerEndsAtMs ?: return
        val remaining = ((endsAt - System.currentTimeMillis() + 999L) / 1_000L).toInt()
        if (remaining <= 0) {
            player.pause()
            PlaybackRuntime.update {
                it.copy(
                    sleepTimerEndsAtMs = null,
                    sleepTimerRemainingSec = 0,
                    sleepTimerExpired = true,
                )
            }
        } else if (remaining != state.sleepTimerRemainingSec) {
            PlaybackRuntime.update { it.copy(sleepTimerRemainingSec = remaining) }
        }
    }

    private fun publishVolumeState() {
        PlaybackRuntime.update {
            it.copy(volume = player.volume.coerceIn(0f, 1f), muted = player.volume <= 0f)
        }
    }

    private fun sampleCurrent(completed: Boolean = false): ProgressSample? {
        val item = player.currentMediaItem ?: return null
        val durationMs = player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: return null
        val positionMs = player.currentPosition.coerceAtLeast(0L)
        if (positionMs <= 0L) return null
        return ProgressSample(
            mediaId = item.mediaId,
            positionSec = positionMs / 1_000.0,
            durationSec = durationMs / 1_000.0,
            completed = completed || positionMs >= durationMs * 0.95 || durationMs - positionMs < 10_000,
            source = item.progressSource(),
            contentKey = item.mediaMetadata.extras?.getString(EXTRA_CONTENT_KEY).orEmpty(),
            baseUrl = item.mediaMetadata.extras?.getString(EXTRA_SERVER_ORIGIN)
                ?: item.localConfiguration?.uri?.let { uri -> "${uri.scheme}://${uri.encodedAuthority}" }.orEmpty(),
        )
    }

    private fun sync(sample: ProgressSample?) {
        sample ?: return
        val targetBaseUrl = sample.baseUrl.takeIf { it.isNotBlank() } ?: return
        lastSyncedAtMs = System.currentTimeMillis()
        scope.launch(Dispatchers.IO) {
            runCatching {
                api.putProgress(
                    baseUrl = targetBaseUrl,
                    mediaId = sample.mediaId,
                    positionSec = sample.positionSec,
                    durationSec = sample.durationSec,
                    completed = sample.completed,
                    source = sample.source,
                )
            }
            runCatching {
                libraryPreferencesStore.updateActivityProgress(
                    contentKey = sample.contentKey,
                    mediaId = sample.mediaId,
                    positionSec = sample.positionSec,
                    durationSec = sample.durationSec,
                    completed = sample.completed,
                )
            }
        }
    }

    private fun recordPlay(item: MediaItem) {
        val extras = item.mediaMetadata.extras ?: return
        val contentKey = extras.getString(EXTRA_CONTENT_KEY).orEmpty()
        val mediaType = MediaType.entries.firstOrNull {
            it.apiValue == extras.getString(EXTRA_MEDIA_TYPE)
        } ?: return
        scope.launch(Dispatchers.IO) {
            runCatching {
                libraryPreferencesStore.recordPlay(
                    contentKey = contentKey,
                    mediaId = item.mediaId,
                    mediaType = mediaType,
                    name = extras.getString(EXTRA_NAME).orEmpty(),
                    artist = extras.getString(EXTRA_ARTIST)?.takeIf(String::isNotBlank),
                )
            }
        }
    }

    private data class ProgressSample(
        val mediaId: String,
        val positionSec: Double,
        val durationSec: Double,
        val completed: Boolean,
        val source: ProgressSource?,
        val contentKey: String,
        val baseUrl: String,
    )

    companion object {
        const val EXTRA_SERVER_ORIGIN = "muzio.server_origin"
        const val EXTRA_WEB_SOURCE = "muzio.web_source"
        const val EXTRA_MEDIA_TYPE = "muzio.media_type"
        const val EXTRA_NAME = "muzio.name"
        const val EXTRA_ROOT_NAME = "muzio.root_name"
        const val EXTRA_RELATIVE_PATH = "muzio.relative_path"
        const val EXTRA_CONTENT_KEY = "muzio.content_key"
        const val EXTRA_ARTIST = "muzio.artist"

        private const val PROGRESS_SAMPLE_INTERVAL_MS = 1_000L
        private const val PROGRESS_SYNC_INTERVAL_MS = 10_000L

        fun sourceExtras(
            mediaType: MediaType,
            name: String,
            rootName: String,
            relativePath: String,
            contentKey: String,
            artist: String?,
        ) = Bundle().apply {
            putString(EXTRA_MEDIA_TYPE, mediaType.apiValue)
            putString(EXTRA_NAME, name)
            putString(EXTRA_ROOT_NAME, rootName)
            putString(EXTRA_RELATIVE_PATH, relativePath)
            putString(EXTRA_CONTENT_KEY, contentKey)
            putString(EXTRA_ARTIST, artist.orEmpty())
        }
    }
}

private fun MediaItem.progressSource(): ProgressSource? {
    val extras = mediaMetadata.extras ?: return null
    val mediaType = MediaType.entries.firstOrNull {
        it.apiValue == extras.getString(PlaybackService.EXTRA_MEDIA_TYPE)
    } ?: return null
    val name = extras.getString(PlaybackService.EXTRA_NAME).orEmpty()
    val rootName = extras.getString(PlaybackService.EXTRA_ROOT_NAME).orEmpty()
    val relativePath = extras.getString(PlaybackService.EXTRA_RELATIVE_PATH).orEmpty()
    if (name.isBlank() || rootName.isBlank() || relativePath.isBlank()) return null
    return ProgressSource(mediaType, name, rootName, relativePath)
}
