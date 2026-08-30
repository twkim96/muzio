package com.twkim.videiomusic

import android.Manifest
import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.twkim.videiomusic.data.MuzioApi
import com.twkim.videiomusic.data.AppearanceSettings
import com.twkim.videiomusic.data.LibraryPreferencesStore
import com.twkim.videiomusic.data.LibrarySnapshotStore
import com.twkim.videiomusic.data.ProfileStore
import com.twkim.videiomusic.playback.PlaybackService
import com.twkim.videiomusic.ui.MuzioApp
import com.twkim.videiomusic.ui.MuzioTheme

class MainActivity : ComponentActivity() {
    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val profileStore = ProfileStore(applicationContext)
        val libraryPreferencesStore = LibraryPreferencesStore(applicationContext)
        val librarySnapshotStore = LibrarySnapshotStore(applicationContext)
        val api = MuzioApi()

        setContent {
            var appearance by remember { mutableStateOf<AppearanceSettings?>(null) }
            MuzioTheme(appearance = appearance) {
                var controller by remember { mutableStateOf<MediaController?>(null) }
                DisposableEffect(Unit) {
                    val token = SessionToken(
                        applicationContext,
                        ComponentName(applicationContext, PlaybackService::class.java),
                    )
                    val future = MediaController.Builder(applicationContext, token).buildAsync()
                    future.addListener(
                        { controller = runCatching { future.get() }.getOrNull() },
                        ContextCompat.getMainExecutor(applicationContext),
                    )
                    onDispose {
                        controller = null
                        MediaController.releaseFuture(future)
                    }
                }

                controller?.let {
                    MuzioApp(
                        player = it,
                        profileStore = profileStore,
                        libraryPreferencesStore = libraryPreferencesStore,
                        librarySnapshotStore = librarySnapshotStore,
                        api = api,
                        onAppearanceChanged = { appearance = it },
                    )
                } ?: Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }

        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
