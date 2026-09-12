package com.twkim.videiomusic.playback

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class PendingNotificationQueueRequestTest {
    @Test fun blockedLaunchRetainsRequestUntilWebAcknowledgesShowingQueue() {
        val request = PendingNotificationQueueRequest()
        assertFalse(request.read())
        request.request()
        // No Activity starts. A later host/UI can read without losing the action.
        assertTrue(request.read())
        assertTrue(request.read())
        assertTrue(request.read(acknowledged = true))
        assertFalse(request.read())
        request.request()
        assertTrue(request.read())
    }

    @Test fun foregroundObserverGetsRequestAndNewObserverReplaysUnacknowledgedRequest() = runBlocking {
        val request = PendingNotificationQueueRequest()
        val foreground = mutableListOf<Boolean>()
        val first = launch(start = CoroutineStart.UNDISPATCHED) {
            request.pending.collect { foreground.add(it) }
        }
        request.request()
        yield()
        assertEquals(listOf(false, true), foreground)
        first.cancel()
        val resumed = mutableListOf<Boolean>()
        val second = launch(start = CoroutineStart.UNDISPATCHED) {
            request.pending.collect { resumed.add(it) }
        }
        assertEquals(listOf(true), resumed)
        request.read(acknowledged = true)
        yield()
        assertEquals(listOf(true, false), resumed)
        second.cancel()
    }
}
