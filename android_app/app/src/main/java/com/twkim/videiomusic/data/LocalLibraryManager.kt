package com.twkim.videiomusic.data

import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.util.AtomicFile
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/** SAF grants and document URIs stay native. Web only receives opaque catalog ids. */
class LocalLibraryManager(context: Context) {
    private val app = context.applicationContext
    private val resolver = app.contentResolver
    private val cache = AtomicFile(File(app.filesDir, "local_music_library_v1.json"))

    suspend fun list(): JSONObject = withContext(Dispatchers.IO) { mutations.withLock {
        val data = read()
        validateRoots(data)
        save(data)
        publicSnapshot(data)
    } }

    suspend fun add(uri: Uri): JSONObject = withContext(Dispatchers.IO) { mutations.withLock {
        require(uri.scheme == "content" && DocumentsContract.isTreeUri(uri)) { "Choose a document folder" }
        val data = read()
        val roots = data.getJSONArray("roots")
        val id = LocalLibraryPolicy.id(uri.toString())
        val alreadyOwned = resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val existing = (0 until roots.length()).map { roots.getJSONObject(it) }.firstOrNull { it.getString("id") == id }
        if (existing == null) {
            roots.put(JSONObject().put("id", id).put("uri", uri.toString())
                .put("name", "Music folder").put("available", true).put("ownsGrant", !alreadyOwned))
            // Persist the grant registration before potentially slow provider scanning.
            save(data)
        } else if (!alreadyOwned) {
            existing.put("ownsGrant", true)
            save(data)
        }
        scan(data)
        save(data)
        publicSnapshot(data)
    } }

    suspend fun refresh(): JSONObject = withContext(Dispatchers.IO) { mutations.withLock {
        val data = read()
        scan(data)
        save(data)
        publicSnapshot(data)
    } }

    suspend fun remove(id: String): JSONObject = withContext(Dispatchers.IO) { mutations.withLock {
        val data = read()
        val roots = data.getJSONArray("roots")
        val target = (0 until roots.length()).map { roots.getJSONObject(it) }.firstOrNull { it.getString("id") == id }
        data.put("roots", JSONArray((0 until roots.length()).map { roots.getJSONObject(it) }.filter { it.getString("id") != id }))
        filterItems(data) { it.getString("storageId") != id }
        save(data)
        if (target?.optBoolean("ownsGrant") == true) runCatching {
            resolver.releasePersistableUriPermission(Uri.parse(target.getString("uri")), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        publicSnapshot(data)
    } }

    /** Called off the main thread before constructing a Media3 item. Never trusts a web URI. */
    suspend fun resolveAll(mediaIds: Set<String>): Map<String, Uri> = withContext(Dispatchers.IO) { synchronized(lock) {
        if (mediaIds.isEmpty()) return@synchronized emptyMap()
        mediaIds.forEach(LocalLibraryPolicy::requireId)
        val data = read()
        val roots = data.getJSONArray("roots")
        val authorized = (0 until roots.length()).map { roots.getJSONObject(it) }
            .filter { hasGrant(it) && it.optBoolean("available", false) }.map { it.getString("id") }.toSet()
        val items = data.getJSONArray("items")
        val resolved = mutableMapOf<String, Uri>()
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            val id = item.getString("id")
            if (id !in mediaIds) continue
            require(item.getString("storageId") in authorized) { "Local folder unavailable. Select or refresh the folder again." }
            require(LocalLibraryPolicy.isAudio(item.optString("mimeType"), item.getString("name"))) { "Only local audio is supported" }
            resolved[id] = Uri.parse(item.getString("documentUri"))
        }
        require(resolved.keys.containsAll(mediaIds)) { "Local track is no longer in an authorized folder. Refresh local folders." }
        resolved
    } }

    private fun hasGrant(root: JSONObject): Boolean = resolver.persistedUriPermissions.any {
        it.uri.toString() == root.getString("uri") && it.isReadPermission
    }

    private fun validateRoots(data: JSONObject) {
        val roots = data.getJSONArray("roots")
        val unavailable = mutableSetOf<String>()
        for (index in 0 until roots.length()) {
            val root = roots.getJSONObject(index)
            runCatching {
                check(hasGrant(root)) { "Folder permission was revoked. Select the folder again." }
                root.put("name", folderName(Uri.parse(root.getString("uri"))))
            }.onFailure {
                root.put("available", false).put("error", it.message ?: "Folder unavailable")
                unavailable.add(root.getString("id"))
            }
        }
        filterItems(data) { it.getString("storageId") !in unavailable }
    }

    private fun folderName(tree: Uri): String {
        val document = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        resolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
            check(it.moveToFirst()) { "Folder unavailable" }
            return it.getString(0) ?: "Music folder"
        }
        error("Folder unavailable")
    }

