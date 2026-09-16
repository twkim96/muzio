package com.twkim.videiomusic.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

class RevisionedCacheTest {
    @Test fun reusesValueUntilRevisionChanges() {
        val cache = RevisionedCache<List<Int>>()
        var loads = 0

        val first = cache.get(7) { loads += 1; listOf(1, 2, 3) }
        val same = cache.get(7) { loads += 1; listOf(4, 5, 6) }
        val changed = cache.get(8) { loads += 1; listOf(7, 8, 9) }

        assertSame(first, same)
        assertNotSame(first, changed)
        assertEquals(listOf(7, 8, 9), changed)
        assertEquals(2, loads)
    }

    @Test fun failedReloadDoesNotPoisonTheRevision() {
        val cache = RevisionedCache<String>()
        cache.get(1) { "old" }

        runCatching { cache.get(2) { error("boom") } }
        val recovered = cache.get(2) { "new" }

        assertEquals("new", recovered)
    }
}
