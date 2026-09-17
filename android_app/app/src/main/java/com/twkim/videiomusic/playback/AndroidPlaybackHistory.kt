package com.twkim.videiomusic.playback

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** Durable native-audio progress outbox. Web acknowledges only after its own storage succeeds. */
internal class AndroidPlaybackHistory(context: Context) {
    private val file = AtomicFile(File(context.applicationContext.filesDir, "playback_history_v1.json"))

    fun record(
        session: String,
        sourceJson: String,
        positionSec: Double,
        durationSec: Double,
        completed: Boolean,
        startedAtMs: Long,
        updatedAtMs: Long = System.currentTimeMillis(),
    ) = synchronized(lock) {
        if (session.isBlank() || startedAtMs < 0 || updatedAtMs < 0 ||
            !positionSec.isFinite() || positionSec < 0 || !durationSec.isFinite() || durationSec < 0) return@synchronized
        val source = runCatching { JSONObject(sourceJson) }.getOrNull() ?: return@synchronized
        if (source.optString("mediaType") != "audio" || source.optString("mediaId").isBlank() || source.optBoolean("transient")) return@synchronized
        val pending = readPending()
        val next = JSONArray()
        val localMediaId = source.optString("mediaId").takeIf { it.startsWith("local:") }
        for (index in 0 until pending.length()) {
            val entry = pending.optJSONObject(index) ?: continue
            val sameLocalTrack = localMediaId != null &&
                entry.optJSONObject("source")?.optString("mediaId") == localMediaId
            if (entry.optString("session") != session && !sameLocalTrack) next.put(entry)
        }
        next.put(
            JSONObject()
                .put("id", UUID.randomUUID().toString())
                .put("session", session)
                .put("source", JSONObject(source.toString()))
                .put("positionSec", positionSec)
                .put("durationSec", durationSec)
                .put("completed", completed)
                .put("updatedAtMs", updatedAtMs)
                .put("startedAtMs", startedAtMs),
        )
        writePending(next)
    }

    fun snapshot(): JSONObject = synchronized(lock) { snapshotLocked() }

    fun acknowledge(ids: Set<String>): JSONObject = synchronized(lock) {
        if (ids.isNotEmpty()) {
            val pending = readPending()
            val next = JSONArray()
            for (index in 0 until pending.length()) {
                val entry = pending.optJSONObject(index) ?: continue
                val local = entry.optJSONObject("source")?.optString("mediaId")?.startsWith("local:") == true
                if (local || entry.optString("id") !in ids) next.put(entry)
            }
            writePending(next)
        }
        snapshotLocked()
    }

    private fun snapshotLocked(): JSONObject = JSONObject()
        .put("pending", JSONArray(readPending().toString()))
        .put("retainLocal", true)

    private fun readPending(): JSONArray = try {
        file.openRead().bufferedReader().use { JSONArray(it.readText()) }
    } catch (_: java.io.FileNotFoundException) {
        JSONArray()
    } catch (_: Exception) {
        JSONArray()
    }

    private fun writePending(pending: JSONArray) {
        val output = file.startWrite()
        try {
            output.write(pending.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(output)
        } catch (error: Exception) {
            file.failWrite(output)
            throw error
        }
    }

    private companion object {
        val lock = Any()
    }
}
