package com.twkim.videiomusic.ui

import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import com.twkim.videiomusic.BuildConfig
import com.twkim.videiomusic.data.AppearanceSettings
import com.twkim.videiomusic.data.FallbackPlan
import com.twkim.videiomusic.data.LibraryItem
import com.twkim.videiomusic.data.LibraryPreferencesStore
import com.twkim.videiomusic.data.LibrarySnapshotStore
import com.twkim.videiomusic.data.LoadState
import com.twkim.videiomusic.data.MediaType
import com.twkim.videiomusic.data.MediaRootsSettings
import com.twkim.videiomusic.data.MuzioApi
import com.twkim.videiomusic.data.ProfileStore
import com.twkim.videiomusic.data.ProgressRecord
import com.twkim.videiomusic.data.ServerProfile
import com.twkim.videiomusic.data.displayTitle
import com.twkim.videiomusic.data.contentKey
import com.twkim.videiomusic.data.resumePositionSec
import com.twkim.videiomusic.playback.PlaybackService
import com.twkim.videiomusic.playback.PlaybackRuntime
import java.util.Locale
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

@Composable
fun MuzioTheme(appearance: AppearanceSettings? = null, content: @Composable () -> Unit) {
    val surface = appearance?.surfaceColor.toComposeColor(Color(0xFF111111))
    val foreground = appearance?.foregroundColor.toComposeColor(Color(0xFFEDEDED))
    val muted = appearance?.mutedColor.toComposeColor(Color(0xFFAEAEAE))
    val accent = appearance?.accentColor.toComposeColor(Color(0xFFFF3150))
    val light = surface.luminance() > 0.5f
    val scheme = if (light) {
        androidx.compose.material3.lightColorScheme(
            primary = accent,
            onPrimary = Color.White,
            background = surface,
            surface = surface,
            surfaceVariant = Color(0xFFF1F1F3),
            onBackground = foreground,
            onSurface = foreground,
            onSurfaceVariant = muted,
            outline = muted.copy(alpha = 0.48f),
        )
    } else {
        androidx.compose.material3.darkColorScheme(
            primary = accent,
            onPrimary = Color.White,
            secondary = Color(0xFF25B8A8),
            background = surface,
            surface = surface,
            surfaceVariant = foreground.copy(alpha = 0.09f),
            onBackground = foreground,
            onSurface = foreground,
            onSurfaceVariant = muted,
            outline = muted.copy(alpha = 0.42f),
        )
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

private fun String?.toComposeColor(fallback: Color): Color {
    val raw = this?.removePrefix("#") ?: return fallback
    if (raw.length != 6) return fallback
    return runCatching { Color(0xFF000000 or raw.toLong(16)) }.getOrDefault(fallback)
}

private enum class ScreenTab(val label: String, val mediaType: MediaType?) {
    Music("Music", MediaType.Audio),
    Video("Video", MediaType.Video),
    Image("Image", MediaType.Image),
    Settings("Setting", null),
}

@Composable
fun MuzioApp(
    player: Player,
    profileStore: ProfileStore,
    libraryPreferencesStore: LibraryPreferencesStore,
    librarySnapshotStore: LibrarySnapshotStore,
    api: MuzioApi,
    onAppearanceChanged: (AppearanceSettings) -> Unit,
) {
    val profile by profileStore.profile.collectAsStateWithLifecycle(initialValue = ServerProfile())
    val libraryPreferences by libraryPreferencesStore.preferences.collectAsStateWithLifecycle(
        initialValue = com.twkim.videiomusic.data.LibraryPreferences(),
    )
    val scope = rememberCoroutineScope()
    val libraryStates = remember { mutableStateMapOf<MediaType, LoadState>() }
    val progressRecords = remember { mutableStateMapOf<String, ProgressRecord>() }
    var selectedTab by remember { mutableStateOf(ScreenTab.Music) }
    var activeMedia by remember { mutableStateOf<LibraryItem?>(null) }
    var imageViewerItem by remember { mutableStateOf<LibraryItem?>(null) }
    var videoViewerItem by remember { mutableStateOf<LibraryItem?>(null) }
    var audioPlayerOpen by remember { mutableStateOf(false) }
    var audioPlayerInitialPanel by remember { mutableStateOf<String?>(null) }
    var playlistPickerItems by remember { mutableStateOf<List<LibraryItem>>(emptyList()) }
    var playlistBrowserOpen by remember { mutableStateOf(false) }
    var mobileMenuOpen by remember { mutableStateOf(false) }
    var isPlaying by remember { mutableStateOf(player.isPlaying) }
    var currentMediaId by remember { mutableStateOf(player.currentMediaItem?.mediaId) }
    var playerError by remember { mutableStateOf<String?>(null) }
    var fallbackPlan by remember { mutableStateOf<FallbackPlan?>(null) }
    var fallbackLoading by remember { mutableStateOf(false) }

    LaunchedEffect(profile.baseUrl) {
        if (profile.baseUrl.isNotBlank()) {
            runCatching { api.fetchAppearance(profile.baseUrl) }.onSuccess(onAppearanceChanged)
        }
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(value: Boolean) {
                isPlaying = value
                if (value) playerError = null
            }

            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                currentMediaId = mediaItem?.mediaId
                playerError = null
                fallbackPlan = null
            }

            override fun onPlayerError(error: PlaybackException) {
                playerError = error.message ?: error.errorCodeName
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }

    fun load(mediaType: MediaType) {
        if (profile.baseUrl.isBlank()) return
        libraryStates[mediaType] = LoadState.Loading
        scope.launch {
            libraryStates[mediaType] = try {
                val snapshot = api.fetchLibrary(profile.baseUrl, mediaType)
                librarySnapshotStore.write(profile.baseUrl, mediaType, snapshot)
                LoadState.Ready(snapshot)
            } catch (error: Exception) {
                val cached = librarySnapshotStore.read(profile.baseUrl, mediaType)
                if (cached != null) LoadState.Ready(cached)
                else LoadState.Error(error.message ?: "Unable to load library")
            }
        }
    }

    fun mediaItem(item: LibraryItem): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(item.displayTitle())
            .setArtist(item.metadata.artist)
            .setAlbumTitle(item.metadata.album)
            .setExtras(
                PlaybackService.sourceExtras(
                    mediaType = item.type,
                    name = item.name,
                    rootName = item.rootName,
                    relativePath = item.relativePath,
                    contentKey = item.contentKey(),
                    artist = item.metadata.artist,
                ),
            )
        api.thumbnailUrl(profile.baseUrl, item)?.let { metadata.setArtworkUri(Uri.parse(it)) }
        return MediaItem.Builder()
            .setMediaId(item.id)
            .setUri(api.mediaUrl(profile.baseUrl, item.id))
            .setMimeType(item.mimeType)
            .setMediaMetadata(metadata.build())
            .build()
    }

    fun play(item: LibraryItem, visibleItems: List<LibraryItem>) {
        activeMedia = item
        val startPositionMs = ((progressRecords[item.id]?.resumePositionSec() ?: 0.0) * 1_000).toLong()
        val selectedMediaItem = mediaItem(item)
        if (item.type == MediaType.Audio) {
            val audioQueue = visibleItems.filter { it.type == MediaType.Audio }
            val currentType = player.currentMediaItem?.mediaMetadata?.extras
                ?.getString(PlaybackService.EXTRA_MEDIA_TYPE)
            if (player.mediaItemCount == 0 || currentType != MediaType.Audio.apiValue) {
                val queueItems = audioQueue.map(::mediaItem)
                val startIndex = audioQueue.indexOfFirst { it.id == item.id }.coerceAtLeast(0)
                player.setMediaItems(queueItems, startIndex, startPositionMs)
            } else {
                val insertIndex = (player.currentMediaItemIndex + 1).coerceAtMost(player.mediaItemCount)
                player.addMediaItem(insertIndex, selectedMediaItem)
                player.seekTo(insertIndex, startPositionMs)
            }
        } else {
            player.setMediaItem(selectedMediaItem, startPositionMs)
        }
        player.prepare()
        player.playWhenReady = true
        if (item.type == MediaType.Video) {
            audioPlayerOpen = false
            videoViewerItem = item
        }
    }

    LaunchedEffect(profile.baseUrl, selectedTab) {
        val mediaType = selectedTab.mediaType ?: return@LaunchedEffect
        if (profile.baseUrl.isNotBlank() && libraryStates[mediaType] == null) load(mediaType)
    }

    LaunchedEffect(profile.baseUrl) {
        progressRecords.clear()
        if (profile.baseUrl.isBlank()) return@LaunchedEffect
        runCatching { api.fetchProgress(profile.baseUrl) }
            .getOrDefault(emptyList())
            .forEach { progressRecords[it.mediaId] = it }
    }

    LaunchedEffect(profile.baseUrl) {
        if (profile.baseUrl.isBlank()) return@LaunchedEffect
        MediaType.entries.forEach { type ->
            if (libraryStates[type] == null) {
                librarySnapshotStore.read(profile.baseUrl, type)?.let {
                    libraryStates[type] = LoadState.Ready(it)
                }
            }
        }
        var lastEventRevision = libraryStates.values.asSequence()
            .filterIsInstance<LoadState.Ready>()
            .maxOfOrNull { it.snapshot.revision } ?: 0L
        var retryDelayMs = 1_000L
        while (true) {
            try {
                api.collectLibraryEvents(profile.baseUrl, lastEventRevision) { event ->
                    lastEventRevision = maxOf(lastEventRevision, event.revision)
                    event.affectedTypes.forEach { type ->
                        val ready = libraryStates[type] as? LoadState.Ready
                        if (ready == null) {
                            load(type)
                            return@forEach
                        }
                        if (event.reason == "connected" && event.revision < ready.snapshot.revision) {
                            load(type)
                            return@forEach
                        }
                        if (event.revision <= ready.snapshot.revision) return@forEach
                        runCatching {
                            api.fetchLibraryChanges(profile.baseUrl, type, ready.snapshot.revision)
                        }.onSuccess { changes ->
                            if (changes.resetRequired) {
                                load(type)
                            } else {
                                val deleted = changes.deletedIds.toSet()
                                val upserts = changes.upserts.associateBy(LibraryItem::id)
                                val merged = (ready.snapshot.items.filterNot { it.id in deleted || it.id in upserts } +
                                    changes.upserts).sortedWith(
                                    compareByDescending<LibraryItem> { it.modifiedAt }.thenBy { it.relativePath },
                                )
                                val snapshot = com.twkim.videiomusic.data.LibrarySnapshot(changes.revision, merged)
                                libraryStates[type] = LoadState.Ready(snapshot)
                                librarySnapshotStore.write(profile.baseUrl, type, snapshot)
                            }
                        }.onFailure { load(type) }
                    }
                }
                retryDelayMs = 1_000L
            } catch (_: Exception) {
                delay(retryDelayMs)
                retryDelayMs = (retryDelayMs * 2).coerceAtMost(30_000L)
            }
        }
    }

    LaunchedEffect(currentMediaId, libraryStates.values.toList()) {
        val id = currentMediaId ?: return@LaunchedEffect
        activeMedia = libraryStates.values.asSequence()
            .filterIsInstance<LoadState.Ready>()
            .flatMap { it.snapshot.items.asSequence() }
            .firstOrNull { it.id == id }
            ?: activeMedia
    }

    LaunchedEffect(playerError, videoViewerItem?.id, profile.baseUrl) {
        val item = videoViewerItem ?: return@LaunchedEffect
        if (playerError == null || profile.baseUrl.isBlank()) return@LaunchedEffect
        fallbackLoading = true
        fallbackPlan = runCatching { api.fetchFallbackPlan(profile.baseUrl, item.id) }.getOrNull()
        fallbackLoading = false
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .imePadding(),
            ) {
                MuzioTopTabs(selectedTab = selectedTab, onSelect = { selectedTab = it })

            Box(modifier = Modifier.weight(1f)) {
                val mediaType = selectedTab.mediaType
                if (mediaType == null) {
                    SettingsScreen(
                        profile = profile,
                        profileStore = profileStore,
                        libraryPreferencesStore = libraryPreferencesStore,
                        api = api,
                        onAppearanceChanged = onAppearanceChanged,
                    )
                } else if (profile.baseUrl.isBlank()) {
                    EmptyProfileScreen(onOpenSettings = { selectedTab = ScreenTab.Settings })
                } else {
                    LibraryScreen(
                        mediaType = mediaType,
                        state = libraryStates[mediaType] ?: LoadState.Idle,
                        baseUrl = profile.baseUrl,
                        api = api,
                        progressRecords = progressRecords,
                        onRefresh = { load(mediaType) },
                        likedContentKeys = libraryPreferences.likedContentKeys,
                        onToggleLike = { item ->
                            scope.launch { libraryPreferencesStore.toggleLike(item.contentKey()) }
                        },
                        onAddToPlaylist = { playlistPickerItems = listOf(it) },
                        onAddItemsToPlaylist = { playlistPickerItems = it },
                        onOpen = { item, visibleItems ->
                            when (item.type) {
                                MediaType.Image -> imageViewerItem = item
                                MediaType.Audio, MediaType.Video -> play(item, visibleItems)
                            }
                        },
                    )
                }
            }

                activeMedia?.takeIf { it.type == MediaType.Audio }?.let { item ->
                    MiniPlayer(
                        item = item,
                        player = player,
                        artworkUrl = api.thumbnailUrl(profile.baseUrl, item),
                        isPlaying = isPlaying,
                        fallbackDurationMs = maxOf(
                            ((item.metadata.durationSec ?: 0.0) * 1000.0).toLong(),
                            ((progressRecords[item.id]?.durationSec ?: 0.0) * 1000.0).toLong(),
                        ),
                        onExpand = {
                            audioPlayerInitialPanel = null
                            audioPlayerOpen = true
                        },
                        onPlayPause = { if (player.isPlaying) player.pause() else player.play() },
                        onQueue = {
                            audioPlayerInitialPanel = "queue"
                            audioPlayerOpen = true
                        },
                        onTimer = {
                            audioPlayerInitialPanel = "timer"
                            audioPlayerOpen = true
                        },
                        onVolume = {
                            audioPlayerInitialPanel = "volume"
                            audioPlayerOpen = true
                        },
                    )
                }
            }
            MobileLibraryMenu(
                selectedTab = selectedTab,
                open = mobileMenuOpen,
                customPlaylistNames = libraryPreferences.playlists.map { it.name },
                queueAvailable = activeMedia?.type == MediaType.Audio,
                onOpen = { mobileMenuOpen = true },
                onClose = { mobileMenuOpen = false },
                onOpenCollections = {
                    mobileMenuOpen = false
                    playlistBrowserOpen = true
                },
                onOpenQueue = {
                    mobileMenuOpen = false
                    audioPlayerInitialPanel = "queue"
                    audioPlayerOpen = true
                },
                onRefresh = {
                    mobileMenuOpen = false
                    MediaType.entries.forEach(::load)
                },
            )
        }
    }

    imageViewerItem?.let { item ->
        FullscreenViewer(item = item, onClose = { imageViewerItem = null }) {
            AsyncImage(
                model = api.mediaUrl(profile.baseUrl, item.id),
                contentDescription = item.displayTitle(),
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Fit,
            )
        }
    }

    videoViewerItem?.let { item ->
        val videoItems = (libraryStates[MediaType.Video] as? LoadState.Ready)
            ?.snapshot?.items.orEmpty().filter { it.type == MediaType.Video }
        VideoPlayerScreen(
            item = item,
            player = player,
            streamUrl = api.mediaUrl(profile.baseUrl, item.id),
            errorMessage = playerError,
            fallbackPlan = fallbackPlan,
            fallbackLoading = fallbackLoading,
            upNextItems = videoItems,
            thumbnailUrlFor = { candidate -> api.thumbnailUrl(profile.baseUrl, candidate) },
            onPlayUpNext = { next -> play(next, videoItems) },
            onRetry = {
                playerError = null
                player.prepare()
                player.play()
            },
            onClose = {
                videoViewerItem = null
                player.pause()
            },
        )
    }

    if (audioPlayerOpen && activeMedia?.type == MediaType.Audio) {
        FullAudioPlayerScreen(
            player = player,
            initialPanel = audioPlayerInitialPanel,
            fallbackDurationMs = (
                maxOf(
                    activeMedia?.metadata?.durationSec ?: 0.0,
                    activeMedia?.id?.let { progressRecords[it]?.durationSec } ?: 0.0,
                ) * 1000.0
            ).toLong(),
            liked = activeMedia?.contentKey() in libraryPreferences.likedContentKeys,
            onToggleLike = {
                activeMedia?.let { item ->
                    scope.launch { libraryPreferencesStore.toggleLike(item.contentKey()) }
                }
            },
            onCollapse = {
                audioPlayerOpen = false
                audioPlayerInitialPanel = null
            },
        )
    }

    playlistPickerItems.takeIf(List<LibraryItem>::isNotEmpty)?.let { items ->
        PlaylistPicker(
            items = items,
            playlists = libraryPreferences.playlists,
            onAdd = { playlistId ->
                scope.launch {
                    libraryPreferencesStore.addItems(playlistId, items.map(LibraryItem::contentKey))
                    playlistPickerItems = emptyList()
                }
            },
            onCreateAndAdd = { name ->
                scope.launch {
                    libraryPreferencesStore.createPlaylist(name)?.let { playlistId ->
                        libraryPreferencesStore.addItems(playlistId, items.map(LibraryItem::contentKey))
                    }
                    playlistPickerItems = emptyList()
                }
            },
            onClose = { playlistPickerItems = emptyList() },
        )
    }
    if (playlistBrowserOpen) {
        val playableItems = libraryStates.values.asSequence()
            .filterIsInstance<LoadState.Ready>()
            .flatMap { it.snapshot.items.asSequence() }
            .filter { it.type != MediaType.Image }
            .distinctBy(LibraryItem::id)
            .toList()
        PlaylistBrowser(
            allItems = playableItems,
            preferences = libraryPreferences,
            onPlay = { item, items ->
                playlistBrowserOpen = false
                play(item, items)
            },
            onCreate = { name -> scope.launch { libraryPreferencesStore.createPlaylist(name) } },
            onRename = { id, name -> scope.launch { libraryPreferencesStore.renamePlaylist(id, name) } },
            onDelete = { id -> scope.launch { libraryPreferencesStore.deletePlaylist(id) } },
            onRemove = { id, key ->
                scope.launch { libraryPreferencesStore.removeItems(id, listOf(key)) }
            },
            onToggleLike = { item ->
                scope.launch { libraryPreferencesStore.toggleLike(item.contentKey()) }
            },
            onClose = { playlistBrowserOpen = false },
        )
    }
}

