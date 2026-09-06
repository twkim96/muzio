package com.twkim.videiomusic.playback

import java.net.URI

/** Pure validation shared by transport commands and their JVM regression tests. */
internal object NativePlaybackPolicy {
    data class Entry(val mediaId: String, val queueEntryId: String?)

    fun serverOrigin(value: String): String {
        val uri = URI(value)
        require(uri.scheme?.lowercase() in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null) { "Invalid server origin" }
        val scheme = uri.scheme.lowercase()
        val port = uri.port.takeUnless { it == -1 || it == 80 && scheme == "http" || it == 443 && scheme == "https" }
        return "$scheme://${uri.host.lowercase()}${port?.let { ":$it" }.orEmpty()}"
    }

    fun mediaUrl(origin: String, value: String, artwork: Boolean = false): String {
        val uri = URI(origin + "/").resolve(value)
        require(serverOrigin(uri.toString()) == origin && uri.userInfo == null) { "Media URL must use the configured server" }
        val path = uri.path ?: error("Invalid media path")
        require('\\' !in path && path.split("/").none { it == ".." || it == "." }) { "Invalid media path" }
        require(path.startsWith("/api/media/") || artwork && path.startsWith("/api/thumbnails/")) { "Invalid media endpoint" }
        return uri.toString()
    }

    /** The row owns duplicate identity while the resolved source owns playback metadata. */
    fun loadIdentity(source: Entry, queue: List<Entry>, index: Int): Entry {
        require(index in queue.indices) { "Invalid queue index" }
        val selected = queue[index]
        require(source.mediaId == selected.mediaId) { "Selected source does not match queue entry" }
        return source.copy(queueEntryId = selected.queueEntryId ?: source.queueEntryId)
    }

    fun retainedIndex(current: Entry?, queue: List<Entry>): Int {
        val key = current?.queueEntryId?.takeIf { it.isNotEmpty() } ?: return -1
        return queue.indexOfFirst { it.queueEntryId == key && it.mediaId == current.mediaId }
    }
}
