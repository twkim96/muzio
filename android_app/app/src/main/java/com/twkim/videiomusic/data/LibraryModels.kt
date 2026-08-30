package com.twkim.videiomusic.data

enum class MediaType(val apiValue: String, val label: String) {
    Audio("audio", "Music"),
    Video("video", "Video"),
    Image("image", "Image"),
}

data class LibraryMetadata(
    val title: String,
    val artist: String? = null,
    val album: String? = null,
    val durationSec: Double? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val year: Int? = null,
)

data class LibrarySubtitle(
    val relativePath: String,
    val language: String? = null,
    val label: String = "Subtitle",
)

data class LibraryThumbnail(
    val url: String,
    val status: String,
)

data class LibraryItem(
    val id: String,
    val type: MediaType,
    val rootName: String,
    val relativePath: String,
    val name: String,
    val mimeType: String?,
    val sizeBytes: Long,
    val modifiedAt: String,
    val metadata: LibraryMetadata,
    val thumbnail: LibraryThumbnail?,
    val subtitles: List<LibrarySubtitle> = emptyList(),
)

data class LibrarySnapshot(
    val revision: Long,
    val items: List<LibraryItem>,
    val fromCache: Boolean = false,
)

data class LibraryChanges(
    val revision: Long,
    val upserts: List<LibraryItem>,
    val deletedIds: List<String>,
    val resetRequired: Boolean,
)

data class LibraryRevisionEvent(
    val revision: Long,
    val affectedTypes: List<MediaType>,
    val reason: String,
)

data class ProgressSource(
    val mediaType: MediaType,
    val name: String,
    val rootName: String,
    val relativePath: String,
)

data class ProgressRecord(
    val mediaId: String,
    val positionSec: Double,
    val durationSec: Double,
    val lastPlayedAt: String,
    val completed: Boolean,
    val source: ProgressSource? = null,
)

data class DegradedRoot(
    val name: String,
    val path: String,
    val error: String,
)

data class IndexStatus(
    val enabled: Boolean,
    val loadedItems: Int,
    val lastVerifiedAt: String? = null,
    val lastError: String? = null,
)

data class WatcherRootStatus(
    val path: String,
    val enabled: Boolean,
    val backend: String? = null,
    val reason: String? = null,
)

data class WatcherStatus(
    val enabled: Boolean,
    val backend: String? = null,
    val lastError: String? = null,
    val roots: List<WatcherRootStatus> = emptyList(),
)

data class MediaRootsSettings(
    val audioRoots: List<String>,
    val videoRoots: List<String>,
    val imageRoots: List<String>,
    val itemCount: Int? = null,
    val persistent: Boolean,
    val degradedRoots: List<DegradedRoot> = emptyList(),
    val index: IndexStatus = IndexStatus(false, 0),
    val watcher: WatcherStatus = WatcherStatus(false),
)

data class AppearanceSettings(
    val surfaceColor: String,
    val foregroundColor: String,
    val mutedColor: String,
    val accentColor: String,
    val persisted: Boolean,
)

data class FallbackPlan(
    val mediaId: String,
    val mimeType: String,
    val action: String,
    val status: String,
    val reason: String,
    val directUrl: String,
    val ffmpegAvailable: Boolean,
)

sealed interface LoadState {
    data object Idle : LoadState
    data object Loading : LoadState
    data class Ready(val snapshot: LibrarySnapshot) : LoadState
    data class Error(val message: String) : LoadState
}

fun LibraryItem.displayTitle(): String = metadata.title.ifBlank {
    name.substringBeforeLast('.', name)
}

fun ProgressRecord.resumePositionSec(): Double? {
    if (completed || positionSec <= 0.0 || durationSec < 30.0) return null
    if (positionSec / durationSec >= 0.95) return null
    if (durationSec - positionSec < 10.0) return null
    return positionSec
}
