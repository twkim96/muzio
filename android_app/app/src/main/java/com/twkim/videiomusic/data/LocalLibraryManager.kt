package com.twkim.videiomusic.data

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.util.AtomicFile
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/** SAF grants and document URIs stay native. Web only receives opaque catalog ids. */
class LocalLibraryManager(context: Context) {
    private val app = context.applicationContext
    private val resolver = app.contentResolver
    private val cache = AtomicFile(File(app.filesDir, "local_music_library_v1.json"))

    private val artworkDirectory = File(app.cacheDir, "local_music_artwork_v1")

    suspend fun list(): JSONObject = withContext(Dispatchers.IO) { mutations.withLock {
        val data = read()
        if (!data.optBoolean("incrementalScanMigrated", false)) {
            val existingItems = data.getJSONArray("items")
            val populatedRoots = (0 until existingItems.length()).map { existingItems.getJSONObject(it).getString("storageId") }.toSet()
            val legacyRoots = data.getJSONArray("roots")
            for (i in 0 until legacyRoots.length()) {
                val root = legacyRoots.getJSONObject(i)
                if (root.getString("id") !in populatedRoots && !root.has("needsScan")) root.put("needsScan", true)
            }
            data.put("incrementalScanMigrated", true)
            save(data)
        }
        validateRoots(data)
        val snapshot = publicSnapshot(data)
        startEnrichment()
        snapshot
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
                .put("name", "Music folder").put("available", true).put("ownsGrant", !alreadyOwned).put("needsScan", true))
            // Persist the grant registration before potentially slow provider scanning.
            save(data)
        } else if (!alreadyOwned) {
            existing.put("ownsGrant", true)
            save(data)
        }
        val root = (0 until roots.length()).map { roots.getJSONObject(it) }.first { it.getString("id") == id }
        root.put("needsScan", true)
        save(data)
        scan(data, setOf(id))
        save(data)
        startEnrichment()
        publicSnapshot(data)
    } }

    suspend fun refresh(): JSONObject = withContext(Dispatchers.IO) { mutations.withLock {
        val data = read()
        val roots = data.getJSONArray("roots")
        for (i in 0 until roots.length()) roots.getJSONObject(i).put("needsScan", true)
        save(data)
        scan(data)
        save(data)
        startEnrichment()
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

    /** WebView calls this on its request worker; paths are derived solely from registry records. */
    fun openArtwork(id: String): java.io.InputStream? = runBlocking(Dispatchers.IO) {
        LocalLibraryPolicy.requireId(id)
        val item = mutations.withLock { authorizedItems()[id] } ?: return@runBlocking null
        artworkExtraction.withLock { if (!artworkFile(item).exists()) extractArtwork(item) }
        mutations.withLock {
            val current = authorizedItems()[id] ?: return@withLock null
            if (artworkKey(current) != artworkKey(item)) return@withLock null
            artworkFile(current).takeIf { it.isFile }?.inputStream()
        }
    }

    /** Extract only the selected item; large queues never trigger a startup metadata rescan. */
    suspend fun artworkUris(ids: Set<String>, selectedId: String?): Map<String, Uri> = withContext(Dispatchers.IO) {
        ids.forEach(LocalLibraryPolicy::requireId)
        val selected = mutations.withLock { selectedId?.takeIf { it in ids }?.let { authorizedItems()[it] } }
        if (selected != null) artworkExtraction.withLock {
            if (!artworkFile(selected).exists()) extractArtwork(selected)
        }
        mutations.withLock {
            val authorized = authorizedItems()
            ids.mapNotNull { id ->
                val item = authorized[id] ?: return@mapNotNull null
                artworkFile(item).takeIf { it.isFile }?.let { id to Uri.fromFile(it) }
            }.toMap()
        }
    }

    private fun authorizedItems(): Map<String, JSONObject> {
        val data = read()
        val roots = data.getJSONArray("roots")
        val authorizedRoots = (0 until roots.length()).map { roots.getJSONObject(it) }
            .filter { it.optBoolean("available", false) && hasGrant(it) }.map { it.getString("id") }.toSet()
        val items = data.getJSONArray("items")
        return (0 until items.length()).map { items.getJSONObject(it) }
            .filter { it.getString("storageId") in authorizedRoots && LocalLibraryPolicy.isAudio(it.optString("mimeType"), it.getString("name")) }
            .associateBy { it.getString("id") }
    }

    private fun artworkKey(item: JSONObject) = LocalLibraryPolicy.id(item.getString("id") + ":" + item.optLong("modifiedMs") + ":" + item.optLong("sizeBytes"))
    private fun artworkFile(item: JSONObject) = File(artworkDirectory, artworkKey(item) + ".jpg")

    private fun extractArtwork(item: JSONObject) {
        val file = artworkFile(item)
        val missing = File(artworkDirectory, artworkKey(item) + ".missing")
        if (file.exists() || missing.exists()) return
        val reader = MediaMetadataRetriever()
        try {
            reader.setDataSource(app, Uri.parse(item.getString("documentUri")))
            cacheArtwork(item, reader.embeddedPicture)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Provider failures are retryable on the next request. */ }
        finally { runCatching { reader.release() } }
    }

    private fun cacheArtwork(item: JSONObject, picture: ByteArray?) {
        artworkDirectory.mkdirs()
        val file = artworkFile(item)
        val missing = File(artworkDirectory, artworkKey(item) + ".missing")
        if (picture == null || picture.size > 20 * 1024 * 1024) { missing.createNewFile(); return }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(picture, 0, picture.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) { missing.createNewFile(); return }
        var sample = 1
        while (bounds.outWidth / sample > 1024 || bounds.outHeight / sample > 1024) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(picture, 0, picture.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: run { missing.createNewFile(); return }
        val atomic = AtomicFile(file)
        try {
            val output = atomic.startWrite()
            try { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output)); atomic.finishWrite(output) }
            catch (error: Exception) { atomic.failWrite(output); throw error }
        } finally { bitmap.recycle() }
    }

    private fun hasGrant(root: JSONObject): Boolean = resolver.persistedUriPermissions.any {
        it.uri.toString() == root.getString("uri") && it.isReadPermission
    }

    private fun validateRoots(data: JSONObject) {
        val roots = data.getJSONArray("roots")
        val unavailable = mutableSetOf<String>()
        for (index in 0 until roots.length()) {
            val root = roots.getJSONObject(index)
            if (!hasGrant(root)) {
                root.put("available", false).put("error", "Folder permission was revoked. Select the folder again.")
                unavailable.add(root.getString("id"))
            }
        }
        if (unavailable.isNotEmpty()) {
            filterItems(data) { it.getString("storageId") !in unavailable }
            save(data)
        }
    }

    private fun folderName(tree: Uri): String {
        val document = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        resolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
            check(it.moveToFirst()) { "Folder unavailable" }
            return it.getString(0) ?: "Music folder"
        }
        error("Folder unavailable")
    }

    private suspend fun scan(data: JSONObject, selectedRoots: Set<String>? = null) {
        val old = data.getJSONArray("items")
        val cached = (0 until old.length()).associate { val item = old.getJSONObject(it); item.getString("id") to item }
        val items = JSONArray((0 until old.length()).map { old.getJSONObject(it) }
            .filter { selectedRoots != null && it.getString("storageId") !in selectedRoots })
        val roots = data.getJSONArray("roots")
        for (index in 0 until roots.length()) {
            val root = roots.getJSONObject(index)
            if (selectedRoots != null && root.getString("id") !in selectedRoots) continue
            currentCoroutineContext().ensureActive()
            try {
                check(hasGrant(root)) { "Folder permission was revoked. Select the folder again." }
                val tree = Uri.parse(root.getString("uri"))
                root.put("name", folderName(tree))
                val scanned = scanTree(tree, root, cached)
                scanned.forEach { items.put(it) }
                root.put("available", true).remove("error")
                root.put("needsScan", false)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                root.put("available", false).put("needsScan", false).put("error", error.message ?: "Folder unavailable")
            }
        }
        data.put("items", items)
    }

    private suspend fun scanTree(tree: Uri, root: JSONObject, cached: Map<String, JSONObject>): List<JSONObject> {
        val queue = ArrayDeque<Pair<String, String>>()
        queue.add(DocumentsContract.getTreeDocumentId(tree) to "")
        val seen = mutableSetOf<String>()
        val result = mutableListOf<JSONObject>()
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        while (queue.isNotEmpty()) {
            currentCoroutineContext().ensureActive()
            val (parent, path) = queue.removeFirst()
            if (!seen.add(parent)) continue
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
            val cursor = resolver.query(children, columns, null, null, null) ?: error("Cannot read folder contents")
            cursor.use {
                while (it.moveToNext()) {
                    currentCoroutineContext().ensureActive()
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
                    val unchanged = previous != null && previous.optLong("modifiedMs") == modified && previous.optLong("sizeBytes") == size
                    val metadata = if (unchanged) previous!!.getJSONObject("metadata") else basicMetadata(name)
                    result.add(JSONObject().put("id", id).put("type", "audio").put("location", "local")
                        .put("storageId", root.getString("id")).put("rootName", root.getString("name"))
                        .put("relativePath", relative).put("name", name).put("mimeType", mime)
                        .put("sizeBytes", size).put("modifiedAt", Instant.ofEpochMilli(modified).toString())
                        .put("modifiedMs", modified).put("documentUri", uri.toString()).put("metadata", metadata)
                        .put("metadataPending", !unchanged || previous!!.optBoolean("metadataPending", false))
                        .put("revision", UUID.randomUUID().toString()))
                }
            }
        }
        return result
    }

    private fun basicMetadata(name: String) = JSONObject().put("title", name.substringBeforeLast('.', name))

    private fun metadata(uri: Uri, name: String): JSONObject {
        val result = basicMetadata(name)
        val reader = MediaMetadataRetriever()
        try {
            reader.setDataSource(app, uri)
            listOf("title" to MediaMetadataRetriever.METADATA_KEY_TITLE, "artist" to MediaMetadataRetriever.METADATA_KEY_ARTIST,
                "album" to MediaMetadataRetriever.METADATA_KEY_ALBUM).forEach { (key, tag) ->
                reader.extractMetadata(tag)?.takeIf { it.isNotBlank() }?.let { result.put(key, it) }
            }
            reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull()?.takeIf { it > 0 }?.let { result.put("durationSec", it / 1000) }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Unsupported metadata leaves the playable file's basic fields intact. */ }
        finally { runCatching { reader.release() } }
        return result
    }

    /** Process-owned work survives Activity recreation; the durable flags resume after process death. */
    private fun startEnrichment(): Unit = synchronized(workerLock) {
        if (worker?.isActive == true) return@synchronized
        worker = enrichmentScope.launch {
            try {
                while (true) {
                    val batch = mutations.withLock {
                        val data = read()
                        val roots = data.getJSONArray("roots")
                        val pendingRoots = (0 until roots.length()).map { roots.getJSONObject(it) }
                            .filter { it.optBoolean("needsScan", false) }.map { it.getString("id") }.toSet()
                        if (pendingRoots.isNotEmpty()) { scan(data, pendingRoots); save(data) }
                        authorizedItems().values.filter { it.optBoolean("metadataPending", false) }.take(8)
                    }
                    if (batch.isEmpty()) {
                        // Serialize the idle transition with callers scheduling new work.
                        synchronized(workerLock) { worker = null }
                        // Recheck under the mutation lock: add/list may have raced the idle transition.
                        mutations.withLock {
                            if (authorizedItems().values.any { it.optBoolean("metadataPending", false) }) startEnrichment()
                        }
                        return@launch
                    }
                    val enriched = batch.map { item ->
                        currentCoroutineContext().ensureActive()
                        val result = metadata(Uri.parse(item.getString("documentUri")), item.getString("name"))
                        delay(25) // Yield between provider reads instead of saturating storage.
                        item to result
                    }
                    mutations.withLock {
                        val data = read()
                        val roots = data.getJSONArray("roots")
                        val grants = (0 until roots.length()).map { roots.getJSONObject(it) }
                            .filter { it.optBoolean("available", false) && hasGrant(it) }.map { it.getString("id") }.toSet()
                        val items = data.getJSONArray("items")
                        val current = (0 until items.length()).map { items.getJSONObject(it) }.associateBy { it.getString("id") }
                        var changed = false
                        for ((source, result) in enriched) {
                            val target = current[source.getString("id")] ?: continue
                            if (!LocalEnrichmentPolicy.canCommit(
                                    source.getString("id"), source.getString("storageId"), source.optString("revision"),
                                    target.getString("id"), target.getString("storageId"), target.optString("revision"),
                                    target.getString("storageId") in grants)) continue
                            target.put("metadata", result).put("metadataPending", false)
                            changed = true
                        }
                        if (changed) save(data)
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { android.util.Log.w("LocalLibrary", "Metadata enrichment paused; next list resumes it", error) }
        }
    }

    private fun read(): JSONObject = synchronized(lock) {
        try { cache.openRead().bufferedReader().use { JSONObject(it.readText()) } }
        catch (_: java.io.FileNotFoundException) { JSONObject().put("roots", JSONArray()).put("items", JSONArray()) }
    }

    private fun save(data: JSONObject) = synchronized(lock) {
        val output = cache.startWrite()
        try { output.write(data.toString().toByteArray(Charsets.UTF_8)); cache.finishWrite(output) }
        catch (error: Exception) { cache.failWrite(output); throw error }
        runCatching {
            val items = data.getJSONArray("items")
            val keys = (0 until items.length()).map { artworkKey(items.getJSONObject(it)) }.toSet()
            artworkDirectory.listFiles()?.filter { it.name.substringBefore('.') !in keys }?.forEach { it.delete() }
        }
        Unit
    }

    private fun filterItems(data: JSONObject, keep: (JSONObject) -> Boolean) {
        val items = data.getJSONArray("items")
        data.put("items", JSONArray((0 until items.length()).map { items.getJSONObject(it) }.filter(keep)))
    }

    private fun publicSnapshot(data: JSONObject): JSONObject {
        val copy = JSONObject(data.toString())
        copy.remove("incrementalScanMigrated")
        val scanningRoots = data.getJSONArray("roots")
        val scanning = (0 until scanningRoots.length()).any { scanningRoots.getJSONObject(it).optBoolean("needsScan", false) }
        val roots = copy.getJSONArray("roots")
        for (i in 0 until roots.length()) {
            roots.getJSONObject(i).remove("ownsGrant")
            roots.getJSONObject(i).remove("needsScan")
        }
        val items = copy.getJSONArray("items")
        copy.put("enrichment", JSONObject().put("pending", (0 until items.length()).count { items.getJSONObject(it).optBoolean("metadataPending", false) }).put("total", items.length()).put("scanning", scanning))
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i)
            item.remove("metadataPending")
            item.remove("revision")
            val key = artworkKey(item)
            item.put("thumbnail", JSONObject().put("url", "/__muzio_local/artwork/" + item.getString("id") + "?v=" + key)
                .put("kind", "embedded-artwork").put("status", "ready").put("cacheKey", key))
            item.remove("documentUri")
            item.remove("modifiedMs")
        }
        return copy
    }

    companion object {
        private val lock = Any()
        private val mutations = Mutex()
        private val artworkExtraction = Mutex()
        private val workerLock = Any()
        private val enrichmentScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        private var worker: Job? = null
    }
}
