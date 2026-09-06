package com.twkim.videiomusic.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalEnrichmentPolicyTest {
    @Test fun matchingAuthorizedItemAcceptsExtractedMetadata() {
        assertTrue(LocalEnrichmentPolicy.canCommit("track", "root", "scan1", "track", "root", "scan1", true))
    }

    @Test fun removalOrReaddingSameFileCannotResurrectOldMetadata() {
        assertFalse(LocalEnrichmentPolicy.canCommit("track", "root", "scan1", null, null, null, true))
        assertFalse(LocalEnrichmentPolicy.canCommit("track", "root", "scan1", "track", "root", "scan2", true))
    }

    @Test fun revokedGrantOrChangedIdentityRejectsResult() {
        assertFalse(LocalEnrichmentPolicy.canCommit("track", "root", "scan1", "track", "root", "scan1", false))
        assertFalse(LocalEnrichmentPolicy.canCommit("track", "root", "scan1", "other", "root", "scan1", true))
        assertFalse(LocalEnrichmentPolicy.canCommit("track", "root", "scan1", "track", "other", "scan1", true))
        assertFalse(LocalEnrichmentPolicy.canCommit("track", "root", "", "track", "root", "", true))
    }
}
