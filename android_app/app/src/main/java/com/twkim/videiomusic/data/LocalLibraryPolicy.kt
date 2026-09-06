package com.twkim.videiomusic.data

import java.security.MessageDigest

internal object LocalLibraryPolicy {
    fun id(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun isAudio(mime: String, name: String): Boolean = mime.startsWith("audio/") ||
        (mime in setOf("", "application/octet-stream", "application/ogg") &&
            name.substringAfterLast('.', "").lowercase() in setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "wma", "aiff", "aif"))

    fun requireId(value: String) {
        require(Regex("local:[0-9a-f]{64}").matches(value)) { "Invalid local media id" }
    }
}
