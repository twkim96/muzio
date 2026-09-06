package com.twkim.videiomusic.data

/** A refresh gives each enumerated item a fresh revision, even when its file stats match. */
internal object LocalEnrichmentPolicy {
    fun canCommit(
        sourceId: String, sourceRoot: String, sourceRevision: String,
        currentId: String?, currentRoot: String?, currentRevision: String?, authorized: Boolean,
    ): Boolean = authorized && sourceRevision.isNotEmpty() && sourceId == currentId &&
        sourceRoot == currentRoot && sourceRevision == currentRevision
}
