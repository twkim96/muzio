package com.twkim.videiomusic.data

import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class MuzioApi {
    suspend fun fetchLibrary(baseUrl: String, type: MediaType): LibrarySnapshot = withContext(Dispatchers.IO) {
        val response = getJson("${normalizeBaseUrl(baseUrl)}/api/library?type=${type.apiValue}")
        val itemsJson = response.getJSONArray("items")
        val items = buildList {
            for (index in 0 until itemsJson.length()) {
                val raw = itemsJson.optJSONObject(index) ?: continue
                parseLibraryItem(raw)?.let(::add)
            }
        }
        LibrarySnapshot(response.optLong("revision"), items)
    }

    suspend fun fetchLibraryChanges(baseUrl: String, type: MediaType, since: Long): LibraryChanges =
        withContext(Dispatchers.IO) {
            val response = getJson(
                "${normalizeBaseUrl(baseUrl)}/api/library/changes?since=$since&type=${type.apiValue}",
            )
            val upserts = response.optJSONArray("upserts") ?: JSONArray()
            LibraryChanges(
                revision = response.optLong("revision"),
                upserts = buildList {
                    for (index in 0 until upserts.length()) {
                        parseLibraryItem(upserts.optJSONObject(index))?.let(::add)
                    }
                },
                deletedIds = response.optJSONArray("deletedIds").stringList(),
                resetRequired = response.optBoolean("resetRequired"),
            )
        }

    suspend fun collectLibraryEvents(
        baseUrl: String,
        lastEventId: Long,
        onEvent: suspend (LibraryRevisionEvent) -> Unit,
    ) = withContext(Dispatchers.IO) {
        val connection = URI("${normalizeBaseUrl(baseUrl)}/api/library/events").toURL()
            .openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 5_000
        connection.readTimeout = 75_000
        connection.setRequestProperty("Accept", "text/event-stream")
        if (lastEventId > 0) connection.setRequestProperty("Last-Event-ID", lastEventId.toString())
        try {
            check(connection.responseCode == HttpURLConnection.HTTP_OK) {
                "SSE HTTP ${connection.responseCode}"
            }
            connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { reader ->
                var eventName = ""
                val data = StringBuilder()
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val line = reader.readLine() ?: break
                    when {
                        line.startsWith("event:") -> eventName = line.substringAfter(':').trim()
                        line.startsWith("data:") -> data.append(line.substringAfter(':').trim())
                        line.isBlank() -> {
                            if (eventName == "library" && data.isNotEmpty()) {
                                parseLibraryEvent(JSONObject(data.toString()))?.let { onEvent(it) }
                            }
                            eventName = ""
                            data.clear()
                        }
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun health(baseUrl: String): String = withContext(Dispatchers.IO) {
        val response = getJson("${normalizeBaseUrl(baseUrl)}/healthz")
        check(response.optString("status") == "ok") { "Unexpected health response" }
        response.optString("service", "unknown")
    }

    suspend fun fetchProgress(baseUrl: String): List<ProgressRecord> = withContext(Dispatchers.IO) {
        val response = getJson("${normalizeBaseUrl(baseUrl)}/api/progress")
        parseProgressRecords(response.optJSONArray("records") ?: JSONArray())
    }

    suspend fun putProgress(
        baseUrl: String,
        mediaId: String,
        positionSec: Double,
        durationSec: Double,
        completed: Boolean,
        source: ProgressSource?,
    ): ProgressRecord = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("mediaId", mediaId)
            .put("positionSec", positionSec.coerceAtLeast(0.0))
            .put("durationSec", durationSec.coerceAtLeast(0.0))
            .put("lastPlayedAt", Instant.now().toString())
            .put("completed", completed)
        if (source != null) {
            body.put(
                "source",
                JSONObject()
                    .put("mediaType", source.mediaType.apiValue)
                    .put("name", source.name)
                    .put("rootName", source.rootName)
                    .put("relativePath", source.relativePath),
            )
        }
        parseProgressRecord(
            requestJson(
                url = "${normalizeBaseUrl(baseUrl)}/api/progress/${encodePathSegment(mediaId)}",
                method = "PUT",
                body = body,
            ),
        ) ?: error("Invalid progress response")
    }

    suspend fun fetchMediaRoots(baseUrl: String): MediaRootsSettings = withContext(Dispatchers.IO) {
        parseMediaRoots(requestJson("${normalizeBaseUrl(baseUrl)}/api/settings/media-roots", "GET"))
    }

    suspend fun updateMediaRoots(
        baseUrl: String,
        audioRoots: List<String>,
        videoRoots: List<String>,
        imageRoots: List<String>,
    ): MediaRootsSettings = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("audioRoots", JSONArray(audioRoots))
            .put("videoRoots", JSONArray(videoRoots))
            .put("imageRoots", JSONArray(imageRoots))
        parseMediaRoots(
            requestJson("${normalizeBaseUrl(baseUrl)}/api/settings/media-roots", "PUT", body),
        )
    }

    suspend fun refreshMediaRoots(baseUrl: String): MediaRootsSettings = withContext(Dispatchers.IO) {
        parseMediaRoots(requestJson("${normalizeBaseUrl(baseUrl)}/api/settings/media-roots", "POST"))
    }

    suspend fun fetchAppearance(baseUrl: String): AppearanceSettings = withContext(Dispatchers.IO) {
        parseAppearance(requestJson("${normalizeBaseUrl(baseUrl)}/api/settings/appearance", "GET"))
    }

    suspend fun updateAppearance(
        baseUrl: String,
        settings: AppearanceSettings,
    ): AppearanceSettings = withContext(Dispatchers.IO) {
        val body = JSONObject().put(
            "settings",
            JSONObject()
                .put("surfaceColor", settings.surfaceColor)
                .put("foregroundColor", settings.foregroundColor)
                .put("mutedColor", settings.mutedColor)
                .put("accentColor", settings.accentColor),
        )
        parseAppearance(
            requestJson("${normalizeBaseUrl(baseUrl)}/api/settings/appearance", "PUT", body),
        )
    }

    suspend fun resetAppearance(baseUrl: String): AppearanceSettings = withContext(Dispatchers.IO) {
        parseAppearance(requestJson("${normalizeBaseUrl(baseUrl)}/api/settings/appearance", "DELETE"))
    }

    suspend fun fetchFallbackPlan(baseUrl: String, mediaId: String): FallbackPlan = withContext(Dispatchers.IO) {
        val response = requestJson(
            "${normalizeBaseUrl(baseUrl)}/api/fallback/${encodePathSegment(mediaId)}?browserSupport=no",
            "GET",
        )
        val ffmpeg = response.optJSONObject("ffmpeg")
        FallbackPlan(
            mediaId = response.optString("mediaId"),
            mimeType = response.optString("mimeType"),
            action = response.optString("action"),
            status = response.optString("status"),
            reason = response.optString("reason"),
            directUrl = response.optString("directUrl"),
            ffmpegAvailable = ffmpeg?.optBoolean("available") == true,
        )
    }

    fun mediaUrl(baseUrl: String, id: String): String {
        return "${normalizeBaseUrl(baseUrl)}/api/media/${encodePathSegment(id)}"
    }

    fun thumbnailUrl(baseUrl: String, item: LibraryItem): String? {
        val raw = item.thumbnail?.url?.takeIf { it.isNotBlank() } ?: return null
        return URI(normalizeBaseUrl(baseUrl) + "/").resolve(raw.removePrefix("/")).toString()
    }

    private fun getJson(url: String): JSONObject {
        return requestJson(url = url, method = "GET")
    }

    private fun requestJson(url: String, method: String, body: JSONObject? = null): JSONObject {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 4_000
        connection.readTimeout = 8_000
        connection.setRequestProperty("Accept", "application/json")
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.bufferedWriter(StandardCharsets.UTF_8).use {
                it.write(body.toString())
            }
        }
        try {
            val status = connection.responseCode
            check(status == HttpURLConnection.HTTP_OK) { "HTTP $status" }
            val text = BufferedInputStream(connection.inputStream)
                .bufferedReader(StandardCharsets.UTF_8)
                .use { it.readText() }
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun parseProgressRecords(records: JSONArray): List<ProgressRecord> = buildList {
        for (index in 0 until records.length()) {
            parseProgressRecord(records.optJSONObject(index))?.let(::add)
        }
    }

    private fun parseLibraryItem(raw: JSONObject?): LibraryItem? {
        raw ?: return null
        val type = MediaType.entries.firstOrNull { it.apiValue == raw.optString("type") } ?: return null
        val name = raw.optString("name")
        val metadata = raw.optJSONObject("metadata")
        val thumbnail = raw.optJSONObject("thumbnail")
        return LibraryItem(
            id = raw.optString("id").takeIf(String::isNotBlank) ?: return null,
            type = type, rootName = raw.optString("rootName"), relativePath = raw.optString("relativePath"),
            name = name, mimeType = raw.optString("mimeType").takeIf(String::isNotBlank),
            sizeBytes = raw.optLong("sizeBytes"), modifiedAt = raw.optString("modifiedAt"),
            metadata = LibraryMetadata(
                title = metadata?.optString("title")?.takeIf(String::isNotBlank)
                    ?: name.substringBeforeLast('.', name),
                artist = metadata?.optString("artist")?.takeIf(String::isNotBlank),
                album = metadata?.optString("album")?.takeIf(String::isNotBlank),
                durationSec = metadata?.optDouble("durationSec")?.takeIf { !it.isNaN() && it > 0.0 },
                season = metadata?.optInt("season")?.takeIf { it > 0 },
                episode = metadata?.optInt("episode")?.takeIf { it > 0 },
                year = metadata?.optInt("year")?.takeIf { it > 0 },
            ),
            thumbnail = thumbnail?.let { LibraryThumbnail(it.optString("url"), it.optString("status")) },
            subtitles = raw.optJSONArray("subtitles").objectList { subtitle ->
                LibrarySubtitle(
                    relativePath = subtitle.optString("relativePath"),
                    language = subtitle.optString("language").takeIf(String::isNotBlank),
                    label = subtitle.optString("label", "Subtitle"),
                )
            }.filter { it.relativePath.isNotBlank() },
        )
    }

    private fun parseLibraryEvent(raw: JSONObject): LibraryRevisionEvent? {
        val revision = raw.optLong("revision", -1)
        if (revision < 0) return null
        return LibraryRevisionEvent(
            revision = revision,
            affectedTypes = raw.optJSONArray("affectedTypes").stringList().mapNotNull { value ->
                MediaType.entries.firstOrNull { it.apiValue == value }
            },
            reason = raw.optString("reason"),
        )
    }

    private fun parseProgressRecord(raw: JSONObject?): ProgressRecord? {
        raw ?: return null
        val mediaId = raw.optString("mediaId").takeIf { it.isNotBlank() } ?: return null
        val sourceJson = raw.optJSONObject("source")
        val source = sourceJson?.let {
            val type = MediaType.entries.firstOrNull { candidate ->
                candidate.apiValue == it.optString("mediaType")
            } ?: return@let null
            val name = it.optString("name")
            val rootName = it.optString("rootName")
            val relativePath = it.optString("relativePath")
            if (name.isBlank() || rootName.isBlank() || relativePath.isBlank()) null else {
                ProgressSource(type, name, rootName, relativePath)
            }
        }
        return ProgressRecord(
            mediaId = mediaId,
            positionSec = raw.optDouble("positionSec").takeIf { !it.isNaN() } ?: 0.0,
            durationSec = raw.optDouble("durationSec").takeIf { !it.isNaN() } ?: 0.0,
            lastPlayedAt = raw.optString("lastPlayedAt"),
            completed = raw.optBoolean("completed"),
            source = source,
        )
    }

    private fun parseMediaRoots(raw: JSONObject): MediaRootsSettings {
        val index = raw.optJSONObject("index")
        val watcher = raw.optJSONObject("watcher")
        return MediaRootsSettings(
            audioRoots = raw.optJSONArray("audioRoots").stringList(),
            videoRoots = raw.optJSONArray("videoRoots").stringList(),
            imageRoots = raw.optJSONArray("imageRoots").stringList(),
            itemCount = raw.optInt("itemCount").takeIf { raw.has("itemCount") },
            persistent = raw.optBoolean("persistent"),
            degradedRoots = raw.optJSONArray("degradedRoots").objectList { item ->
                DegradedRoot(
                    name = item.optString("name"),
                    path = item.optString("path"),
                    error = item.optString("error"),
                )
            },
            index = IndexStatus(
                enabled = index?.optBoolean("enabled") == true,
                loadedItems = index?.optInt("loadedItems") ?: 0,
                lastVerifiedAt = index?.optString("lastVerifiedAt")?.takeIf { it.isNotBlank() },
                lastError = index?.optString("lastError")?.takeIf { it.isNotBlank() },
            ),
            watcher = WatcherStatus(
                enabled = watcher?.optBoolean("enabled") == true,
                backend = watcher?.optString("backend")?.takeIf { it.isNotBlank() },
                lastError = watcher?.optString("lastError")?.takeIf { it.isNotBlank() },
                roots = watcher?.optJSONArray("roots").objectList { item ->
                    WatcherRootStatus(
                        path = item.optString("path"),
                        enabled = item.optBoolean("enabled"),
                        backend = item.optString("backend").takeIf { it.isNotBlank() },
                        reason = item.optString("reason").takeIf { it.isNotBlank() },
                    )
                },
            ),
        )
    }

    private fun parseAppearance(raw: JSONObject): AppearanceSettings {
        val settings = raw.optJSONObject("settings") ?: error("Invalid appearance response")
        return AppearanceSettings(
            surfaceColor = settings.getString("surfaceColor"),
            foregroundColor = settings.getString("foregroundColor"),
            mutedColor = settings.getString("mutedColor"),
            accentColor = settings.getString("accentColor"),
            persisted = raw.optBoolean("persisted"),
        )
    }

    private fun encodePathSegment(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")
    }
}

private fun JSONArray?.stringList(): List<String> {
    this ?: return emptyList()
    return buildList {
        for (index in 0 until length()) {
            optString(index).takeIf { it.isNotBlank() }?.let(::add)
        }
    }
}

private fun <T> JSONArray?.objectList(transform: (JSONObject) -> T): List<T> {
    this ?: return emptyList()
    return buildList {
        for (index in 0 until length()) {
            optJSONObject(index)?.let { add(transform(it)) }
        }
    }
}

fun normalizeBaseUrl(value: String): String = value.trim().trimEnd('/')