@Composable
private fun LibraryScreen(
    mediaType: MediaType,
    state: LoadState,
    baseUrl: String,
    api: MuzioApi,
    progressRecords: Map<String, ProgressRecord>,
    onRefresh: () -> Unit,
    likedContentKeys: Set<String>,
    onToggleLike: (LibraryItem) -> Unit,
    onAddToPlaylist: (LibraryItem) -> Unit,
    onAddItemsToPlaylist: (List<LibraryItem>) -> Unit,
    onOpen: (LibraryItem, List<LibraryItem>) -> Unit,
) {
    var query by remember(mediaType) { mutableStateOf("") }
    var sortByName by remember(mediaType) { mutableStateOf(false) }
    var selectionMode by remember(mediaType) { mutableStateOf(false) }
    var selectedIds by remember(mediaType) { mutableStateOf<Set<String>>(emptySet()) }

    fun clearSelection() {
        selectionMode = false
        selectedIds = emptySet()
    }

    fun toggleSelected(item: LibraryItem) {
        val next = selectedIds.toMutableSet().apply {
            if (!add(item.id)) remove(item.id)
        }
        selectedIds = next
        if (next.isEmpty()) selectionMode = false
    }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (selectionMode) {
                Text(
                    text = "${selectedIds.size} selected",
                    fontSize = 30.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    enabled = selectedIds.isNotEmpty(),
                    onClick = {
                        val selected = (state as? LoadState.Ready)?.snapshot?.items
                            ?.filter { it.id in selectedIds }.orEmpty()
                        if (selected.isNotEmpty()) onAddItemsToPlaylist(selected)
                        clearSelection()
                    },
                ) { Text("Add to Playlist") }
                TextButton(onClick = ::clearSelection) { Text("Clear") }
            } else {
                Text(
                    text = mediaType.label,
                    fontSize = 42.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { sortByName = !sortByName }) {
                    Text("⇅", fontSize = 22.sp)
                }
            }
        }

        BasicTextField(
            value = query,
            onValueChange = { query = it },
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 8.dp),
            singleLine = true,
            textStyle = TextStyle(
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 16.sp,
            ),
            decorationBox = { inner ->
                Box(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                    if (query.isEmpty()) {
                        Text("Filter", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 16.sp)
                    }
                    inner()
                }
            },
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.7f))

        when (state) {
            LoadState.Idle, LoadState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }

            is LoadState.Error -> ErrorPanel(state.message, onRefresh)
            is LoadState.Ready -> {
                val normalized = query.trim().lowercase(Locale.ROOT)
                val filteredItems = state.snapshot.items
                    .asSequence()
                    .filter { item ->
                        normalized.isBlank() || listOf(
                            item.displayTitle(),
                            item.name,
                            item.relativePath,
                            item.metadata.artist.orEmpty(),
                            item.metadata.album.orEmpty(),
                        ).any { it.lowercase(Locale.ROOT).contains(normalized) }
                    }
                    .toList()
                val visibleItems = if (sortByName) {
                    filteredItems.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.displayTitle() })
                } else {
                    filteredItems
                }

                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(visibleItems, key = { it.id }) { item ->
                        val progress = progressRecords[item.id]
                        val fraction = progress?.takeIf { it.durationSec > 0.0 }
                            ?.let { (it.positionSec / it.durationSec).coerceIn(0.0, 1.0).toFloat() }
                        LibraryRow(
                            item = item,
                            thumbnailUrl = api.thumbnailUrl(baseUrl, item),
                            liked = item.contentKey() in likedContentKeys,
                            progressLabel = fraction?.let {
                                if (it >= 1f) "Watched" else "${(it * 100).toInt()}%"
                            },
                            onToggleLike = { onToggleLike(item) },
                            onAddToPlaylist = { onAddToPlaylist(item) },
                            selected = item.id in selectedIds,
                            selectionMode = selectionMode,
                            onLongClick = {
                                if (mediaType != MediaType.Image) {
                                    selectionMode = true
                                    selectedIds = setOf(item.id)
                                }
                            },
                            onClick = {
                                if (selectionMode) toggleSelected(item) else onOpen(item, visibleItems)
                            },
                        )
                        if (item.type == MediaType.Video) {
                            Box(
                                Modifier.fillMaxWidth().height(2.dp)
                                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f)),
                            ) {
                                Box(
                                    Modifier.fillMaxWidth(fraction ?: 0f).height(2.dp)
                                        .background(
                                            if (fraction != null && fraction >= 1f) {
                                                MaterialTheme.colorScheme.onSurfaceVariant
                                            } else {
                                                MaterialTheme.colorScheme.primary
                                            },
                                        ),
                                )
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LibraryRow(
    item: LibraryItem,
    thumbnailUrl: String?,
    liked: Boolean,
    progressLabel: String?,
    onToggleLike: () -> Unit,
    onAddToPlaylist: () -> Unit,
    selected: Boolean,
    selectionMode: Boolean,
    onLongClick: () -> Unit,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .heightIn(min = if (item.type == MediaType.Image) 78.dp else 54.dp)
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f)
                else Color.Transparent,
                RoundedCornerShape(10.dp),
            )
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 12.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = (if (item.type == MediaType.Audio) Modifier.size(44.dp)
                else Modifier.width(78.dp).height(44.dp)).clip(RoundedCornerShape(6.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            if (thumbnailUrl != null) {
                AsyncImage(
                    model = thumbnailUrl,
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop,
                )
            } else {
                Text(item.displayTitle().take(1).uppercase(), fontSize = 22.sp, fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                item.displayTitle(),
                maxLines = if (item.type == MediaType.Image) 2 else 1,
                overflow = TextOverflow.Ellipsis,
                fontSize = 17.sp,
            )
            Text(
                buildString {
                    if (item.type == MediaType.Video && !progressLabel.isNullOrBlank()) {
                        append(progressLabel).append(" · ")
                    }
                    item.metadata.artist?.let { append(it).append(" · ") }
                    append(item.rootName)
                    append(" · ")
                    append(formatSize(item.sizeBytes))
                    append(" · ")
                    append(formatModified(item.modifiedAt))
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
            )
        }
        if (selectionMode) {
            Text(if (selected) "✓" else "○", modifier = Modifier.padding(horizontal = 18.dp), fontSize = 22.sp)
        } else if (item.type == MediaType.Audio) {
            TextButton(onClick = onToggleLike) {
                Text(
                    if (liked) "♥" else "♡",
                    fontSize = 21.sp,
                    color = if (liked) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun MuzioTopTabs(selectedTab: ScreenTab, onSelect: (ScreenTab) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        Surface(
            modifier = Modifier.widthIn(max = 370.dp),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
            shadowElevation = 1.dp,
        ) {
            Row(Modifier.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                ScreenTab.entries.forEach { tab ->
                    Box(
                        modifier = Modifier.weight(1f).clip(CircleShape)
                            .background(
                                if (tab == selectedTab) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f)
                                else Color.Transparent,
                            )
                            .clickable { onSelect(tab) }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            tab.label,
                            maxLines = 1,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (tab == selectedTab) MaterialTheme.colorScheme.onSurface
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun BoxScope.MobileLibraryMenu(
    selectedTab: ScreenTab,
    open: Boolean,
    customPlaylistNames: List<String>,
    queueAvailable: Boolean,
    onOpen: () -> Unit,
    onClose: () -> Unit,
    onOpenCollections: () -> Unit,
    onOpenQueue: () -> Unit,
    onRefresh: () -> Unit,
) {
    if (!open) {
        Surface(
            modifier = Modifier.align(Alignment.TopStart).padding(start = 40.dp, top = 220.dp)
                .width(32.dp).height(72.dp).clickable(onClick = onOpen),
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.09f),
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f),
            ),
            shadowElevation = 6.dp,
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 25.sp)
            }
        }
        return
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)).clickable(onClick = onClose),
    ) {
        Surface(
            modifier = Modifier.align(Alignment.CenterStart).padding(start = 8.dp, top = 172.dp, bottom = 8.dp)
                .fillMaxHeight().fillMaxWidth(0.84f).widthIn(max = 320.dp).clickable {},
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.97f),
            contentColor = MaterialTheme.colorScheme.onSurface,
            shadowElevation = 18.dp,
        ) {
            Column(Modifier.fillMaxSize().padding(18.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        selectedTab.label,
                        fontSize = 26.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    if (selectedTab == ScreenTab.Music || selectedTab == ScreenTab.Video) {
                        TextButton(onClick = onOpenCollections) { Text("Edit") }
                    }
                    TextButton(onClick = onClose) { Text("×", fontSize = 26.sp) }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.45f))
                val entries = when (selectedTab) {
                    ScreenTab.Music -> listOf("Liked Music", "Most Played") + customPlaylistNames
                    ScreenTab.Video -> listOf("Recently Watching") + customPlaylistNames
                    ScreenTab.Image -> listOf("Favorites", "Recently Added", "Screenshots", "Downloads")
                    ScreenTab.Settings -> listOf("Appearance", "Backend Status", "Media Folders", "Runtime Notes")
                }
                LazyColumn(Modifier.weight(1f).padding(top = 8.dp)) {
                    items(entries.distinct(), key = { it }) { title ->
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp))
                                .clickable {
                                    if (selectedTab == ScreenTab.Music || selectedTab == ScreenTab.Video) {
                                        onOpenCollections()
                                    } else {
                                        onClose()
                                    }
                                }
                                .padding(horizontal = 10.dp, vertical = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(title, fontSize = 17.sp, modifier = Modifier.weight(1f))
                            Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 22.sp)
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.45f))
                if (queueAvailable) {
                    TextButton(onClick = onOpenQueue, modifier = Modifier.fillMaxWidth()) { Text("Open Queue") }
                }
                if (selectedTab == ScreenTab.Music || selectedTab == ScreenTab.Video) {
                    TextButton(onClick = onOpenCollections, modifier = Modifier.fillMaxWidth()) {
                        Text("Create Playlist")
                    }
                }
                TextButton(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) { Text("Refresh Libraries") }
            }
        }
    }
}

