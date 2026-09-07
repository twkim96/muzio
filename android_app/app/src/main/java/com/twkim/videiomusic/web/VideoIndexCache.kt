package com.twkim.videiomusic.web

import org.json.JSONObject
import android.util.Log
import com.twkim.videiomusic.BuildConfig
import java.io.*
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.nio.file.Files
import java.nio.file.attribute.BasicFileAttributes

/** Complete prefixes only; open descriptors remain valid when an LRU entry is evicted. */
class VideoIndexCache(private val directory: File, private val hashFile: (File) -> String = ::fileDigest) {
    companion object {
        private fun fileDigest(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input -> val buffer = ByteArray(64 * 1024); while (true) { val n = input.read(buffer); if (n < 0) break; md.update(buffer, 0, n) } }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
        const val MAX_ENTRY = 128L * 1024 * 1024
        const val MAX_TOTAL = 640L * 1024 * 1024
        fun digest(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
    }
    private data class Fingerprint(val size: Long, val modified: java.nio.file.attribute.FileTime, val identity: Any?)
    private fun fingerprint(file: File): Fingerprint? = runCatching {
        val attrs = Files.readAttributes(file.toPath(), BasicFileAttributes::class.java)
        if (!attrs.isRegularFile) null else Fingerprint(attrs.size(), attrs.lastModifiedTime(), attrs.fileKey())
    }.getOrNull()
    // Only immutable, already verified files qualify. Restart or any disk change
    // requires the full digest again; metadata storage is bounded by the disk LRU.
    private val verified = mutableMapOf<String, Pair<Fingerprint, Fingerprint>>()
    private fun remember(key: String, data: File, checksum: File) {
        val a = fingerprint(data); val b = fingerprint(checksum)
        if (a != null && b != null) verified[key] = a to b else verified.remove(key)
    }
    private var clock = System.currentTimeMillis()
    init {
        directory.mkdirs()
        directory.listFiles()?.forEach {
            if (it.extension == "tmp") it.delete()
            else clock = maxOf(clock, it.lastModified())
        }
    }

    /** No cached bytes are returned here, so a tail seek needs no revision validation. */
    @Synchronized fun touchIfBeyond(origin: String, id: String, start: Long): Boolean {
        val family = digest("$origin\n$id".toByteArray())
        val entry = directory.listFiles()?.firstOrNull { it.name.startsWith("$family-") && it.extension == "bin" } ?: return false
        if (entry.length() <= 0 || start < entry.length()) return false
        val checksum = File(directory, "${entry.nameWithoutExtension}.sha")
        val before = fingerprint(entry)?.let { a -> fingerprint(checksum)?.let { b -> a to b } }
        clock = maxOf(clock + 1, System.currentTimeMillis())
        entry.setLastModified(clock)
        if (before != null && verified[entry.nameWithoutExtension] == before) remember(entry.nameWithoutExtension, entry, checksum)
        return true
    }

    @Synchronized fun open(origin: String, id: String, revision: String, size: Long, download: () -> InputStream): FileInputStream {
        require(size in 1..MAX_ENTRY)
        val family = digest("$origin\n$id".toByteArray())
        val key = "$family-${digest(revision.toByteArray())}"
        directory.listFiles()?.filter { it.name.startsWith("$family-") && !it.name.startsWith("$key.") }?.forEach { it.delete() }
        val data = File(directory, "$key.bin")
        val checksum = File(directory, "$key.sha")
        val stamp = fingerprint(data)?.let { a -> fingerprint(checksum)?.let { b -> a to b } }
        if (stamp == null || stamp.first.size != size ||
            (verified[key] != stamp && checksum.readText() != hashFile(data))) {
            verified.remove(key)
            data.delete(); checksum.delete()
            // Reserve space before writing, including the in-progress prefix in the budget.
            val existing = directory.listFiles()?.filter { it.extension == "bin" }?.sortedBy { it.lastModified() }.orEmpty().toMutableList()
            var occupied = existing.sumOf { it.length() }
            while (existing.size >= 5 || occupied + size > MAX_TOTAL) {
                val oldest = existing.removeAt(0)
                occupied -= oldest.length()
                check(oldest.delete())
                File(directory, "${oldest.nameWithoutExtension}.sha").delete()
            }
            val temp = File(directory, "$key.tmp")
            try {
                download().use { input -> FileOutputStream(temp).use { output ->
                    val buffer = ByteArray(64 * 1024); var remaining = size
                    while (remaining > 0) { val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt()); check(n > 0) { "Incomplete index" }; output.write(buffer, 0, n); remaining -= n }
                    check(input.read() == -1) { "Oversized index" }; output.fd.sync()
                } }
                val shaTemp = File(directory, "$key.sha.tmp")
                shaTemp.writeText(hashFile(temp))
                check(temp.renameTo(data)); check(shaTemp.renameTo(checksum))
            } finally { temp.delete(); File(directory, "$key.sha.tmp").delete() }
        }
        clock = maxOf(clock + 1, System.currentTimeMillis()); data.setLastModified(clock)
        val entries = directory.listFiles()?.filter { it.extension == "bin" }?.sortedByDescending { it.lastModified() }.orEmpty()
        var total = 0L
        entries.forEachIndexed { index, file -> total += file.length(); if (index >= 5 || total > MAX_TOTAL) { file.delete(); File(directory, "${file.nameWithoutExtension}.sha").delete() } }
        verified.keys.retainAll(entries.filter { it.exists() }.map { it.nameWithoutExtension }.toSet())
        remember(key, data, checksum)
        return FileInputStream(data)
    }
}

