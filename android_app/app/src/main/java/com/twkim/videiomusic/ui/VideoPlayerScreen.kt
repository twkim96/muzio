package com.twkim.videiomusic.ui

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Rational
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.Player
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import com.twkim.videiomusic.data.FallbackPlan
import com.twkim.videiomusic.data.LibraryItem
import com.twkim.videiomusic.data.displayTitle
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
internal fun VideoPlayerScreen(
    item: LibraryItem,
    player: Player,
    streamUrl: String,
    errorMessage: String?,
    fallbackPlan: FallbackPlan?,
    fallbackLoading: Boolean,
    upNextItems: List<LibraryItem>,
    thumbnailUrlFor: (LibraryItem) -> String?,
    onPlayUpNext: (LibraryItem) -> Unit,
    onRetry: () -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)
    val context = LocalContext.current
    Surface(
        Modifier.fillMaxSize().verticalDismissGesture(onClose),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onClose) {
                    Text("⌄", color = MaterialTheme.colorScheme.onSurface, fontSize = 30.sp)
                }
            }
            AndroidView(
                factory = { viewContext ->
                    PlayerView(viewContext).apply {
                        this.player = player
                        useController = true
                        layoutParams = FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                    }
                },
                update = { it.player = player },
                modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black),
            )
            LazyColumn(
                modifier = Modifier.fillMaxWidth().weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "video-info") {
                    Text(
                        item.displayTitle(),
                        color = MaterialTheme.colorScheme.onSurface,
                        fontSize = 21.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        item.metadata.artist ?: item.relativePath,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(top = 3.dp),
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedButton(onClick = { context.openStream(streamUrl, item.mimeType) }) {
                            Text("Open stream")
                        }
                        OutlinedButton(onClick = { context.shareStream(streamUrl, item.displayTitle()) }) {
                            Text("Share stream")
                        }
                        OutlinedButton(onClick = { context.enterVideoPip() }) { Text("PiP") }
                    }
                }
                if (errorMessage != null) {
                    item(key = "video-error") {
                        Column(
                            Modifier.fillMaxWidth().background(
                                MaterialTheme.colorScheme.surfaceVariant,
                                RoundedCornerShape(12.dp),
                            ).padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                if (context.isOnline()) "Playback failed" else "Network unavailable",
                                color = MaterialTheme.colorScheme.error,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(errorMessage, color = MaterialTheme.colorScheme.onSurface)
                            Text(
                                when {
                                    fallbackLoading -> "Checking fallback…"
                                    fallbackPlan == null -> "Fallback status unavailable. Direct play can be retried."
                                    fallbackPlan.status == "disabled" -> "Fallback unavailable: ${fallbackPlan.reason}"
                                    else -> "Fallback available: ${fallbackPlan.action}. ${fallbackPlan.reason}"
                                },
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Row {
                                Button(onClick = onRetry) { Text("Retry") }
                                TextButton(onClick = { context.openStream(streamUrl, item.mimeType) }) {
                                    Text("External player")
                                }
                            }
                        }
                    }
                }
                item(key = "video-description") {
                    VideoDescriptionCard(item)
                }
                item(key = "video-list-title") {
                    Text(
                        "Videos",
                        color = MaterialTheme.colorScheme.onSurface,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                items(upNextItems.take(24), key = LibraryItem::id) { next ->
                    val current = next.id == item.id
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .background(
                                if (current) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent,
                            )
                            .clickable(enabled = !current) { onPlayUpNext(next) }
                            .padding(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier.width(120.dp).height(68.dp).clip(RoundedCornerShape(8.dp))
                                .background(Color.Black),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text("▶", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            thumbnailUrlFor(next)?.let { thumbnail ->
                                AsyncImage(
                                    model = thumbnail,
                                    contentDescription = null,
                                    modifier = Modifier.fillMaxSize(),
                                    contentScale = ContentScale.Crop,
                                )
                            }
                        }
                        Column(Modifier.weight(1f).padding(start = 10.dp)) {
                            if (current) {
                                Text("Now playing", color = MaterialTheme.colorScheme.primary, fontSize = 12.sp)
                            }
                            Text(
                                next.displayTitle(),
                                color = MaterialTheme.colorScheme.onSurface,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                "${next.rootName} / ${next.relativePath}",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun VideoDescriptionCard(item: LibraryItem) {
    Column(
        Modifier.fillMaxWidth().background(
            MaterialTheme.colorScheme.surfaceVariant,
            RoundedCornerShape(12.dp),
        ).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        VideoDetail("Root", item.rootName)
        VideoDetail("Path", item.relativePath)
        item.metadata.durationSec?.let { VideoDetail("Duration", formatVideoDuration(it)) }
        VideoDetail("Size", formatVideoSize(item.sizeBytes))
        VideoDetail("Modified", formatVideoModified(item.modifiedAt))
        if (item.subtitles.isNotEmpty()) {
            VideoDetail(
                "Subtitles",
                item.subtitles.joinToString { subtitle ->
                    subtitle.language?.let { "${subtitle.label} ($it)" } ?: subtitle.label
                },
            )
        }
    }
}

@Composable
private fun VideoDetail(label: String, value: String) {
    Column {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
        Text(value, color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp)
    }
}

private fun formatVideoDuration(seconds: Double): String {
    val total = seconds.toLong().coerceAtLeast(0L)
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val remainder = total % 60
    return if (hours > 0) "%d:%02d:%02d".format(hours, minutes, remainder)
    else "%d:%02d".format(minutes, remainder)
}

private fun formatVideoSize(bytes: Long): String {
    val mib = bytes / (1024.0 * 1024.0)
    return if (mib < 1024) "%.1f MiB".format(mib) else "%.2f GiB".format(mib / 1024.0)
}

private val videoDateFormatter: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy. M. d. a h:mm").withZone(ZoneId.systemDefault())

private fun formatVideoModified(value: String): String = runCatching {
    videoDateFormatter.format(Instant.parse(value))
}.getOrDefault(value)

private fun Context.openStream(url: String, mimeType: String?) {
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(Uri.parse(url), mimeType ?: "video/*")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    runCatching { startActivity(Intent.createChooser(intent, "Open stream")) }
}

private fun Context.shareStream(url: String, title: String) {
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, title)
        putExtra(Intent.EXTRA_TEXT, url)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching { startActivity(Intent.createChooser(intent, "Share stream")) }
}

private fun Context.enterVideoPip() {
    val activity = findActivity() ?: return
    runCatching {
        activity.enterPictureInPictureMode(
            PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build(),
        )
    }
}

private fun Context.findActivity(): Activity? {
    var current: Context = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}

private fun Context.isOnline(): Boolean {
    val manager = getSystemService(ConnectivityManager::class.java) ?: return false
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
}
