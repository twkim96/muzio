package com.twkim.videiomusic.playback

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.twkim.videiomusic.data.LibraryItem
import com.twkim.videiomusic.data.LibraryMetadata
import com.twkim.videiomusic.data.MediaType
import com.twkim.videiomusic.data.contentKey
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import com.twkim.videiomusic.playback.NativePlaybackPolicy.serverOrigin

/** Activity-owned transport adapter; the service owns playback and timer lifetime. */
class NativePlaybackBridge(
    context: Context,
    serverBaseUrl: String,
    private val emit: (JSONObject) -> Unit,
) {
    private val localLibrary = com.twkim.videiomusic.data.LocalLibraryManager(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var origin = serverOrigin(serverBaseUrl)
    private var disposed = false
    private val ready = CompletableDeferred<MediaController>()
    private var controller: MediaController? = null
    private var queueRevision = 0L
    private var emittedQueueRevision = -1L
    private val future = MediaController.Builder(
        context.applicationContext,
        SessionToken(context, ComponentName(context, PlaybackService::class.java)),
    ).buildAsync()
    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)) queueRevision++
            publish()
        }
    }

    init {
        future.addListener({
            if (!disposed) {
                runCatching { future.get() }.onSuccess { player ->
                    controller = player
                    player.addListener(listener)
                    ready.complete(player)
                    publish()
                }.onFailure { ready.completeExceptionally(it) }
            }
        }, ContextCompat.getMainExecutor(context))
        scope.launch {
            if (runCatching { ready.await() }.isFailure) return@launch
            while (isActive) { delay(1_000); publish() }
        }
    }

    fun setServerBaseUrl(value: String) { origin = serverOrigin(value) }

    fun handle(command: String, payload: JSONObject, callback: (Result<JSONObject>) -> Unit) {
        if (disposed) { callback(Result.failure(IllegalStateException("Playback bridge disposed"))); return }
        scope.launch {
            val result = runCatching {
                val player = withTimeout(15_000) { ready.await() }
                val localIds = mutableSetOf<String>()
                payload.optJSONObject("source")?.takeIf { it.optString("location") == "local" }?.let { localIds.add(it.getString("mediaId")) }
                payload.optJSONArray("queue")?.let { entries ->
                    for (i in 0 until entries.length()) entries.getJSONObject(i).takeIf { it.optString("location") == "local" }?.let { localIds.add(it.getString("mediaId")) }
                }
                val localUris = if (localIds.isEmpty()) emptyMap() else localLibrary.resolveAll(localIds)
                when (command) {
                    "playback.snapshot" -> Unit
                    "playback.load" -> load(player, payload, localUris)
                    "playback.queue" -> updateQueue(player, payload, localUris)
                    "playback.play" -> {
                        if (player.playbackState == Player.STATE_ENDED) player.seekToDefaultPosition()
                        if (player.playbackState == Player.STATE_IDLE) player.prepare()
                        player.play()
                    }
                    "playback.pause" -> player.pause()
                    "playback.seek" -> player.seekTo(seconds(payload, "positionSec"))
                    "playback.settings" -> settings(player, payload)
                    "playback.clear" -> { player.pause(); player.stop(); player.clearMediaItems(); PlaybackRuntime.cancelSleepTimer() }
                    else -> error("Unknown playback command: $command")
                }
                snapshot(player, true)
            }
            callback(result)
            publish()
        }
    }

    fun dispose() {
        disposed = true
        controller?.removeListener(listener)
        scope.cancel()
        MediaController.releaseFuture(future)
        controller = null
    }

    private fun load(player: MediaController, payload: JSONObject, localUris: Map<String, Uri>) {
        val source = payload.getJSONObject("source")
        val queue = payload.optJSONArray("queue")?.takeIf { it.length() > 0 } ?: JSONArray().put(source)
        val index = payload.optInt("index", 0)
        val selected = NativePlaybackPolicy.loadIdentity(identity(source),
            (0 until queue.length()).map { identity(queue.getJSONObject(it)) }, index)
        val resolved = JSONObject(source.toString()).apply {
            selected.queueEntryId?.let { put("queueEntryId", it) }
        }
        val items = (0 until queue.length()).map { mediaItem(if (it == index) resolved else queue.getJSONObject(it), localUris) }
        player.pause()
        player.setMediaItems(items, index, if (payload.has("positionSec")) seconds(payload, "positionSec") else 0L)
        player.prepare()
    }

    private fun updateQueue(player: MediaController, payload: JSONObject, localUris: Map<String, Uri>) {
        val entries = payload.getJSONArray("queue")
        val next = items(entries, localUris)
        if (next.isEmpty()) { player.pause(); player.stop(); player.clearMediaItems(); return }
        val existingIndex = NativePlaybackPolicy.retainedIndex(
            source(player.currentMediaItem)?.let(::identity),
            (0 until entries.length()).map { identity(entries.getJSONObject(it)) },
        )
        val index = if (existingIndex >= 0) existingIndex else payload.optInt("index", 0)
        require(index in next.indices) { "Invalid queue index" }
        if (existingIndex >= 0) {
            // Keep the current MediaItem object and playback buffer; replace only its neighbours.
            val current = player.currentMediaItemIndex
            if (current > 0) player.removeMediaItems(0, current)
            if (player.mediaItemCount > 1) player.removeMediaItems(1, player.mediaItemCount)
            if (index > 0) player.addMediaItems(0, next.subList(0, index))
            if (index + 1 < next.size) player.addMediaItems(player.mediaItemCount, next.subList(index + 1, next.size))
        } else {
            if (player.mediaItemCount == 0) player.pause()
            player.setMediaItems(next, index, 0L)
            player.prepare()
        }
    }

    private fun settings(player: MediaController, payload: JSONObject) {
        if (payload.has("repeatMode")) player.repeatMode = when (payload.getString("repeatMode")) {
            "none" -> Player.REPEAT_MODE_OFF
            "all" -> Player.REPEAT_MODE_ALL
            "one" -> Player.REPEAT_MODE_ONE
            else -> error("Invalid repeat mode")
        }
        if (payload.has("volume")) {
            val volume = payload.getDouble("volume")
            require(volume.isFinite() && volume in 0.0..1.0) { "Invalid volume" }
            PlaybackRuntime.setVolume(volume.toFloat())
        }
        if (payload.has("muted") && payload.getBoolean("muted") != PlaybackRuntime.state.value.muted) PlaybackRuntime.toggleMute()
        if (payload.has("stopAfterCurrent") && payload.getBoolean("stopAfterCurrent") != PlaybackRuntime.state.value.stopAfterCurrent) PlaybackRuntime.toggleStopAfterCurrent()
        if (payload.has("sleepTimerEndsAtMs")) {
            if (payload.isNull("sleepTimerEndsAtMs")) PlaybackRuntime.cancelSleepTimer()
            else {
                val endsAt = payload.getLong("sleepTimerEndsAtMs")
                val remaining = endsAt - System.currentTimeMillis()
                if (remaining <= 0) {
                    player.pause()
                    PlaybackRuntime.update { it.copy(sleepTimerEndsAtMs = null, sleepTimerRemainingSec = 0, sleepTimerExpired = true) }
                } else PlaybackRuntime.update {
                    it.copy(sleepTimerEndsAtMs = endsAt, sleepTimerRemainingSec = (remaining / 1000).coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), sleepTimerExpired = false)
                }
            }
        }
    }

    private fun items(queue: JSONArray, localUris: Map<String, Uri>): List<MediaItem> = (0 until queue.length()).map { mediaItem(queue.getJSONObject(it), localUris) }

    private fun mediaItem(source: JSONObject, localUris: Map<String, Uri>): MediaItem {
        require(source.getString("kind") == "remote" && source.getString("mediaType") == "audio") { "Only remote audio is supported" }
        val mediaId = source.getString("mediaId").also { require(it.isNotBlank()) }
        val local = source.optString("location") == "local"
        val url = if (local) localUris[mediaId] ?: error("Local audio is not authorized") else mediaUri(source.getString("url"))
        val name = source.getString("name")
        val title = source.optString("title", name)
        val artist = source.optString("artist").takeIf { it.isNotBlank() }
        val root = source.optString("rootName")
        val path = source.optString("relativePath")
        val identity = LibraryItem(mediaId, MediaType.Audio, root, path, name, null, 0, "",
            LibraryMetadata(source.optString("title"), artist, source.optString("album")), thumbnail = null).contentKey()
        val extras = PlaybackService.sourceExtras(MediaType.Audio, name, root, path, identity, artist).apply {
            putString(PlaybackService.EXTRA_SERVER_ORIGIN, if (local) "" else origin)
            putString(PlaybackService.EXTRA_WEB_SOURCE, source.toString())
        }
        val metadata = MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(source.optString("album"))
            .setExtras(extras)
        if (!local) source.optString("artworkUrl").takeIf { it.isNotBlank() }?.let { metadata.setArtworkUri(mediaUri(it, artwork = true)) }
        return MediaItem.Builder().setMediaId(mediaId).setUri(url)
            .setMimeType(source.optString("mimeType").takeIf { it.isNotBlank() })
            .setMediaMetadata(metadata.build()).build()
    }

    private fun mediaUri(value: String, artwork: Boolean = false): Uri =
        Uri.parse(NativePlaybackPolicy.mediaUrl(origin, value, artwork))

    private fun identity(source: JSONObject) = NativePlaybackPolicy.Entry(
        source.getString("mediaId"), source.optString("queueEntryId").takeIf { it.isNotEmpty() },
    )

    private fun source(item: MediaItem?): JSONObject? = item?.mediaMetadata?.extras
        ?.getString(PlaybackService.EXTRA_WEB_SOURCE)?.let { JSONObject(it) }

    private fun snapshot(player: MediaController, includeQueue: Boolean): JSONObject {
        val runtime = PlaybackRuntime.state.value
        val currentSource = source(player.currentMediaItem)
        val kind = when {
            player.playerError != null -> "error"
            player.mediaItemCount == 0 -> "idle"
            player.playbackState == Player.STATE_ENDED -> "ended"
            player.playbackState == Player.STATE_BUFFERING -> if (player.currentPosition <= 0) "loading" else "buffering"
            player.isPlaying -> "playing"
            else -> "paused"
        }
        val status = JSONObject().put("kind", kind)
        player.playerError?.let { status.put("message", it.message ?: "Audio playback failed") }
        return JSONObject().put("source", currentSource ?: JSONObject.NULL).put("status", status)
            .put("positionSec", player.currentPosition.coerceAtLeast(0) / 1000.0)
            .put("durationSec", if (player.duration > 0 && player.duration != C.TIME_UNSET) player.duration / 1000.0 else currentSource?.optDouble("durationSec", 0.0)?.takeIf { it.isFinite() } ?: 0.0)
            .put("index", if (player.mediaItemCount == 0) -1 else player.currentMediaItemIndex)
            .put("repeatMode", when (player.repeatMode) { Player.REPEAT_MODE_ALL -> "all"; Player.REPEAT_MODE_ONE -> "one"; else -> "none" })
            .put("volume", runtime.volume.toDouble()).put("muted", runtime.muted)
            .put("stopAfterCurrent", runtime.stopAfterCurrent)
            .put("sleepTimerEndsAtMs", runtime.sleepTimerEndsAtMs ?: JSONObject.NULL)
            .put("sleepTimerExpired", runtime.sleepTimerExpired)
            .apply { if (includeQueue) put("queue", JSONArray().apply { for (i in 0 until player.mediaItemCount) put(source(player.getMediaItemAt(i)) ?: JSONObject.NULL) }) }
    }

    private fun publish() {
        val player = controller ?: return
        if (disposed) return
        val includeQueue = queueRevision != emittedQueueRevision
        emit(JSONObject().put("type", "playback").put("state", snapshot(player, includeQueue)))
        emittedQueueRevision = queueRevision
    }

    private fun seconds(payload: JSONObject, key: String): Long {
        val value = payload.getDouble(key)
        require(value.isFinite() && value >= 0 && value <= Long.MAX_VALUE / 1000.0) { "Invalid $key" }
        return (value * 1000).toLong()
    }

}