data class VideoByteRange(val start: Long, val end: Long) {
    companion object {
        fun parse(header: String?, size: Long): VideoByteRange? {
            if (size <= 0) return null
            if (header == null) return VideoByteRange(0, size - 1)
            val match = Regex("bytes=(\\d*)-(\\d*)").matchEntire(header) ?: return null
            val (a, b) = match.destructured
            if (a.isEmpty()) { val suffix = b.toLongOrNull() ?: return null; return if (suffix > 0) VideoByteRange(maxOf(0, size - suffix), size - 1) else null }
            val start = a.toLongOrNull() ?: return null
            val end = if (b.isEmpty()) size - 1 else b.toLongOrNull() ?: return null
            return if (start < size && end >= start) VideoByteRange(start, minOf(end, size - 1)) else null
        }
    }
}

/** Network policy stays here; Android only adapts the response to WebResourceResponse. */
class VideoIndexInterceptor(
    private val cache: VideoIndexCache,
    private val decodeManifest: (String) -> Manifest = { body ->
        val json = JSONObject(body)
        if (!json.getBoolean("eligible")) Manifest(false) else Manifest(true, json.getString("revision"),
            json.getLong("fileSize"), json.getLong("indexBytes"), json.getString("mimeType"), json.getString("modifiedAt"))
    }
) {
    data class Manifest(val eligible: Boolean, val revision: String = "", val fileSize: Long = 0,
        val indexBytes: Long = 0, val mimeType: String = "", val modifiedAt: String = "")
    data class Response(val mime: String, val status: Int, val headers: Map<String, String>, val stream: InputStream)
    private fun trace(message: String) {
        if (BuildConfig.DEBUG) runCatching { Log.d("MuzioVideoIndex", message) }
    }
    fun intercept(url: String, origin: String, headers: Map<String, String>): Response? {
        val started = System.nanoTime()
        var stage = "policy"
        fun elapsed() = (System.nanoTime() - started) / 1_000_000
        fun bypass(reason: String): Response? { trace("bypass=$reason elapsedMs=${elapsed()}"); return null }
        var owned: InputStream? = null
        try {
            val uri = URI(url)
            if (!Regex("/api/media/[^/]+").matches(uri.rawPath)) return null
            trace("request")
            if (!BundledWebPolicy.sameOrigin(url, origin)) return bypass("origin")
            // WebView retains #t media fragments in intercepted URLs. They are
            // playback position hints, never part of an HTTP request or cache key.
            // Leave the element's URL untouched and normalize only network I/O.
            val networkUrl = url.substringBefore('#')
            val queryNames = uri.rawQuery.orEmpty().split('&').map { java.net.URLDecoder.decode(it.substringBefore('='), "UTF-8") }
            if (queryNames.any { it == "index" || it == "index_revision" }) return bypass("index-query")
            if (headers.keys.any { it.startsWith("If-", true) && !it.equals("If-Range", true) }) return bypass("conditional")
            val ifRange = headers.entries.firstOrNull { it.key.equals("If-Range", true) }?.value
            if (ifRange != null && runCatching {
                java.time.ZonedDateTime.parse(ifRange, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME)
            }.isFailure) return bypass("if-range-format")
            val rangeHeader = headers.entries.firstOrNull { it.key.equals("Range", true) }?.value
            if (rangeHeader == "bytes=0-1" || (rangeHeader != null && !Regex("bytes=\\d*-\\d*").matches(rangeHeader))) return bypass("probe-or-range")
            val explicitStart = rangeHeader?.let { Regex("bytes=(\\d+)-\\d*").matchEntire(it)?.groupValues?.get(1)?.toLongOrNull() }
            if (explicitStart != null && cache.touchIfBeyond(origin, uri.rawPath, explicitStart)) return bypass("cached-tail")
            fun connection(query: String, range: String? = null): HttpURLConnection {
                val c = URL("$networkUrl${if (uri.rawQuery == null) "?" else "&"}$query").openConnection() as HttpURLConnection
                c.instanceFollowRedirects = false; c.useCaches = false; c.connectTimeout = 7000; c.readTimeout = 15000
                headers.filterKeys { it.equals("Cookie", true) || it.equals("Authorization", true) || it.equals("User-Agent", true) }.forEach { (k, v) -> c.setRequestProperty(k, v) }
                c.setRequestProperty("Accept-Encoding", "identity"); c.setRequestProperty("Cache-Control", "no-cache")
                range?.let { c.setRequestProperty("Range", it) }
                return c
            }
            stage = "manifest"
            val manifestConnection = connection("index=manifest")
            val manifest = try {
                val status = manifestConnection.responseCode
                trace("manifest status=$status elapsedMs=${elapsed()}")
                check(status == 200)
                val bytes = manifestConnection.inputStream.use { it.readBytesLimited(16 * 1024) }
                decodeManifest(String(bytes, Charsets.UTF_8))
            } finally { manifestConnection.disconnect() }
            if (!manifest.eligible) return bypass("ineligible")
            // Only the exact HTTP-date validator from this fresh manifest is supported.
            if (ifRange != null && ifRange != manifest.modifiedAt) return bypass("if-range-mismatch")
            val revision = manifest.revision; require(revision.isNotEmpty())
            val size = manifest.fileSize; val prefix = manifest.indexBytes
            require(prefix in 1..VideoIndexCache.MAX_ENTRY && prefix <= size)
            val range = VideoByteRange.parse(rangeHeader, size) ?: return bypass("range")
            if (range.start >= prefix) return bypass("tail")
            val encodedRevision = java.net.URLEncoder.encode(revision, "UTF-8")
            stage = "cache-open"
            var downloaded = false
            val file = cache.open(origin, uri.rawPath, revision, prefix) {
                downloaded = true
                stage = "prefix-download"
                val c = connection("index=data&revision=$encodedRevision")
                try {
                    val status = c.responseCode; val length = c.getHeaderFieldLong("Content-Length", -1)
                    trace("prefix status=$status bytes=$length expected=$prefix elapsedMs=${elapsed()}")
                    check(status == 200 && length == prefix); disconnectedStream(c)
                }
                catch (e: Exception) { c.disconnect(); throw e }
            }
            trace("cache=${if (downloaded) "miss" else "hit"} bytes=$prefix elapsedMs=${elapsed()}")
            owned = file
            file.channel.position(range.start)
            val head = LimitedInputStream(file, minOf(range.end + 1, prefix) - range.start)
            owned = head
            val stream = if (range.end >= prefix) {
                stage = "tail-validation"
                val tail = connection("index_revision=$encodedRevision", "bytes=$prefix-${range.end}")
                val tailStream = try {
                    check(tail.responseCode == 206 && tail.getHeaderField("Content-Range") == "bytes $prefix-${range.end}/$size" && tail.getHeaderField("X-Muzio-Revision") == revision)
                    check(tail.getHeaderFieldLong("Content-Length", -1) == range.end - prefix + 1)
                    LimitedInputStream(disconnectedStream(tail), range.end - prefix + 1)
                } catch (e: Exception) { tail.disconnect(); throw e }
                SequenceInputStream(head, tailStream)
            } else head
            owned = stream
            val responseHeaders = mutableMapOf("Accept-Ranges" to "bytes", "Content-Length" to (range.end - range.start + 1).toString(), "Cache-Control" to "no-store", "X-Muzio-Revision" to revision, "Last-Modified" to manifest.modifiedAt)
            if (rangeHeader != null) responseHeaders["Content-Range"] = "bytes ${range.start}-${range.end}/$size"
            val response = Response(manifest.mimeType, if (rangeHeader == null) 200 else 206, responseHeaders, stream)
            owned = null
            trace("ready elapsedMs=${elapsed()}")
            return response
        } catch (error: Exception) {
            // Exception messages and stack traces can contain credentialed URLs.
            trace("failure stage=$stage type=${error.javaClass.simpleName} elapsedMs=${elapsed()}")
            return null
        } finally { runCatching { owned?.close() } }
    }
    private fun disconnectedStream(c: HttpURLConnection): InputStream = object : FilterInputStream(c.inputStream) {
        override fun close() { try { super.close() } finally { c.disconnect() } }
    }
}

internal class LimitedInputStream(input: InputStream, private var remaining: Long) : FilterInputStream(input) {
    override fun read(): Int { if (remaining == 0L) return -1; val value = super.read(); if (value < 0) throw EOFException(); remaining--; return value }
    override fun read(b: ByteArray, off: Int, len: Int): Int { if (len == 0) return 0; if (remaining == 0L) return -1; val n = `in`.read(b, off, minOf(len.toLong(), remaining).toInt()); if (n < 0) throw EOFException(); remaining -= n; return n }
    override fun skip(n: Long): Long { val skipped = `in`.skip(minOf(maxOf(n, 0), remaining)); remaining -= skipped; return skipped }
    override fun available() = minOf(`in`.available().toLong(), remaining).toInt()
}

private fun InputStream.readBytesLimited(limit: Int): ByteArray {
    val out = ByteArrayOutputStream(); val buffer = ByteArray(4096)
    while (true) { val n = read(buffer); if (n < 0) break; check(out.size() + n <= limit); out.write(buffer, 0, n) }
    return out.toByteArray()
}
