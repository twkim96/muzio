package com.twkim.videiomusic.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.text.Normalizer
import java.time.Instant
import java.time.ZonedDateTime
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

private val Context.libraryPreferencesDataStore by preferencesDataStore(name = "library_preferences")

data class PlaylistRecord(
    val id: String,
    val name: String,
    val createdAt: String,
    val updatedAt: String,
    val contentKeys: List<String>,
)

data class LibraryPreferences(
    val likedContentKeys: Set<String> = emptySet(),
    val playlists: List<PlaylistRecord> = emptyList(),
    val activityRecords: List<PlaybackActivityRecord> = emptyList(),
)

data class PlaybackActivityRecord(
    val contentKey: String,
    val mediaId: String,
    val mediaType: MediaType,
    val name: String,
    val artist: String?,
    val playCount: Int,
    val lastPlayedAt: String,
    val lastPositionSec: Double,
    val durationSec: Double,
    val completed: Boolean,
    val events: List<PlaybackActivityEvent> = emptyList(),
)

data class PlaybackActivityEvent(
    val playedAt: String,
    val weekday: Int,
    val hour: Int,
)

class LibraryPreferencesStore(private val context: Context) {
    private val likedKey = stringPreferencesKey("music.likes.v1")
    private val playlistsKey = stringPreferencesKey("music.playlists.v1")
    private val activityKey = stringPreferencesKey("music.activity.v1")

    val preferences: Flow<LibraryPreferences> = context.libraryPreferencesDataStore.data.map { values ->
        LibraryPreferences(
            likedContentKeys = parseLiked(values[likedKey]),
            playlists = parsePlaylists(values[playlistsKey]),
            activityRecords = parseActivity(values[activityKey]),
        )
    }

    suspend fun toggleLike(contentKey: String) {
        val normalized = contentKey.trim()
        if (normalized.isBlank()) return
        context.libraryPreferencesDataStore.edit { values ->
            val liked = parseLiked(values[likedKey]).toMutableSet()
            if (!liked.add(normalized)) liked.remove(normalized)
            values[likedKey] = JSONArray(liked.toList()).toString()
        }
    }

    suspend fun createPlaylist(name: String): String? {
        val cleanName = name.trim()
        if (cleanName.isBlank()) return null
        val id = "playlist-${UUID.randomUUID()}"
        context.libraryPreferencesDataStore.edit { values ->
            val now = Instant.now().toString()
            val playlists = parsePlaylists(values[playlistsKey]).toMutableList()
            playlists += PlaylistRecord(id, cleanName, now, now, emptyList())
            values[playlistsKey] = playlists.toJson()
        }
        return id
    }

    suspend fun renamePlaylist(id: String, name: String) {
        val cleanName = name.trim()
        if (cleanName.isBlank()) return
        updatePlaylists { playlists ->
            playlists.map { playlist ->
                if (playlist.id == id) playlist.copy(name = cleanName, updatedAt = Instant.now().toString())
                else playlist
            }
        }
    }

    suspend fun deletePlaylist(id: String) {
        updatePlaylists { playlists -> playlists.filterNot { it.id == id } }
    }

    suspend fun addItems(playlistId: String, contentKeys: Collection<String>) {
        val additions = contentKeys.map(String::trim).filter(String::isNotBlank)
        if (additions.isEmpty()) return
        updatePlaylists { playlists ->
            playlists.map { playlist ->
                if (playlist.id != playlistId) playlist else playlist.copy(
                    contentKeys = (playlist.contentKeys + additions).distinct(),
                    updatedAt = Instant.now().toString(),
                )
            }
        }
    }

    suspend fun removeItems(playlistId: String, contentKeys: Collection<String>) {
        val removals = contentKeys.toSet()
        updatePlaylists { playlists ->
            playlists.map { playlist ->
                if (playlist.id != playlistId) playlist else playlist.copy(
                    contentKeys = playlist.contentKeys.filterNot(removals::contains),
                    updatedAt = Instant.now().toString(),
                )
            }
        }
    }

