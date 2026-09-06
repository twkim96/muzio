package com.twkim.videiomusic.web

import java.net.URI

/** Pure URL policy, shared by navigation, asset loading and the native bridge. */
object BundledWebPolicy {
    const val SETUP_ORIGIN = "https://muzio.invalid"

    fun serverOrigin(raw: String): String {
        val uri = URI(raw.trim())
        require(uri.scheme == "http" || uri.scheme == "https") { "http:// 또는 https:// 서버 주소를 입력하세요." }
        require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null) { "올바른 서버 주소를 입력하세요." }
        require(uri.port == -1 || uri.port in 1..65535) { "서버 포트를 확인하세요." }
        require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") { "폴더 경로 없이 서버 주소와 포트만 입력하세요." }
        require(uri.rawQuery == null && uri.rawFragment == null) { "서버 주소에서 쿼리와 # 뒤 내용을 제거하세요." }
        return origin(uri)
    }

    fun sameOrigin(url: String, expected: String): Boolean = runCatching {
        val uri = URI(url)
        uri.rawUserInfo == null && origin(uri) == expected
    }.getOrDefault(false)

    fun isAppRoute(path: String): Boolean = path == "/" || path == "/index.html" ||
        path == "/player" || path == "/settings" || path == "/settings/backend" ||
        path in setOf("/library/music", "/library/video", "/library/image") ||
        (path.startsWith("/image/") && path.length > 7)

    fun assetPath(url: String, expected: String): String? {
        if (!sameOrigin(url, expected)) return null
        val path = runCatching { URI(url).path }.getOrNull() ?: return null
        if (path.contains('\\') || path.contains('\u0000') || path.split('/').any { it == ".." || it == "." }) return null
        if (isAppRoute(path)) return "index.html"
        if (path.startsWith("/api/") || path == "/healthz") return null
        return path.removePrefix("/").takeIf { it.isNotEmpty() }
    }

    private fun origin(uri: URI): String {
        require(uri.scheme == "http" || uri.scheme == "https")
        require(!uri.host.isNullOrEmpty())
        val port = uri.port.takeUnless { it == -1 || (it == 80 && uri.scheme == "http") || (it == 443 && uri.scheme == "https") }
        return "${uri.scheme}://${uri.host.lowercase()}${port?.let { ":$it" }.orEmpty()}"
    }
}
