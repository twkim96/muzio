package com.twkim.videiomusic.playback

import android.os.Looper
import androidx.media3.common.*
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

/** Advertises the existing WebView video; never opens a second decoder or URL. */
@UnstableApi
class WebVideoSessionPlayer : SimpleBasePlayer(Looper.getMainLooper()) {
    private var snapshot = State.Builder().build()
    private var mediaId = ""
    var dispatch: ((JSONObject) -> Unit)? = null

    fun update(payload: JSONObject) {
        val source = payload.getJSONObject("source")
        mediaId = source.getString("mediaId")
        fun seconds(key: String) = payload.optDouble(key, 0.0).takeIf { it.isFinite() && it >= 0 } ?: 0.0
        val duration = seconds("durationSec")
        val metadata = MediaMetadata.Builder().setTitle(source.optString("title").ifBlank { source.optString("name", "Video") })
            .setArtist(source.optString("artist")).setMediaType(MediaMetadata.MEDIA_TYPE_VIDEO).build()
        val item = MediaItem.Builder().setMediaId(mediaId).setMediaMetadata(metadata).build()
        val commands = Player.Commands.Builder().addAll(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_STOP,
            Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA)
        if (duration > 0) commands.addAll(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD)
        snapshot = State.Builder().setAvailableCommands(commands.build())
            .setPlaylist(listOf(MediaItemData.Builder(mediaId).setMediaItem(item).setMediaMetadata(metadata)
                .setDurationUs(if (duration > 0) (duration * 1_000_000).toLong() else C.TIME_UNSET)
                .setIsSeekable(duration > 0).build()))
            .setCurrentMediaItemIndex(0).setContentPositionMs((seconds("positionSec") * 1000).toLong())
            .setPlaybackState(if (payload.optBoolean("buffering")) Player.STATE_BUFFERING else Player.STATE_READY)
            .setPlayWhenReady(payload.optBoolean("playing"), Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setSeekBackIncrementMs(10_000).setSeekForwardIncrementMs(10_000).build()
        invalidateState()
    }
    override fun getState(): State = snapshot
    private fun send(action: String, position: Long? = null): ListenableFuture<*> {
        dispatch?.invoke(JSONObject().put("mediaId", mediaId).put("action", action).apply {
            if (position != null) put("positionSec", position / 1000.0)
        })
        return Futures.immediateVoidFuture()
    }
    override fun handleSetPlayWhenReady(playWhenReady: Boolean) = send(if (playWhenReady) "play" else "pause")
    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int) = send("seek", positionMs.coerceAtLeast(0))
    override fun handleStop() = send("pause")
}
