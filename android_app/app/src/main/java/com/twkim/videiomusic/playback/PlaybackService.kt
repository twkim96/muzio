package com.twkim.videiomusic.playback

import android.content.Intent
import android.app.PendingIntent
import android.app.ActivityOptions
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.AdtsExtractor
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.CommandButton
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
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
@UnstableApi
class PlaybackService : MediaSessionService(), PlaybackRuntimeActions {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val api = MuzioApi()
    private lateinit var libraryPreferencesStore: LibraryPreferencesStore
    private lateinit var notificationLikes: NotificationLikeStore
    private lateinit var likePreferences: SharedPreferences
    private lateinit var openQueue: PendingIntent
    private val likePreferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        scope.launch { refreshNotificationButtons() }
    }
    private lateinit var player: ExoPlayer
    private var mediaSession: MediaSession? = null
    private var lastSample: ProgressSample? = null
    private var lastSyncedAtMs = 0L
    private var progressLoop: Job? = null

    override fun onCreate() {
        super.onCreate()
        libraryPreferencesStore = LibraryPreferencesStore(applicationContext)
        notificationLikes = NotificationLikeStore(applicationContext)
        likePreferences = getSharedPreferences(NotificationLikeStore.PREFERENCES_NAME, Context.MODE_PRIVATE)
        likePreferences.registerOnSharedPreferenceChangeListener(likePreferenceListener)
        // Raw ADTS has no container duration/index. Enable its length-based seek map
        // so both the MediaSession and web bridge receive a usable timeline.
        val extractors = DefaultExtractorsFactory()
            .setAdtsExtractorFlags(AdtsExtractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this, extractors))
            .build().apply {
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
        if (Build.VERSION.SDK_INT < 33) {
            setMediaNotificationProvider(object : DefaultMediaNotificationProvider(this) {
                override fun getMediaButtons(
                    session: MediaSession,
                    playerCommands: Player.Commands,
                    mediaButtonPreferences: ImmutableList<CommandButton>,
                    showPauseButton: Boolean,
                ): ImmutableList<CommandButton> {
                    val buttons = super.getMediaButtons(session, playerCommands, mediaButtonPreferences, showPauseButton)
                    // Keep the provider's availability and slots. Its default compact view uses
                    // BACK/CENTRAL/FORWARD slots, so only previous/play/next appear when collapsed.
                    return ImmutableList.copyOf(buttons.sortedBy { button ->
                        when {
                            button.sessionCommand?.customAction == ACTION_QUEUE -> 0
                            button.playerCommand == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> 1
                            button.playerCommand == Player.COMMAND_PLAY_PAUSE -> 2
                            button.playerCommand == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> 3
                            button.sessionCommand?.customAction == ACTION_LIKE -> 4
                            else -> 5
                        }
                    })
                }
            })
        }
        openQueue = createQueueIntent()
        mediaSession = MediaSession.Builder(this, player)
            .setSessionActivity(openApp)
            .setCallback(sessionCallback)
            .setMediaButtonPreferences(notificationButtons())
            .build()

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
        likePreferences.unregisterOnSharedPreferenceChangeListener(likePreferenceListener)
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
            refreshNotificationButtons()
        }
    }

    private val sessionCallback = object : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                        .add(queueCommand).add(likeCommand).build(),
                ).build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            val result = when (customCommand.customAction) {
                ACTION_QUEUE -> runCatching {
                    val options = ActivityOptions.makeBasic().apply {
                        if (Build.VERSION.SDK_INT >= 36) {
                            setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS)
                        } else if (Build.VERSION.SDK_INT >= 34) {
                            setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                        }
                    }
                    // This send is performed only in response to the user's media action.
                    openQueue.send(this@PlaybackService, 0, null, null, null, null, options.toBundle())
                    SessionResult.RESULT_SUCCESS
                }.getOrDefault(SessionError.ERROR_UNKNOWN)
                ACTION_LIKE -> {
                    val target = currentLikeTarget()
                    if (target == null) SessionError.ERROR_INVALID_STATE else runCatching {
                        notificationLikes.toggle(target.first, target.second)
                        refreshNotificationButtons()
                        SessionResult.RESULT_SUCCESS
                    }.getOrDefault(SessionError.ERROR_UNKNOWN)
                }
                else -> SessionError.ERROR_NOT_SUPPORTED
            }
            return Futures.immediateFuture(SessionResult(result))
        }
    }

    private fun createQueueIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("muzio.open_queue", true)
        val options = ActivityOptions.makeBasic().apply {
            if (Build.VERSION.SDK_INT >= 36) {
                setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS)
            } else if (Build.VERSION.SDK_INT >= 35) {
                setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
            }
        }
        return PendingIntent.getActivity(this, 1, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE, options.toBundle())
    }

    private fun currentLikeTarget(): Pair<String, String>? {
        val item = player.currentMediaItem ?: return null
        val extras = item.mediaMetadata.extras
        val origin = extras?.getString("muzio.notification_origin")?.takeIf(String::isNotBlank)
            ?: extras?.getString(EXTRA_SERVER_ORIGIN).orEmpty()
        val key = extras?.getString(EXTRA_CONTENT_KEY)?.takeIf(String::isNotBlank) ?: item.mediaId
        return if (origin.isBlank() || key.isBlank()) null else origin to key
    }

    private fun notificationButtons(): List<CommandButton> {
        val target = currentLikeTarget()
        val liked = target?.let { notificationLikes.isLiked(it.first, it.second) } == true
        // Standard previous/play/next remain player commands. Android 13+ controls their placement.
        return listOf(
            CommandButton.Builder(CommandButton.ICON_QUEUE_NEXT)
                .setDisplayName("Queue").setSessionCommand(queueCommand)
                .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW).build(),
            CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
                .setDisplayName(if (liked) "Unlike" else "Like").setSessionCommand(likeCommand)
                .setEnabled(target != null)
                .setSlots(CommandButton.SLOT_FORWARD_SECONDARY, CommandButton.SLOT_OVERFLOW).build(),
        )
    }

    private fun refreshNotificationButtons() {
        mediaSession?.setMediaButtonPreferences(notificationButtons())
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
        val targetBaseUrl = sample.baseUrl.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        lastSyncedAtMs = System.currentTimeMillis()
        scope.launch(Dispatchers.IO) {
            if (targetBaseUrl != null) runCatching {
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
        private const val ACTION_QUEUE = "muzio.notification.queue"
        private const val ACTION_LIKE = "muzio.notification.like"
        private val queueCommand = SessionCommand(ACTION_QUEUE, Bundle.EMPTY)
        private val likeCommand = SessionCommand(ACTION_LIKE, Bundle.EMPTY)
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
