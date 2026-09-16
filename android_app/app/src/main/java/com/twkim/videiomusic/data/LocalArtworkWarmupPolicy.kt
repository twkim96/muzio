package com.twkim.videiomusic.data

internal data class LocalArtworkWarmupCandidate(
    val id: String,
    val modifiedMs: Long,
)

internal object LocalArtworkWarmupPolicy {
    const val MAX_ITEMS = 24

    fun select(candidates: Collection<LocalArtworkWarmupCandidate>): List<LocalArtworkWarmupCandidate> =
        candidates.sortedWith(
            compareByDescending<LocalArtworkWarmupCandidate> { it.modifiedMs }
                .thenBy { it.id },
        ).take(MAX_ITEMS)
}
