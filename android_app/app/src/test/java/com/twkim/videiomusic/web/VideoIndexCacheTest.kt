package com.twkim.videiomusic.web

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.io.ByteArrayInputStream

class VideoIndexCacheTest {
    @Test fun warmHitsAvoidFullReadButRestartAndDiskChangesRevalidate() {
        val dir = Files.createTempDirectory("video-index").toFile()
        try {
            var hashes = 0
            val hash: (java.io.File) -> String = { hashes++; VideoIndexCache.digest(it.readBytes()) }
            var cache = VideoIndexCache(dir, hash)
            fun read() = cache.open("o", "id", "r", 3) { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }.use { it.readBytes() }
            read(); assertEquals(1, hashes)
            read(); assertEquals(1, hashes)
            assertTrue(cache.touchIfBeyond("o", "id", 3))
            read(); assertEquals(1, hashes)
            cache = VideoIndexCache(dir, hash)
            read(); assertEquals(2, hashes)
            val data = dir.listFiles()!!.first { it.extension == "bin" }
            data.writeBytes(byteArrayOf(9, 9, 9))
            assertArrayEquals(byteArrayOf(1, 2, 3), read())
            assertEquals(4, hashes)
            dir.listFiles()!!.first { it.extension == "sha" }.writeText("bad")
            assertArrayEquals(byteArrayOf(1, 2, 3), read())
            assertEquals(6, hashes)
        } finally { dir.deleteRecursively() }
    }
    @Test fun promotesHitsAndEvictsSixthAcrossRestart() {
        val dir = Files.createTempDirectory("video-index").toFile()
        try {
            var cache = VideoIndexCache(dir)
            var downloads = 0
            fun read(id: String) = cache.open("https://server", id, "r1", 3) { downloads++; ByteArrayInputStream(byteArrayOf(1, 2, 3)) }.use { it.readBytes() }
            (1..5).forEach { read("$it") }
            cache = VideoIndexCache(dir)
            read("1"); read("6"); read("1")
            assertEquals(6, downloads)
            read("2"); assertEquals(7, downloads)
            assertEquals(5, dir.listFiles()!!.count { it.extension == "bin" })
        } finally { dir.deleteRecursively() }
    }
    @Test fun rejectsIncompleteAndRepairsCorruptAndStale() {
        val dir = Files.createTempDirectory("video-index").toFile()
        try {
            val cache = VideoIndexCache(dir)
            assertThrows(IllegalStateException::class.java) { cache.open("o", "id", "a", 3) { ByteArrayInputStream(byteArrayOf(1)) } }
            assertTrue(dir.listFiles()!!.none { it.extension == "bin" || it.extension == "tmp" })
            var downloads = 0
            fun read(revision: String) = cache.open("o", "id", revision, 3) { downloads++; ByteArrayInputStream(byteArrayOf(1, 2, 3)) }.use { it.readBytes() }
            read("a")
            dir.listFiles()!!.first { it.extension == "bin" }.writeBytes(byteArrayOf(9, 9, 9))
            assertArrayEquals(byteArrayOf(1, 2, 3), read("a"))
            read("b")
            assertEquals(3, downloads)
            assertEquals(1, dir.listFiles()!!.count { it.extension == "bin" })
        } finally { dir.deleteRecursively() }
    }
    @Test fun concurrentRequestsPublishOneCompleteEntryAndCloseLeavesNoPartialData() {
        val dir = Files.createTempDirectory("video-index").toFile()
        val pool = java.util.concurrent.Executors.newFixedThreadPool(4)
        try {
            java.io.File(dir, "abandoned.tmp").writeText("partial")
            val cache = VideoIndexCache(dir)
            assertFalse(java.io.File(dir, "abandoned.tmp").exists())
            val downloads = java.util.concurrent.atomic.AtomicInteger()
            val start = java.util.concurrent.CountDownLatch(1)
            val jobs = (1..4).map {
                pool.submit<ByteArray> {
                    start.await()
                    cache.open("o", "id", "r", 3) {
                        downloads.incrementAndGet()
                        ByteArrayInputStream(byteArrayOf(1, 2, 3))
                    }.use { it.readBytes() }
                }
            }
            start.countDown()
            jobs.forEach { assertArrayEquals(byteArrayOf(1, 2, 3), it.get(5, java.util.concurrent.TimeUnit.SECONDS)) }
            assertEquals(1, downloads.get())
        } finally { pool.shutdownNow(); dir.deleteRecursively() }
    }
    @Test fun queryPrefixTailValidationAndSeekPassthrough() {
        val dir = Files.createTempDirectory("video-index").toFile()
        val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        var manifests = 0; var downloads = 0; var wrongRevision = false
        server.createContext("/api/media/123") { exchange ->
            assertNull(exchange.requestURI.rawFragment)
            val query = exchange.requestURI.rawQuery
            assertTrue(query.startsWith("v=2&"))
            val bytes = when {
                query.contains("index=manifest") -> { manifests++; byteArrayOf(1) }
                query.contains("index=data") -> { downloads++; byteArrayOf(0, 1, 2, 3) }
                else -> {
                    assertEquals("bytes=4-7", exchange.requestHeaders.getFirst("Range"))
                    exchange.responseHeaders.add("Content-Range", "bytes 4-7/8")
                    exchange.responseHeaders.add("X-Muzio-Revision", if (wrongRevision) "stale" else "r")
                    byteArrayOf(4, 5, 6, 7)
                }
            }
            exchange.sendResponseHeaders(if (query.contains("index_revision")) 206 else 200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val origin = "http://127.0.0.1:${server.address.port}"
            val url = "$origin/api/media/123?v=2"
            val interceptor = VideoIndexInterceptor(VideoIndexCache(dir)) {
                VideoIndexInterceptor.Manifest(true, "r", 8, 4, "video/mp4", "Mon, 07 Sep 2026 00:00:00 GMT")
            }
            val full = interceptor.intercept(url, origin, emptyMap())!!
            assertEquals(200, full.status)
            full.stream.use { assertArrayEquals(byteArrayOf(0, 1, 2, 3, 4, 5, 6, 7), it.readBytes()) }
            val prefix = interceptor.intercept(url, origin, mapOf("Range" to "bytes=1-2", "If-Range" to "Mon, 07 Sep 2026 00:00:00 GMT"))!!
            assertEquals("bytes 1-2/8", prefix.headers["Content-Range"])
            prefix.stream.use { assertArrayEquals(byteArrayOf(1, 2), it.readBytes()) }
            assertEquals(1, downloads)
            val resumed = interceptor.intercept("$url#t=29754.1", origin, mapOf("Range" to "bytes=0-7"))!!
            resumed.stream.use { assertArrayEquals(byteArrayOf(0, 1, 2, 3, 4, 5, 6, 7), it.readBytes()) }
            assertEquals(1, downloads)
            assertNull(interceptor.intercept("$url#t=29754.1", "https://other", emptyMap()))
            assertNull(interceptor.intercept(url, origin, mapOf("Range" to "bytes=4-")))
            assertEquals(3, manifests)
            assertNull(interceptor.intercept(url, origin, mapOf("Range" to "bytes=0-1")))
            assertNull(interceptor.intercept("$url&index=manifest", origin, emptyMap()))
            assertNull(interceptor.intercept(url, "https://other", emptyMap()))
            assertEquals(3, manifests)
            wrongRevision = true
            assertNull(interceptor.intercept(url, origin, mapOf("Range" to "bytes=0-7")))
            assertNull(interceptor.intercept(url, origin, mapOf("Range" to "bytes=0-2", "If-Range" to "W/\"r\"")))
        } finally { server.stop(0); dir.deleteRecursively() }
    }
    @Test fun rangesAndBoundedStreams() {
        assertEquals(VideoByteRange(0, 99), VideoByteRange.parse(null, 100))
        assertEquals(VideoByteRange(0, 1), VideoByteRange.parse("bytes=0-1", 100))
        assertEquals(VideoByteRange(20, 99), VideoByteRange.parse("bytes=20-", 100))
        assertEquals(VideoByteRange(90, 99), VideoByteRange.parse("bytes=-10", 100))
        assertEquals(VideoByteRange(5, 99), VideoByteRange.parse("bytes=5-200", 100))
        listOf("bytes=100-", "bytes=9-2", "bytes=-0", "bytes=0-1,4-5", "bytes=", "bytes=999999999999999999999-").forEach { assertNull(VideoByteRange.parse(it, 100)) }
        LimitedInputStream(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), 2).use { assertArrayEquals(byteArrayOf(1, 2), it.readBytes()) }
    }
}
