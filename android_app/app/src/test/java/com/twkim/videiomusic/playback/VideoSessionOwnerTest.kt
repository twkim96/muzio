package com.twkim.videiomusic.playback

import org.junit.Assert.*
import org.junit.Test

class VideoSessionOwnerTest {
    @Test fun retiredPageCannotClearNewVideoSession() {
        val session = VideoSessionOwner()
        val oldPage = Any(); val newPage = Any()
        session.claim(oldPage)
        session.claim(newPage)
        assertFalse(session.release(oldPage))
        assertTrue(session.owns(newPage))
        assertTrue(session.release(newPage))
        assertFalse(session.owns(newPage))
    }
    @Test fun musicCanReclaimSessionRegardlessOfVideoPage() {
        val session = VideoSessionOwner(); val page = Any()
        session.claim(page)
        assertTrue(session.release(null))
        assertFalse(session.owns(page))
        assertFalse(session.release(page))
    }
}
