package com.twkim.videiomusic.data

import android.content.Context
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class LibrarySnapshotStore(context: Context) {
    private val directory = File(context.filesDir, "library_snapshots")

    suspend fun read(baseUrl: String, type: MediaType): LibrarySnapshot? = withContext(Dispatchers.IO) {
        runCatching {
            val root = JSONObject(file(baseUrl, type).readText())
            if (root.optInt("version") != VERSION) return@runCatching null
            val items = root.optJSONArray("items") ?: return@runCatching null
            LibrarySnapshot(
                revision = root.optLong("revision"),
                items = buildList {
                    for (index in 0 until items.length()) {
                        parseStoredItem(items.optJSONObject(index), type)?.let(::add)
                    }
                },
                fromCache = true,
            )
        }.getOrNull()
    }

    suspend fun write(baseUrl: String, type: MediaType, snapshot: LibrarySnapshot) = withContext(Dispatchers.IO) {
        directory.mkdirs()
        val root = JSONObject()
            .put("version", VERSION)
            .put("revision", snapshot.revision)
            .put("items", JSONArray().apply { snapshot.items.forEach { put(it.toStoredJson()) } })
        val target = file(baseUrl, type)
        val temporary = File(directory, "${target.name}.tmp")
        temporary.writeText(root.toString())
        if (!temporary.renameTo(target)) {
            target.writeText(root.toString())
            temporary.delete()
        }
    }

    private fun file(baseUrl: String, type: MediaType): File {
        val serverKey = baseUrl.trim().lowercase().hashCode().toUInt().toString(16)
        return File(directory, "${serverKey}_${type.apiValue}.json")
    }

    companion object { private const val VERSION = 1 }
}

private fun LibraryItem.toStoredJson() = JSONObject()
    .put("id", id).put("type", type.apiValue).put("rootName", rootName)
    .put("relativePath", relativePath).put("name", name).put("mimeType", mimeType ?: "")
    .put("sizeBytes", sizeBytes).put("modifiedAt", modifiedAt)
    .put("metadata", JSONObject().put("title", metadata.title)
        .put("artist", metadata.artist ?: "").put("album", metadata.album ?: "")
        .put("durationSec", metadata.durationSec ?: 0.0)
        .put("season", metadata.season ?: 0).put("episode", metadata.episode ?: 0)
        .put("year", metadata.year ?: 0))
    .put("thumbnail", thumbnail?.let { JSONObject().put("url", it.url).put("status", it.status) })
    .put("subtitles", JSONArray().apply {
        subtitles.forEach { subtitle ->
            put(JSONObject().put("relativePath", subtitle.relativePath)
                .put("language", subtitle.language ?: "").put("label", subtitle.label))
        }
    })

private fun parseStoredItem(raw: JSONObject?, expectedType: MediaType): LibraryItem? {
    raw ?: return null
    if (raw.optString("type") != expectedType.apiValue) return null
    val metadata = raw.optJSONObject("metadata") ?: JSONObject()
    val thumbnail = raw.optJSONObject("thumbnail")
    return LibraryItem(
        id = raw.optString("id").takeIf(String::isNotBlank) ?: return null,
        type = expectedType,
        rootName = raw.optString("rootName"), relativePath = raw.optString("relativePath"),
        name = raw.optString("name"), mimeType = raw.optString("mimeType").takeIf(String::isNotBlank),
        sizeBytes = raw.optLong("sizeBytes"), modifiedAt = raw.optString("modifiedAt"),
        metadata = LibraryMetadata(
            title = metadata.optString("title"),
            artist = metadata.optString("artist").takeIf(String::isNotBlank),
            album = metadata.optString("album").takeIf(String::isNotBlank),
            durationSec = metadata.optDouble("durationSec").takeIf { !it.isNaN() && it > 0 },
            season = metadata.optInt("season").takeIf { it > 0 },
            episode = metadata.optInt("episode").takeIf { it > 0 },
            year = metadata.optInt("year").takeIf { it > 0 },
        ),
        thumbnail = thumbnail?.let { LibraryThumbnail(it.optString("url"), it.optString("status")) },
        subtitles = buildList {
            val subtitles = raw.optJSONArray("subtitles") ?: JSONArray()
            for (index in 0 until subtitles.length()) {
                val subtitle = subtitles.optJSONObject(index) ?: continue
                val path = subtitle.optString("relativePath")
                if (path.isBlank()) continue
                add(LibrarySubtitle(path, subtitle.optString("language").takeIf(String::isNotBlank),
                    subtitle.optString("label", "Subtitle")))
            }
        },
    )
}
