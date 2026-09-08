package com.twkim.videiomusic.web

import android.content.pm.ActivityInfo
import android.view.WindowManager
import androidx.core.view.WindowInsetsControllerCompat

internal data class WebWindowState(
    val orientation: Int,
    val barsBehavior: Int,
    val statusBarVisible: Boolean,
    val navigationBarVisible: Boolean,
    val cutoutMode: Int,
)

/** One custom-view session owns the window and restores its original state once. */
internal class WebFullscreenWindow(
    private val capture: () -> WebWindowState,
    private val apply: (WebWindowState) -> Unit,
) {
    private var previous: WebWindowState? = null

    fun enter(inPip: Boolean = false) {
        if (previous != null) return
        previous = capture()
        refresh(inPip)
    }

    fun refresh(inPip: Boolean) {
        val saved = previous ?: return
        if (inPip) return
        apply(saved.copy(
            orientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
            barsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE,
            statusBarVisible = false,
            navigationBarVisible = false,
            cutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
        ))
    }

    fun exit() {
        val saved = previous ?: return
        // A restore may synchronously trigger another fullscreen callback.
        previous = null
        apply(saved)
    }
}