    suspend fun recordPlay(
        contentKey: String,
        mediaId: String,
        mediaType: MediaType,
        name: String,
        artist: String?,
    ) {
        if (contentKey.isBlank()) return
        context.libraryPreferencesDataStore.edit { values ->
            val records = parseActivity(values[activityKey]).toMutableList()
            val index = records.indexOfFirst { it.contentKey == contentKey }
            val previous = records.getOrNull(index)
            val now = ZonedDateTime.now()
            val playedAt = now.toInstant().toString()
            val record = PlaybackActivityRecord(
                contentKey = contentKey,
                mediaId = mediaId,
                mediaType = mediaType,
                name = name,
                artist = artist,
                playCount = (previous?.playCount ?: 0) + 1,
                lastPlayedAt = playedAt,
                lastPositionSec = previous?.lastPositionSec ?: 0.0,
                durationSec = previous?.durationSec ?: 0.0,
                completed = previous?.completed ?: false,
                events = listOf(
                    PlaybackActivityEvent(
                        playedAt = playedAt,
                        weekday = now.dayOfWeek.value % 7,
                        hour = now.hour,
                    ),
                ) + previous?.events.orEmpty().take(199),
            )
            if (index >= 0) records[index] = record else records += record
            values[activityKey] = records.toActivityJson()
        }
    }

    suspend fun updateActivityProgress(
        contentKey: String,
        mediaId: String,
        positionSec: Double,
        durationSec: Double,
        completed: Boolean,
    ) {
        if (contentKey.isBlank()) return
        context.libraryPreferencesDataStore.edit { values ->
            val records = parseActivity(values[activityKey]).toMutableList()
            val index = records.indexOfFirst { it.contentKey == contentKey }
            if (index < 0) return@edit
            val current = records[index]
            records[index] = current.copy(
                mediaId = mediaId,
                lastPositionSec = positionSec.coerceAtLeast(0.0),
                durationSec = durationSec.coerceAtLeast(0.0),
                completed = completed,
            )
            values[activityKey] = records.toActivityJson()
        }
    }

    suspend fun exportActivityJson(): String = preferences.first().activityRecords.toActivityJson()

    suspend fun importActivityJson(raw: String): Int? {
        if (raw.length > MAX_ACTIVITY_DOCUMENT_CHARS) return null
        val root = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        if (root.optInt("version", -1) != 1 || root.optJSONArray("records") == null) return null
        val records = parseActivity(raw)
        context.libraryPreferencesDataStore.edit { values ->
            values[activityKey] = records.toActivityJson()
        }
        return records.size
    }

    private suspend fun updatePlaylists(transform: (List<PlaylistRecord>) -> List<PlaylistRecord>) {
        context.libraryPreferencesDataStore.edit { values ->
            values[playlistsKey] = transform(parsePlaylists(values[playlistsKey])).toJson()
        }
    }
}

fun LibraryItem.contentKey(): String {
    val metadataTitle = metadata.title.trim().takeIf(String::isNotBlank)
    val metadataArtist = metadata.artist?.trim()?.takeIf(String::isNotBlank)
    val base = name.substringBeforeLast('.', name).trim()
    val parsed = if (metadataTitle == null) {
        Regex("^(.+?)\\s[-–—]\\s(.+)$").matchEntire(base)
    } else null
    val title = metadataTitle ?: parsed?.groupValues?.getOrNull(2)?.trim().orEmpty().ifBlank { base.ifBlank { name } }
    val artist = metadataArtist ?: parsed?.groupValues?.getOrNull(1)?.trim()?.takeIf(String::isNotBlank)
    val prefix = type.apiValue
    return if (artist == null) "$prefix:title:${title.identityToken()}"
    else "$prefix:artist:${artist.identityToken()}:title:${title.identityToken()}"
}

private fun String.identityToken(): String = Normalizer.normalize(this, Normalizer.Form.NFKC)
    .lowercase(Locale.ROOT)
    .replace(Regex("[^\\p{L}\\p{N}]+"), " ")
    .trim()
    .replace(Regex("\\s+"), "-")
    .ifBlank { "unknown" }

private fun parseLiked(raw: String?): Set<String> = runCatching {
    val array = JSONArray(raw ?: "[]")
    buildSet {
        for (index in 0 until array.length()) {
            array.optString(index).trim().takeIf(String::isNotBlank)?.let(::add)
        }
    }
}.getOrDefault(emptySet())

