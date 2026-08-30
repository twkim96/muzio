package com.twkim.videiomusic.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import com.twkim.videiomusic.playback.PlaybackRuntime
import kotlinx.coroutines.delay

@Composable
internal fun FullAudioPlayerScreen(
    player: Player,
    fallbackDurationMs: Long,
    initialPanel: String? = null,
    liked: Boolean,
    onToggleLike: () -> Unit,
    onCollapse: () -> Unit,
) {
    var positionMs by remember { mutableLongStateOf(player.currentPosition.coerceAtLeast(0L)) }
    var durationMs by remember { mutableLongStateOf(player.safeDuration(fallbackDurationMs)) }
    val durationKnown = durationMs > 0L
    var isPlaying by remember { mutableStateOf(player.isPlaying) }
    var repeatMode by remember { mutableIntStateOf(player.repeatMode) }
    var shuffle by remember { mutableStateOf(player.shuffleModeEnabled) }
    var queueVersion by remember { mutableIntStateOf(0) }
    var showQueue by remember(initialPanel) { mutableStateOf(initialPanel == "queue") }
    var actionPanel by remember(initialPanel) {
        mutableStateOf(initialPanel.takeIf { it == "timer" || it == "volume" })
    }
    var customTimerMinutes by remember { mutableStateOf("") }
    var currentItem by remember { mutableStateOf(player.currentMediaItem) }
    val runtime by PlaybackRuntime.state.collectAsStateWithLifecycle()
    BackHandler {
        when {
            showQueue -> showQueue = false
            actionPanel != null -> actionPanel = null
            else -> onCollapse()
        }
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) {
                currentItem = player.currentMediaItem
                positionMs = player.currentPosition.coerceAtLeast(0L)
                durationMs = player.safeDuration(fallbackDurationMs)
                isPlaying = player.isPlaying
                repeatMode = player.repeatMode
                shuffle = player.shuffleModeEnabled
                queueVersion += 1
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                currentItem = mediaItem
                positionMs = player.currentPosition.coerceAtLeast(0L)
                durationMs = player.safeDuration(fallbackDurationMs)
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }
    LaunchedEffect(player, isPlaying) {
        while (isPlaying) {
            positionMs = player.currentPosition.coerceAtLeast(0L)
            durationMs = player.safeDuration(fallbackDurationMs)
            delay(500)
        }
    }

    Surface(
        Modifier.fillMaxSize().verticalDismissGesture(onCollapse),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
                .background(
                    Brush.linearGradient(
                        listOf(
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
                            MaterialTheme.colorScheme.background,
                            Color(0xFF182019),
                        ),
                    ),
                )
                .padding(horizontal = 22.dp, vertical = 14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCollapse) { Text("⌄", fontSize = 30.sp) }
                Spacer(Modifier.weight(1f))
            }

            if (showQueue) {
                QueuePanel(player = player, version = queueVersion, onClose = { showQueue = false })
            } else {
                Spacer(Modifier.height(8.dp))
                Box(
                    modifier = Modifier.fillMaxWidth(0.78f).aspectRatio(1f).clip(RoundedCornerShape(16.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                    contentAlignment = Alignment.Center,
                ) {
                    val artwork = currentItem?.mediaMetadata?.artworkUri
                    Text("♫", fontSize = 72.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (artwork != null) {
                        AsyncImage(
                            model = artwork,
                            contentDescription = null,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop,
                        )
                    }
                }
                Spacer(Modifier.height(18.dp))
                Text(
                    currentItem?.mediaMetadata?.title?.toString().orEmpty().ifBlank { "Not Playing" },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.fillMaxWidth(0.78f),
                )
                Text(
                    currentItem?.mediaMetadata?.artist?.toString().orEmpty().ifBlank {
                        currentItem?.mediaMetadata?.extras
                            ?.getString(com.twkim.videiomusic.playback.PlaybackService.EXTRA_ROOT_NAME).orEmpty()
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 18.sp,
                    modifier = Modifier.fillMaxWidth(0.78f),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(0.82f).padding(top = 10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PlayerActionButton(if (liked) "♥" else "♡", liked, onClick = onToggleLike)
                    PlayerActionButton("◷", actionPanel == "timer") {
                        actionPanel = if (actionPanel == "timer") null else "timer"
                    }
                    PlayerActionButton(if (runtime.muted) "◌" else "◉", actionPanel == "volume") {
                        actionPanel = if (actionPanel == "volume") null else "volume"
                    }
                    PlayerActionButton("☷", showQueue) { showQueue = true }
                    PlayerActionButton("•••", enabled = false) {}
                    PlayerActionButton("⊣", runtime.stopAfterCurrent) {
                        PlaybackRuntime.toggleStopAfterCurrent()
                    }
                }
                Spacer(Modifier.height(6.dp))
                Slider(
                    value = if (durationKnown) positionMs.coerceAtMost(durationMs).toFloat() else 0f,
                    onValueChange = { positionMs = it.toLong() },
                    onValueChangeFinished = { player.seekTo(positionMs) },
                    valueRange = 0f..durationMs.coerceAtLeast(1L).toFloat(),
                    enabled = durationKnown,
                    modifier = Modifier.fillMaxWidth(0.82f),
                )
                Row(Modifier.fillMaxWidth(0.82f)) {
                    Text(formatTime(positionMs))
                    Spacer(Modifier.weight(1f))
                    Text(if (durationKnown) formatTime(durationMs) else "--:--")
                }
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(0.86f),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(
                        onClick = {
                            player.shuffleModeEnabled = !player.shuffleModeEnabled
                            shuffle = player.shuffleModeEnabled
                        },
                    ) {
                        Text(
                            "⇄",
                            fontSize = 23.sp,
                            color = if (shuffle) MaterialTheme.colorScheme.primary else Color.White,
                        )
                    }
                    TextButton(
                        enabled = player.hasPreviousMediaItem(),
                        onClick = { player.seekToPreviousMediaItem() },
                    ) { Text("◀|", fontSize = 24.sp) }
                    TextButton(onClick = { if (player.isPlaying) player.pause() else player.play() }) {
                        Text(if (isPlaying) "Ⅱ" else "▶", fontSize = 46.sp, color = Color.White)
                    }
                    TextButton(
                        enabled = player.hasNextMediaItem(),
                        onClick = { player.seekToNextMediaItem() },
                    ) { Text("|▶", fontSize = 24.sp) }
                    TextButton(
                        onClick = {
                            player.repeatMode = when (player.repeatMode) {
                                Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
                                Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
                                else -> Player.REPEAT_MODE_OFF
                            }
                            repeatMode = player.repeatMode
                        },
                    ) {
                        Text(
                            when (repeatMode) {
                                Player.REPEAT_MODE_ONE -> "↻¹"
                                else -> "↻"
                            },
                            fontSize = 23.sp,
                            color = if (repeatMode == Player.REPEAT_MODE_OFF) Color.White
                            else MaterialTheme.colorScheme.primary,
                        )
                    }
                }
                when (actionPanel) {
                    "timer" -> {
                        Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp),
                        ) {
                            Text("Sleep Timer", fontWeight = FontWeight.SemiBold)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                                listOf(1, 15, 30, 60).forEach { minutes ->
                                    TextButton(onClick = { PlaybackRuntime.startSleepTimer(minutes.toDouble()) }) {
                                        Text("${minutes}m")
                                    }
                                }
                                TextButton(
                                    enabled = runtime.sleepTimerEndsAtMs != null || runtime.sleepTimerExpired,
                                    onClick = PlaybackRuntime::cancelSleepTimer,
                                ) { Text("Off") }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                OutlinedTextField(
                                    value = customTimerMinutes,
                                    onValueChange = { customTimerMinutes = it },
                                    modifier = Modifier.weight(1f),
                                    label = { Text("Custom minutes") },
                                    singleLine = true,
                                )
                                TextButton(
                                    onClick = {
                                        customTimerMinutes.toDoubleOrNull()?.let(PlaybackRuntime::startSleepTimer)
                                    },
                                ) { Text("Start") }
                            }
                        }
                    }

                    "volume" -> {
                        Column(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                TextButton(onClick = PlaybackRuntime::toggleMute) {
                                    Text(if (runtime.muted) "Unmute" else "Mute")
                                }
                                Slider(
                                    value = runtime.volume,
                                    onValueChange = PlaybackRuntime::setVolume,
                                    modifier = Modifier.weight(1f),
                                )
                                Text("${(runtime.volume * 100).toInt()}%")
                            }
                        }
                    }
                }
                Spacer(Modifier.weight(0.65f))
            }
        }
    }
}