    private fun scan(data: JSONObject) {
        val old = data.getJSONArray("items")
        val cached = (0 until old.length()).associate { val item = old.getJSONObject(it); item.getString("id") to item }
        val items = JSONArray()
        val roots = data.getJSONArray("roots")
        for (index in 0 until roots.length()) {
            val root = roots.getJSONObject(index)
            runCatching {
                check(hasGrant(root)) { "Folder permission was revoked. Select the folder again." }
                val tree = Uri.parse(root.getString("uri"))
                root.put("name", folderName(tree))
                val scanned = scanTree(tree, root, cached)
                scanned.forEach { items.put(it) }
                root.put("available", true).remove("error")
            }.onFailure { root.put("available", false).put("error", it.message ?: "Folder unavailable") }
        }
        data.put("items", items)
    }

    private fun scanTree(tree: Uri, root: JSONObject, cached: Map<String, JSONObject>): List<JSONObject> {
        val queue = ArrayDeque<Pair<String, String>>()
        queue.add(DocumentsContract.getTreeDocumentId(tree) to "")
        val seen = mutableSetOf<String>()
        val result = mutableListOf<JSONObject>()
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        while (queue.isNotEmpty()) {
            val (parent, path) = queue.removeFirst()
            if (!seen.add(parent)) continue
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
            val cursor = resolver.query(children, columns, null, null, null) ?: error("Cannot read folder contents")
            cursor.use {
                while (it.moveToNext()) {
                    val docId = it.getString(0)
                    val name = it.getString(1) ?: docId
                    val mime = it.getString(2).orEmpty()
                    val relative = if (path.isBlank()) name else "$path/$name"
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) { queue.add(docId to relative); continue }
                    if (!LocalLibraryPolicy.isAudio(mime, name)) continue
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
                    val id = "local:" + LocalLibraryPolicy.id(tree.toString() + "\n" + docId)
                    val size = it.getLong(3)
                    val modified = it.getLong(4)
                    val previous = cached[id]
                    val metadata = if (previous != null && previous.optLong("modifiedMs") == modified && previous.optLong("sizeBytes") == size)
                        previous.getJSONObject("metadata") else metadata(uri, name)
                    result.add(JSONObject().put("id", id).put("type", "audio").put("location", "local")
                        .put("storageId", root.getString("id")).put("rootName", root.getString("name"))
                        .put("relativePath", relative).put("name", name).put("mimeType", mime)
                        .put("sizeBytes", size).put("modifiedAt", Instant.ofEpochMilli(modified).toString())
                        .put("modifiedMs", modified).put("documentUri", uri.toString()).put("metadata", metadata))
                }
            }
        }
        return result
    }

    private fun metadata(uri: Uri, name: String): JSONObject {
        val result = JSONObject().put("title", name.substringBeforeLast('.', name))
        val reader = MediaMetadataRetriever()
        try {
            reader.setDataSource(app, uri)
            listOf("title" to MediaMetadataRetriever.METADATA_KEY_TITLE, "artist" to MediaMetadataRetriever.METADATA_KEY_ARTIST,
                "album" to MediaMetadataRetriever.METADATA_KEY_ALBUM).forEach { (key, tag) ->
                reader.extractMetadata(tag)?.takeIf { it.isNotBlank() }?.let { result.put(key, it) }
            }
            reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull()?.takeIf { it > 0 }?.let { result.put("durationSec", it / 1000) }
        } catch (_: Exception) { /* Unsupported metadata leaves the playable file's basic fields intact. */ }
        finally { reader.release() }
        return result
    }

    private fun read(): JSONObject = synchronized(lock) {
        try { cache.openRead().bufferedReader().use { JSONObject(it.readText()) } }
        catch (_: java.io.FileNotFoundException) { JSONObject().put("roots", JSONArray()).put("items", JSONArray()) }
    }

    private fun save(data: JSONObject) = synchronized(lock) {
        val output = cache.startWrite()
        try { output.write(data.toString().toByteArray(Charsets.UTF_8)); cache.finishWrite(output) }
        catch (error: Exception) { cache.failWrite(output); throw error }
    }

    private fun filterItems(data: JSONObject, keep: (JSONObject) -> Boolean) {
        val items = data.getJSONArray("items")
        data.put("items", JSONArray((0 until items.length()).map { items.getJSONObject(it) }.filter(keep)))
    }

    private fun publicSnapshot(data: JSONObject): JSONObject {
        val copy = JSONObject(data.toString())
        val roots = copy.getJSONArray("roots")
        for (i in 0 until roots.length()) roots.getJSONObject(i).remove("ownsGrant")
        val items = copy.getJSONArray("items")
        for (i in 0 until items.length()) { items.getJSONObject(i).remove("documentUri"); items.getJSONObject(i).remove("modifiedMs") }
        return copy
    }

    companion object { private val lock = Any(); private val mutations = Mutex() }
}
