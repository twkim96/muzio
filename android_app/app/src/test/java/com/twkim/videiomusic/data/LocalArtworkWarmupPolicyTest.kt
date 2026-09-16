package com.twkim.videiomusic.data

import org.junit.Assert.assertEquals
import org.junit.Test

class LocalArtworkWarmupPolicyTest {
    @Test fun selectsOnlyTheMostRecentlyModifiedRows() {
        val candidates = (0 until 40).map { index ->
            LocalArtworkWarmupCandidate(id = "local-$index", modifiedMs = index.toLong())
        }

        val selected = LocalArtworkWarmupPolicy.select(candidates)

        assertEquals(LocalArtworkWarmupPolicy.MAX_ITEMS, selected.size)
        assertEquals((39 downTo 16).map { "local-$it" }, selected.map { it.id })
    }
}
