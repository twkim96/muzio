package com.twkim.videiomusic.data

/** Reuses an immutable derived value until its source revision changes. */
internal class RevisionedCache<T : Any> {
    private var revision: Long = Long.MIN_VALUE
    private var value: T? = null

    fun get(currentRevision: Long, loader: () -> T): T {
        value?.takeIf { revision == currentRevision }?.let { return it }
        val loaded = loader()
        value = loaded
        revision = currentRevision
        return loaded
    }
}
