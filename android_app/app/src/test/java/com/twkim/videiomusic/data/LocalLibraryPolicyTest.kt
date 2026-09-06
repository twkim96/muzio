package com.twkim.videiomusic.data

import org.junit.Assert.*
import org.junit.Test

class LocalLibraryPolicyTest {
    @Test fun acceptsAudioButRejectsVideoAndDisguisedNonAudio() {
        assertTrue(LocalLibraryPolicy.isAudio("audio/mpeg", "track.mp3"))
        assertTrue(LocalLibraryPolicy.isAudio("application/octet-stream", "TRACK.FLAC"))
        assertFalse(LocalLibraryPolicy.isAudio("video/mp4", "track.mp3"))
        assertFalse(LocalLibraryPolicy.isAudio("application/pdf", "track.mp3"))
        assertFalse(LocalLibraryPolicy.isAudio("application/octet-stream", "movie.mp4"))
    }

    @Test fun stableIdsRemainScopedToAuthorizedFolderAndDocument() {
        val first = LocalLibraryPolicy.id("content://provider/tree/A\ndocument:track")
        assertEquals(first, LocalLibraryPolicy.id("content://provider/tree/A\ndocument:track"))
        assertNotEquals(first, LocalLibraryPolicy.id("content://provider/tree/B\ndocument:track"))
        LocalLibraryPolicy.requireId("local:$first")
    }

    @Test fun arbitraryUrisAndTraversalAreNotRegistryIds() {
        for (id in listOf("content://provider/private", "local:../../secret", "local:abc", "https://server/file")) {
            assertTrue(runCatching { LocalLibraryPolicy.requireId(id) }.isFailure)
        }
    }
}