private fun parsePlaylists(raw: String?): List<PlaylistRecord> = runCatching {
    val root = JSONObject(raw ?: "{}")
    val array = root.optJSONArray("playlists") ?: JSONArray()
    buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString("id").trim()
            val name = item.optString("name").trim()
            if (id.isBlank() || name.isBlank()) continue
            val keys = item.optJSONArray("items") ?: JSONArray()
            add(
                PlaylistRecord(
                    id = id,
                    name = name,
                    createdAt = item.optString("createdAt"),
                    updatedAt = item.optString("updatedAt"),
                    contentKeys = buildList {
                        for (keyIndex in 0 until keys.length()) {
                            val key = keys.optJSONObject(keyIndex)?.optString("contentKey")
                                ?: keys.optString(keyIndex)
                            key.trim().takeIf(String::isNotBlank)?.let(::add)
                        }
                    }.distinct(),
                ),
            )
        }
    }
}.getOrDefault(emptyList())

private fun List<PlaylistRecord>.toJson(): String = JSONObject()
    .put("version", 1)
    .put(
        "playlists",
        JSONArray().apply {
            forEach { playlist ->
                put(
                    JSONObject()
                        .put("id", playlist.id)
                        .put("name", playlist.name)
                        .put("createdAt", playlist.createdAt)
                        .put("updatedAt", playlist.updatedAt)
                        .put(
                            "items",
                            JSONArray().apply {
                                playlist.contentKeys.forEach { contentKey ->
                                    put(
                                        JSONObject()
                                            .put("contentKey", contentKey)
                                            .put("addedAt", playlist.updatedAt),
                                    )
                                }
                            },
                        ),
                )
            }
        },
    )
    .toString()

private fun parseActivity(raw: String?): List<PlaybackActivityRecord> = runCatching {
    val array = JSONObject(raw ?: "{}").optJSONArray("records") ?: JSONArray()
    buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val type = MediaType.entries.firstOrNull { it.apiValue == item.optString("mediaType") }
                ?: continue
            val contentKey = item.optString("contentKey").trim()
            if (contentKey.isBlank()) continue
            add(
                PlaybackActivityRecord(
                    contentKey = contentKey,
                    mediaId = item.optString("mediaId"),
                    mediaType = type,
                    name = item.optString("name"),
                    artist = item.optString("artist").takeIf(String::isNotBlank),
                    playCount = item.optInt("playCount").coerceAtLeast(0),
                    lastPlayedAt = item.optString("lastPlayedAt"),
                    lastPositionSec = item.optDouble("lastPositionSec").takeIf { !it.isNaN() } ?: 0.0,
                    durationSec = item.optDouble("durationSec").takeIf { !it.isNaN() } ?: 0.0,
                    completed = item.optBoolean("completed"),
                    events = buildList {
                        val events = item.optJSONArray("events") ?: JSONArray()
                        for (eventIndex in 0 until minOf(events.length(), 200)) {
                            val event = events.optJSONObject(eventIndex) ?: continue
                            val playedAt = event.optString("playedAt")
                            val weekday = event.optInt("weekday", -1)
                            val hour = event.optInt("hour", -1)
                            if (playedAt.isNotBlank() && weekday in 0..6 && hour in 0..23) {
                                add(PlaybackActivityEvent(playedAt, weekday, hour))
                            }
                        }
                    },
                ),
            )
        }
    }
}.getOrDefault(emptyList())

private fun List<PlaybackActivityRecord>.toActivityJson(): String = JSONObject()
    .put("version", 1)
    .put(
        "records",
        JSONArray().apply {
            this@toActivityJson.forEach { record ->
                put(
                    JSONObject()
                        .put("contentKey", record.contentKey)
                        .put("mediaId", record.mediaId)
                        .put("mediaType", record.mediaType.apiValue)
                        .put("name", record.name)
                        .put("artist", record.artist ?: "")
                        .put("playCount", record.playCount)
                        .put("lastPlayedAt", record.lastPlayedAt)
                        .put("lastPositionSec", record.lastPositionSec)
                        .put("durationSec", record.durationSec)
                        .put("completed", record.completed)
                        .put(
                            "events",
                            JSONArray().apply {
                                record.events.take(200).forEach { event ->
                                    put(
                                        JSONObject()
                                            .put("playedAt", event.playedAt)
                                            .put("weekday", event.weekday)
                                            .put("hour", event.hour),
                                    )
                                }
                            },
                        ),
                )
            }
        },
    )
    .toString()

private const val MAX_ACTIVITY_DOCUMENT_CHARS = 2_000_000
