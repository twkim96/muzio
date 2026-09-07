package com.twkim.videiomusic.playback

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Persistent desired-state outbox shared by the service and the WebView bridge. */
class NotificationLikeStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun snapshot(origin: String): JSONObject = synchronized(lock) {
        snapshotOf(read(origin))
    }

    fun isLiked(origin: String, key: String): Boolean = synchronized(lock) {
        likedKeys(read(origin)).contains(key)
    }

    fun toggle(origin: String, key: String) = synchronized(lock) {
        if (origin.isBlank() || key.isBlank()) return@synchronized
        val state = read(origin)
        val keys = likedKeys(state)
        val liked = !keys.contains(key)
        if (liked) keys.add(key) else keys.remove(key)
        val pending = state.optJSONArray("pending") ?: JSONArray()
        pending.put(JSONObject().put("id", UUID.randomUUID().toString()).put("key", key).put("liked", liked))
        state.put("keys", JSONArray(keys.toList())).put("pending", pending)
        write(origin, state)
    }

    fun sync(origin: String, keys: Set<String>, acknowledged: Set<String>): JSONObject = synchronized(lock) {
        val previous = read(origin).optJSONArray("pending") ?: JSONArray()
        val pending = JSONArray()
        val merged = keys.toMutableSet()
        for (index in 0 until previous.length()) {
            val operation = previous.getJSONObject(index)
            if (operation.getString("id") in acknowledged) continue
            pending.put(operation)
            val key = operation.getString("key")
            if (operation.getBoolean("liked")) merged.add(key) else merged.remove(key)
        }
        val state = JSONObject().put("keys", JSONArray(merged.toList())).put("pending", pending)
        write(origin, state)
        snapshotOf(state)
    }

    private fun read(origin: String): JSONObject =
        preferences.getString(origin, null)?.let(::JSONObject) ?: JSONObject()

    private fun likedKeys(state: JSONObject): MutableSet<String> {
        val array = state.optJSONArray("keys") ?: JSONArray()
        return (0 until array.length()).mapTo(mutableSetOf()) { array.getString(it) }
    }

    private fun snapshotOf(state: JSONObject): JSONObject =
        JSONObject().put("pending", state.optJSONArray("pending") ?: JSONArray())

    private fun write(origin: String, state: JSONObject) {
        // Commit before acknowledging a notification action; never lose its outbox on process restart.
        check(preferences.edit().putString(origin, state.toString()).commit()) { "Unable to persist notification likes" }
    }

    companion object {
        const val PREFERENCES_NAME = "muzio.notification.likes"
        // All store instances in this process share one read-modify-write boundary.
        private val lock = Any()
    }
}
