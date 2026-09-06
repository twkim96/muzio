package com.twkim.videiomusic.web

import org.junit.Assert.*
import org.junit.Test

class BundledWebPolicyTest {
    @Test fun routesUseBundledUiButApisRemainOnTheServer() {
        val origin = "http://192.168.1.4:7777"
        assertEquals("index.html", BundledWebPolicy.assetPath("$origin/library/music", origin))
        assertEquals("assets/main.js", BundledWebPolicy.assetPath("$origin/assets/main.js?v=2", origin))
        assertNull(BundledWebPolicy.assetPath("$origin/api/library/events", origin))
        assertNull(BundledWebPolicy.assetPath("$origin/healthz", origin))
    }

    @Test fun foreignOriginsCredentialsAndTraversalCannotReachAssets() {
        val origin = "https://music.example"
        for (url in listOf("https://evil.example/assets/main.js", "https://music.example:444/assets/main.js",
            "https://user@music.example/assets/main.js", "$origin/assets/%2e%2e/index.html", "$origin/assets/%5cindex.html")) {
            assertNull(url, BundledWebPolicy.assetPath(url, origin))
        }
    }

    @Test fun profilesAreOriginsAndNeverFilesOrCredentials() {
        assertEquals("https://music.example", BundledWebPolicy.serverOrigin(" https://Music.example:443/ "))
        for (url in listOf("file:///secret", "javascript:alert(1)", "https://user:pass@music.example", "https://music.example/subpath", "https://music.example?x=1")) {
            assertTrue(url, runCatching { BundledWebPolicy.serverOrigin(url) }.isFailure)
        }
    }
}