@Composable
private fun QueuePanel(player: Player, version: Int, onClose: () -> Unit) {
    @Suppress("UNUSED_VARIABLE") val observedVersion = version
    val entries = remember(version) {
        List(player.mediaItemCount) { index -> player.getMediaItemAt(index) }
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Queue", fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            TextButton(
                enabled = entries.size > 1,
                onClick = { player.clearQueueKeepingCurrent() },
            ) { Text("Clear") }
            TextButton(onClick = onClose) { Text("×", fontSize = 25.sp) }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            itemsIndexed(entries, key = { index, item -> "${item.mediaId}:$index" }) { index, item ->
                QueueRow(
                    item = item,
                    active = index == player.currentMediaItemIndex,
                    onPlay = { player.seekTo(index, 0L); player.play() },
                    onNext = {
                        val target = (player.currentMediaItemIndex + 1).coerceAtMost(player.mediaItemCount - 1)
                        if (index != target) player.moveMediaItem(index, target)
                    },
                    onRemove = { if (player.mediaItemCount > 1) player.removeMediaItem(index) },
                    onUp = { if (index > 0) player.moveMediaItem(index, index - 1) },
                    onDown = { if (index < player.mediaItemCount - 1) player.moveMediaItem(index, index + 1) },
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun QueueRow(
    item: MediaItem,
    active: Boolean,
    onPlay: () -> Unit,
    onNext: () -> Unit,
    onRemove: () -> Unit,
    onUp: () -> Unit,
    onDown: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onPlay).padding(vertical = 9.dp),
    ) {
        Text(
            item.mediaMetadata.title?.toString().orEmpty().ifBlank { item.mediaId },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
        )
        Row {
            TextButton(onClick = onNext) { Text("Play Next") }
            TextButton(onClick = onUp) { Text("Up") }
            TextButton(onClick = onDown) { Text("Down") }
            TextButton(onClick = onRemove) { Text("Remove") }
        }
    }
}

@Composable
private fun PlayerActionButton(
    label: String,
    active: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    TextButton(enabled = enabled, onClick = onClick, modifier = Modifier.size(42.dp)) {
        Text(
            label,
            fontSize = 20.sp,
            color = if (active) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun Player.safeDuration(fallbackDurationMs: Long = 0L): Long =
    duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: fallbackDurationMs.coerceAtLeast(0L)

private fun formatTime(milliseconds: Long): String {
    val totalSeconds = (milliseconds.coerceAtLeast(0L) / 1_000L)
    val hours = totalSeconds / 3_600
    val minutes = (totalSeconds % 3_600) / 60
    val seconds = totalSeconds % 60
    return if (hours > 0) "%d:%02d:%02d".format(hours, minutes, seconds)
    else "%d:%02d".format(minutes, seconds)
}

private fun formatRemaining(seconds: Int): String {
    val minutes = seconds / 60
    val remaining = seconds % 60
    return "%d:%02d".format(minutes, remaining)
}

private fun Player.clearQueueKeepingCurrent() {
    val currentIndex = currentMediaItemIndex
    if (currentIndex < 0 || mediaItemCount <= 1) return
    if (currentIndex + 1 < mediaItemCount) removeMediaItems(currentIndex + 1, mediaItemCount)
    if (currentIndex > 0) removeMediaItems(0, currentIndex)
}
