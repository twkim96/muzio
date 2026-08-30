package com.twkim.videiomusic.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.twkim.videiomusic.data.LibraryItem
import com.twkim.videiomusic.data.LibraryPreferences
import com.twkim.videiomusic.data.PlaylistRecord
import com.twkim.videiomusic.data.contentKey
import com.twkim.videiomusic.data.displayTitle

@Composable
internal fun PlaylistPicker(
    items: List<LibraryItem>,
    playlists: List<PlaylistRecord>,
    onAdd: (String) -> Unit,
    onCreateAndAdd: (String) -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)
    var newPlaylistName by remember { mutableStateOf("") }
    Box(
        modifier = Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.62f))
            .clickable(onClick = onClose),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth().widthIn(max = 430.dp).padding(18.dp)
                .clickable {},
            shape = RoundedCornerShape(22.dp),
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 8.dp,
        ) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Add to Playlist", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            if (items.size == 1) items.first().displayTitle() else "${items.size} selected items",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = onClose) { Text("Close") }
                }
                if (playlists.isEmpty()) {
                    Text("No playlists yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    LazyColumn(modifier = Modifier.fillMaxWidth().weight(1f, fill = false)) {
                        items(playlists, key = PlaylistRecord::id) { playlist ->
                            Row(
                                Modifier.fillMaxWidth().clickable { onAdd(playlist.id) }
                                    .padding(vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(playlist.name, fontWeight = FontWeight.Medium)
                                    Text(
                                        "${playlist.contentKeys.size} items",
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Text("Add")
                            }
                            HorizontalDivider()
                        }
                    }
                }
                OutlinedTextField(
                    value = newPlaylistName,
                    onValueChange = { newPlaylistName = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("New playlist name") },
                    singleLine = true,
                )
                Button(
                    enabled = newPlaylistName.isNotBlank(),
                    onClick = { onCreateAndAdd(newPlaylistName) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Create and add") }
            }
        }
    }
}

@Composable
internal fun PlaylistBrowser(
    allItems: List<LibraryItem>,
    preferences: LibraryPreferences,
    onPlay: (LibraryItem, List<LibraryItem>) -> Unit,
    onCreate: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
    onRemove: (String, String) -> Unit,
    onToggleLike: (LibraryItem) -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)
    var selectedId by remember { mutableStateOf<String?>(null) }
    var newName by remember { mutableStateOf("") }
    val itemByKey = remember(allItems) { allItems.associateBy(LibraryItem::contentKey) }
    val entries = remember(allItems, preferences) {
        buildList {
            add(
                BrowserPlaylist(
                    id = LIKED_PLAYLIST_ID,
                    title = "Liked Music",
                    items = allItems.filter {
                        it.type.apiValue == "audio" && it.contentKey() in preferences.likedContentKeys
                    },
                    editable = false,
                ),
            )
            add(
                BrowserPlaylist(
                    id = MOST_PLAYED_ID,
                    title = "Most Played",
                    items = preferences.activityRecords
                        .filter { it.mediaType.apiValue == "audio" && it.playCount > 0 }
                        .sortedWith(compareByDescending<com.twkim.videiomusic.data.PlaybackActivityRecord> { it.playCount }
                            .thenByDescending { it.lastPlayedAt })
                        .take(50)
                        .mapNotNull { itemByKey[it.contentKey] },
                    editable = false,
                ),
            )
            add(
                BrowserPlaylist(
                    id = RECENTLY_WATCHING_ID,
                    title = "Recently Watching",
                    items = preferences.activityRecords
                        .filter { it.mediaType.apiValue == "video" && it.playCount > 0 }
                        .sortedByDescending { it.lastPlayedAt }
                        .take(50)
                        .mapNotNull { itemByKey[it.contentKey] },
                    editable = false,
                ),
            )
            preferences.playlists.forEach { playlist ->
                add(
                    BrowserPlaylist(
                        id = playlist.id,
                        title = playlist.name,
                        items = playlist.contentKeys.mapNotNull(itemByKey::get),
                        editable = true,
                    ),
                )
            }
        }
    }
    val selected = entries.firstOrNull { it.id == selectedId }

    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.3f)).clickable(onClick = onClose),
        contentAlignment = Alignment.CenterStart,
    ) {
        Surface(
            modifier = Modifier.fillMaxHeight().fillMaxWidth(0.88f).widthIn(max = 384.dp)
                .clickable {},
            color = Color(0xF2111113),
            contentColor = Color.White,
            shadowElevation = 18.dp,
        ) {
            Column(
                Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(
                    onClick = {
                        if (selectedId == null) onClose() else selectedId = null
                    },
                ) { Text(if (selectedId == null) "Close" else "Back") }
                Text(
                    selected?.title ?: "Playlists",
                    fontSize = 28.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Text("${selected?.items?.size ?: entries.size}")
            }
            HorizontalDivider()

            if (selected == null) {
                LazyColumn(Modifier.weight(1f)) {
                    items(entries, key = BrowserPlaylist::id) { entry ->
                        Row(
                            Modifier.fillMaxWidth().clickable { selectedId = entry.id }
                                .padding(vertical = 15.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(entry.title, fontSize = 18.sp, fontWeight = FontWeight.Medium)
                                Text(
                                    "${entry.items.size} items",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Text("›", fontSize = 26.sp)
                        }
                        HorizontalDivider()
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = newName,
                        onValueChange = { newName = it },
                        label = { Text("New playlist") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(
                        enabled = newName.isNotBlank(),
                        onClick = {
                            onCreate(newName)
                            newName = ""
                        },
                    ) { Text("Create") }
                }
            } else {
                if (selected.editable) {
                    var rename by remember(selected.id, selected.title) { mutableStateOf(selected.title) }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = rename,
                            onValueChange = { rename = it },
                            label = { Text("Playlist name") },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(
                            enabled = rename.isNotBlank() && rename != selected.title,
                            onClick = { onRename(selected.id, rename) },
                        ) { Text("Rename") }
                        TextButton(
                            onClick = {
                                onDelete(selected.id)
                                selectedId = null
                            },
                        ) { Text("Delete") }
                    }
                }
                if (selected.items.isEmpty()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("No items.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else {
                    LazyColumn(Modifier.fillMaxSize()) {
                        items(selected.items, key = LibraryItem::id) { item ->
                            Row(
                                Modifier.fillMaxWidth().clickable { onPlay(item, selected.items) }
                                    .padding(vertical = 11.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(item.displayTitle(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        item.metadata.artist ?: item.rootName,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                TextButton(
                                    onClick = {
                                        if (selected.id == LIKED_PLAYLIST_ID) onToggleLike(item)
                                        else if (selected.editable) onRemove(selected.id, item.contentKey())
                                    },
                                    enabled = selected.id == LIKED_PLAYLIST_ID || selected.editable,
                                ) { Text("Remove") }
                            }
                            HorizontalDivider()
                        }
                    }
                }
            }
            }
        }
    }
}

private data class BrowserPlaylist(
    val id: String,
    val title: String,
    val items: List<LibraryItem>,
    val editable: Boolean,
)

private const val LIKED_PLAYLIST_ID = "liked-music"
private const val MOST_PLAYED_ID = "most-played"
private const val RECENTLY_WATCHING_ID = "recently-watching"
