package com.twkim.videiomusic.playback

import org.junit.Assert.*
import org.junit.Test

class NativePlaybackPolicyTest {
    private val origin = "http://192.168.1.4:7777"

    @Test fun acceptsServerStreamsAndArtworkWithoutLosingResumeOrCacheParameters() {
        assertEquals("$origin/api/media/song?variant=a#t=52.5",
            NativePlaybackPolicy.mediaUrl(origin, "/api/media/song?variant=a#t=52.5"))
        assertEquals("$origin/api/thumbnails/song?v=abc",
            NativePlaybackPolicy.mediaUrl(origin, "/api/thumbnails/song?v=abc", artwork = true))
        assertEquals("https://music.example", NativePlaybackPolicy.serverOrigin("https://Music.example:443"))
    }

    @Test fun rejectsForeignUrlsSchemesCredentialsAndTraversal() {
        for (url in listOf("https://evil.example/api/media/song", "//evil.example/api/media/song",
            "file:///api/media/song", "content://media/api/media/song", "javascript:alert(1)",
            "http://user@192.168.1.4:7777/api/media/song", "$origin/api/library",
            "$origin/api/media/%2e%2e/secret", "$origin/api/media/%5csecret",
            "$origin/api/media/../secret", "$origin/api/thumbnails/song")) {
            assertTrue(url, runCatching { NativePlaybackPolicy.mediaUrl(origin, url) }.isFailure)
        }
    }

    @Test fun selectedDuplicateUsesItsQueueIdentityAndSurvivesReordering() {
        val first = NativePlaybackPolicy.Entry("song", "row-1")
        val second = NativePlaybackPolicy.Entry("song", "row-2")
        val source = NativePlaybackPolicy.Entry("song", null)
        assertEquals(second, NativePlaybackPolicy.loadIdentity(source, listOf(first, second), 1))
        assertEquals(0, NativePlaybackPolicy.retainedIndex(second, listOf(second, first)))
        assertEquals(-1, NativePlaybackPolicy.retainedIndex(second, listOf(first)))
        assertEquals(-1, NativePlaybackPolicy.retainedIndex(second, listOf(second.copy(mediaId = "other"))))
    }

    @Test fun refusesMismatchedOrMissingSelectedRows() {
        val source = NativePlaybackPolicy.Entry("song", "row")
        assertTrue(runCatching { NativePlaybackPolicy.loadIdentity(source, emptyList(), 0) }.isFailure)
        assertTrue(runCatching { NativePlaybackPolicy.loadIdentity(source, listOf(source.copy(mediaId = "other")), 0) }.isFailure)
        assertTrue(runCatching { NativePlaybackPolicy.loadIdentity(source, listOf(source), -1) }.isFailure)
    }
}