@Composable
private fun SettingsScreen(
    profile: ServerProfile,
    profileStore: ProfileStore,
    libraryPreferencesStore: LibraryPreferencesStore,
    api: MuzioApi,
    onAppearanceChanged: (AppearanceSettings) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var displayName by remember { mutableStateOf(profile.displayName) }
    var baseUrl by remember { mutableStateOf(profile.baseUrl) }
    var healthMessage by remember { mutableStateOf("Not checked") }
    var busy by remember { mutableStateOf(false) }
    var serverSettingsBusy by remember { mutableStateOf(false) }
    var mediaRoots by remember { mutableStateOf<MediaRootsSettings?>(null) }
    var audioRoots by remember { mutableStateOf("") }
    var videoRoots by remember { mutableStateOf("") }
    var imageRoots by remember { mutableStateOf("") }
    var mediaRootsMessage by remember { mutableStateOf("") }
    var appearance by remember { mutableStateOf<AppearanceSettings?>(null) }
    var surfaceColor by remember { mutableStateOf("#1f1f1f") }
    var foregroundColor by remember { mutableStateOf("#ededed") }
    var mutedColor by remember { mutableStateOf("#aeaeae") }
    var accentColor by remember { mutableStateOf("#fa2d48") }
    var appearanceMessage by remember { mutableStateOf("") }
    var activityMessage by remember { mutableStateOf("") }
    val exportActivity = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/json"),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            activityMessage = runCatching {
                val json = libraryPreferencesStore.exportActivityJson()
                context.contentResolver.openOutputStream(uri, "wt")?.bufferedWriter()?.use { writer ->
                    writer.write(json)
                } ?: error("Could not open the selected document")
                "Activity exported"
            }.getOrElse { "Export failed · ${it.message}" }
        }
    }
    val importActivity = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            activityMessage = runCatching {
                val json = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                    ?: error("Could not open the selected document")
                val count = libraryPreferencesStore.importActivityJson(json)
                    ?: error("Unsupported activity document")
                "Activity imported · $count records"
            }.getOrElse { "Import failed · ${it.message}" }
        }
    }

    LaunchedEffect(profile) {
        displayName = profile.displayName
        baseUrl = profile.baseUrl
    }

    fun applyRoots(settings: MediaRootsSettings) {
        mediaRoots = settings
        audioRoots = settings.audioRoots.joinToString("\n")
        videoRoots = settings.videoRoots.joinToString("\n")
        imageRoots = settings.imageRoots.joinToString("\n")
    }

    fun applyAppearance(settings: AppearanceSettings) {
        appearance = settings
        surfaceColor = settings.surfaceColor
        foregroundColor = settings.foregroundColor
        mutedColor = settings.mutedColor
        accentColor = settings.accentColor
        onAppearanceChanged(settings)
    }

    fun persistAppearancePreset(settings: AppearanceSettings, label: String) {
        applyAppearance(settings)
        scope.launch {
            serverSettingsBusy = true
            runCatching { api.updateAppearance(baseUrl, settings) }
                .onSuccess {
                    applyAppearance(it)
                    appearanceMessage = "$label appearance saved"
                }
                .onFailure { appearanceMessage = "Save failed · ${it.message}" }
            serverSettingsBusy = false
        }
    }

    LaunchedEffect(profile.baseUrl) {
        if (profile.baseUrl.isBlank()) return@LaunchedEffect
        serverSettingsBusy = true
        runCatching { api.fetchMediaRoots(profile.baseUrl) }
            .onSuccess(::applyRoots)
            .onFailure { mediaRootsMessage = "Media folders unavailable · ${it.message}" }
        runCatching { api.fetchAppearance(profile.baseUrl) }
            .onSuccess(::applyAppearance)
            .onFailure { appearanceMessage = "Appearance unavailable · ${it.message}" }
        serverSettingsBusy = false
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "SETTINGS",
            color = MaterialTheme.colorScheme.primary,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text("Settings", fontSize = 48.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "Theme, backend health, media folders and Android runtime settings.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 14.sp,
        )
        Spacer(Modifier.height(10.dp))
        HorizontalDivider()
        Text("Backend Status", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "This Android profile can point to a Muzio server on your trusted private network.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 14.sp,
        )
        OutlinedTextField(
            value = displayName,
            onValueChange = { displayName = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Server name") },
            singleLine = true,
        )
        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Server URL") },
            supportingText = { Text("Example: http://100.x.x.x:7777") },
            singleLine = true,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                enabled = !busy,
                onClick = {
                    scope.launch {
                        busy = true
                        profileStore.save(ServerProfile(displayName, baseUrl))
                        healthMessage = "Saved"
                        busy = false
                    }
                },
            ) { Text("Save") }
            Button(
                enabled = !busy && baseUrl.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        healthMessage = try {
                            "Connected · ${api.health(baseUrl)}"
                        } catch (error: Exception) {
                            "Unavailable · ${error.message ?: "unknown error"}"
                        }
                        busy = false
                    }
                },
            ) { Text("Check connection") }
        }
        Text(healthMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        HorizontalDivider()
        Text("Appearance", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "Customize the app colors. Presets and custom colors are saved to the backend config.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 14.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                enabled = !serverSettingsBusy && baseUrl.isNotBlank(),
                onClick = {
                    persistAppearancePreset(
                        AppearanceSettings("#1f1f1f", "#ededed", "#aeaeae", "#fa2d48", true),
                        "Dark",
                    )
                },
            ) { Text("Dark") }
            OutlinedButton(
                enabled = !serverSettingsBusy && baseUrl.isNotBlank(),
                onClick = {
                    persistAppearancePreset(
                        AppearanceSettings("#ffffff", "#09090b", "#71717a", "#fa2d48", true),
                        "Light",
                    )
                },
            ) { Text("Light") }
        }
        SettingsValueField("Surface", surfaceColor) { surfaceColor = it }
        SettingsValueField("Foreground", foregroundColor) { foregroundColor = it }
        SettingsValueField("Muted", mutedColor) { mutedColor = it }
        SettingsValueField("Accent", accentColor) { accentColor = it }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                enabled = !serverSettingsBusy && baseUrl.isNotBlank(),
                onClick = {
                    scope.launch {
                        serverSettingsBusy = true
                        val draft = AppearanceSettings(
                            surfaceColor,
                            foregroundColor,
                            mutedColor,
                            accentColor,
                            appearance?.persisted ?: false,
                        )
                        runCatching { api.updateAppearance(baseUrl, draft) }
                            .onSuccess {
                                applyAppearance(it)
                                appearanceMessage = "Appearance saved"
                            }
                            .onFailure { appearanceMessage = "Save failed · ${it.message}" }
                        serverSettingsBusy = false
                    }
                },
            ) { Text("Save appearance") }
            TextButton(
                enabled = !serverSettingsBusy && baseUrl.isNotBlank(),
                onClick = {
                    scope.launch {
                        serverSettingsBusy = true
                        runCatching { api.resetAppearance(baseUrl) }
                            .onSuccess {
                                applyAppearance(it)
                                appearanceMessage = "Appearance reset"
                            }
                            .onFailure { appearanceMessage = "Reset failed · ${it.message}" }
                        serverSettingsBusy = false
                    }
                },
            ) { Text("Reset") }
        }
        Text(appearanceMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider()
        Text("Media Folders", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Text("Enter one absolute path per line.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        SettingsPathField("Music folders", audioRoots) { audioRoots = it }
        SettingsPathField("Video folders", videoRoots) { videoRoots = it }
        SettingsPathField("Image folders", imageRoots) { imageRoots = it }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                enabled = !serverSettingsBusy && baseUrl.isNotBlank(),
                onClick = {
                    scope.launch {
                        serverSettingsBusy = true
                        runCatching {
                            api.updateMediaRoots(
                                baseUrl,
                                audioRoots.toRootList(),
                                videoRoots.toRootList(),
                                imageRoots.toRootList(),
                            )
                        }.onSuccess {
                            applyRoots(it)
                            mediaRootsMessage = "Media folders saved · ${it.itemCount ?: 0} items"
                        }.onFailure { mediaRootsMessage = "Save failed · ${it.message}" }
                        serverSettingsBusy = false
                    }
                },
            ) { Text("Save folders") }
            Button(
                enabled = !serverSettingsBusy && baseUrl.isNotBlank(),
                onClick = {
                    scope.launch {
                        serverSettingsBusy = true
                        runCatching { api.refreshMediaRoots(baseUrl) }
                            .onSuccess {
                                applyRoots(it)
                                mediaRootsMessage = "Refreshed · ${it.itemCount ?: 0} items"
                            }
                            .onFailure { mediaRootsMessage = "Refresh failed · ${it.message}" }
                        serverSettingsBusy = false
                    }
                },
            ) { Text("Refresh index") }
        }
        mediaRoots?.let { settings ->
            Text(
                buildString {
                    append(if (settings.persistent) "Persistent" else "Temporary")
                    append(" · index ")
                    append(if (settings.index.enabled) "on" else "off")
                    append(" (${settings.index.loadedItems})")
                    settings.index.lastVerifiedAt?.let { append(" · verified ").append(it) }
                    append(" · watcher ")
                    append(if (settings.watcher.enabled) "on" else "off")
                    settings.watcher.backend?.let { append(" · ").append(it) }
                    if (settings.degradedRoots.isNotEmpty()) {
                        append(" · ${settings.degradedRoots.size} degraded")
                    }
                },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            settings.index.lastError?.let { Text("Index: $it", color = MaterialTheme.colorScheme.error) }
            settings.watcher.lastError?.let { Text("Watcher: $it", color = MaterialTheme.colorScheme.error) }
            settings.degradedRoots.forEach { root ->
                Text(
                    "Kept last known files for ${root.path} (${root.error})",
                    color = MaterialTheme.colorScheme.error,
                )
            }
            settings.watcher.roots.filterNot { it.enabled }.forEach { root ->
                Text(
                    buildString {
                        append("Manual refresh required for ").append(root.path)
                        root.reason?.let { append(" (").append(it).append(")") }
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(mediaRootsMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider()
        Text("Playback Activity", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "Move play counts, recent activity and resume data between the web and Android apps.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = { exportActivity.launch("muzio-playback-activity.json") }) {
                Text("Export activity")
            }
            Button(onClick = { importActivity.launch(arrayOf("application/json", "text/plain")) }) {
                Text("Import activity")
            }
        }
        Text(activityMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider()
        Text("Muzio Android ${BuildConfig.VERSION_NAME}")
        Text(
            "Native baseline restored from the 1.0.2 app. Library, media playback, image viewing and server profiles use the current 1.3.13 backend contract.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SettingsValueField(label: String, value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
    )
}

@Composable
private fun SettingsPathField(label: String, value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        minLines = 2,
        maxLines = 4,
    )
}

private fun String.toRootList(): List<String> = lineSequence()
    .map(String::trim)
    .filter(String::isNotBlank)
    .distinct()
    .toList()

@Composable
private fun EmptyProfileScreen(onOpenSettings: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Connect a Muzio server", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text("Add the backend URL to load your library.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(18.dp))
        Button(onClick = onOpenSettings) { Text("Open settings") }
    }
}

@Composable
private fun ErrorPanel(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Library unavailable", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(16.dp))
        Button(onClick = onRetry) { Text("Retry") }
    }
}

@Composable
private fun MiniPlayer(
    item: LibraryItem,
    player: Player,
    artworkUrl: String?,
    isPlaying: Boolean,
    fallbackDurationMs: Long,
    onExpand: () -> Unit,
    onPlayPause: () -> Unit,
    onQueue: () -> Unit,
    onTimer: () -> Unit,
    onVolume: () -> Unit,
) {
    var positionMs by remember(item.id) { mutableStateOf(player.currentPosition.coerceAtLeast(0L)) }
    var durationMs by remember(item.id) {
        mutableStateOf(player.duration.takeIf { it > 0L } ?: fallbackDurationMs)
    }
    val durationKnown = durationMs > 0L
    LaunchedEffect(player, item.id, isPlaying) {
        do {
            positionMs = player.currentPosition.coerceAtLeast(0L)
            durationMs = player.duration.takeIf { it > 0L } ?: fallbackDurationMs
            if (isPlaying) delay(500)
        } while (isPlaying)
    }
    val shape = RoundedCornerShape(16.dp)
    Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
        Surface(
            modifier = Modifier.fillMaxWidth().border(
                1.dp,
                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f),
                shape,
            ),
            shape = shape,
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
            tonalElevation = 8.dp,
            shadowElevation = 10.dp,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier.size(48.dp).clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .clickable(onClick = onExpand),
                    contentAlignment = Alignment.Center,
                ) {
                    if (artworkUrl != null) {
                        AsyncImage(
                            model = artworkUrl,
                            contentDescription = null,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop,
                        )
                    } else {
                        Text("♫", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.width(10.dp))
                Column(modifier = Modifier.weight(1f).clickable(onClick = onExpand)) {
                    Text(
                        item.displayTitle(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "${formatMiniTime(positionMs)} : ${if (durationKnown) formatMiniTime(durationMs) else "--:--"}",
                        maxLines = 1,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 12.sp,
                    )
                    Slider(
                        value = if (durationKnown) positionMs.coerceAtMost(durationMs).toFloat() else 0f,
                        onValueChange = { positionMs = it.toLong() },
                        onValueChangeFinished = { player.seekTo(positionMs) },
                        valueRange = 0f..durationMs.coerceAtLeast(1L).toFloat(),
                        enabled = durationKnown,
                        modifier = Modifier.fillMaxWidth().height(16.dp),
                    )
                }
                TextButton(onClick = onQueue, modifier = Modifier.width(42.dp)) {
                    Text("☷", fontSize = 22.sp)
                }
                TextButton(onClick = onTimer, modifier = Modifier.width(42.dp)) {
                    Text("◷", fontSize = 22.sp)
                }
                TextButton(onClick = onVolume, modifier = Modifier.width(42.dp)) {
                    Text("◉", fontSize = 19.sp)
                }
                TextButton(onClick = onPlayPause, modifier = Modifier.width(42.dp)) {
                    Text(if (isPlaying) "Ⅱ" else "▶", fontSize = 21.sp)
                }
            }
        }
    }
}

private fun formatMiniTime(milliseconds: Long): String {
    val totalSeconds = (milliseconds.coerceAtLeast(0L) / 1000L)
    val minutes = totalSeconds / 60L
    val seconds = totalSeconds % 60L
    return "%d:%02d".format(Locale.ROOT, minutes, seconds)
}

@Composable
private fun FullscreenViewer(
    item: LibraryItem,
    onClose: () -> Unit,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxSize().verticalDismissGesture(onClose),
        color = Color.Black,
    ) {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onClose) { Text("⌄", fontSize = 30.sp, color = Color.White) }
                Text(
                    item.displayTitle(),
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                )
                Spacer(Modifier.width(64.dp))
            }
            Box(
                Modifier.fillMaxWidth().weight(1f).padding(vertical = 12.dp)
                    .clip(RoundedCornerShape(16.dp)),
            ) {
                content()
            }
            Text(
                "${item.rootName} · ${item.relativePath}",
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                fontSize = 13.sp,
                color = Color.White.copy(alpha = 0.6f),
            )
        }
    }
}

private fun formatSize(bytes: Long): String {
    val kib = 1024.0
    val mib = kib * 1024.0
    val gib = mib * 1024.0
    return when {
        bytes < kib -> "$bytes B"
        bytes < mib -> String.format(Locale.ROOT, "%.1f KiB", bytes / kib)
        bytes < gib -> String.format(Locale.ROOT, "%.1f MiB", bytes / mib)
        else -> String.format(Locale.ROOT, "%.2f GiB", bytes / gib)
    }
}

private fun formatModified(value: String): String = runCatching {
    java.time.format.DateTimeFormatter.ofPattern("M/d/yyyy")
        .withZone(java.time.ZoneId.systemDefault())
        .format(java.time.Instant.parse(value))
}.getOrDefault(value.take(10))
