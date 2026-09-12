package com.twkim.videiomusic.playback

/** A retired WebView must not clear the replacement page's notification session. */
internal class VideoSessionOwner {
    private var current: Any? = null
    fun owns(owner: Any) = current === owner
    fun claim(owner: Any) { current = owner }
    fun release(owner: Any?): Boolean {
        if (owner != null && current !== owner) return false
        current = null
        return true
    }
}
