package com.twkim.videiomusic.web

import android.content.pm.ActivityInfo
import android.view.WindowManager
import androidx.core.view.WindowInsetsControllerCompat
import org.junit.Assert.*
import org.junit.Test

class WebFullscreenWindowTest {
    private val initial = WebWindowState(
        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
        WindowInsetsControllerCompat.BEHAVIOR_DEFAULT,
        statusBarVisible = true,
        navigationBarVisible = true,
        cutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT,
    )

    @Test fun fullscreenFillsLandscapeAndRepeatedEntryRestoresOriginalWindow() {
        var window = initial
        var captures = 0
        val session = WebFullscreenWindow({ captures++; window }, { window = it })
        repeat(2) {
            session.enter()
            assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, window.orientation)
            assertFalse(window.statusBarVisible)
            assertFalse(window.navigationBarVisible)
            assertEquals(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE, window.barsBehavior)
            assertEquals(WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES, window.cutoutMode)
        }
        assertEquals(1, captures)
        session.exit()
        assertEquals(initial, window)
        window = initial.copy(orientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, statusBarVisible = false)
        val secondOriginal = window
        session.exit() // A duplicate hide must not overwrite the newer window.
        assertEquals(secondOriginal, window)
        session.enter()
        session.exit()
        assertEquals(secondOriginal, window)
    }

    @Test fun pipDoesNotApplyFullscreenWindowUntilReturningToTheActivity() {
        var window = initial
        var changes = 0
        val session = WebFullscreenWindow({ window }, { window = it; changes++ })
        session.enter(inPip = true)
        session.refresh(inPip = true)
        assertEquals(0, changes)
        session.refresh(inPip = false)
        assertFalse(window.statusBarVisible)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, window.orientation)
        session.exit()
        assertEquals(initial, window)
        val afterExit = changes
        session.refresh(inPip = false) // Late PiP/focus callbacks cannot reopen it.
        assertEquals(afterExit, changes)
    }

    @Test fun reentrantHideRestoresExactlyOnce() {
        val changes = mutableListOf<WebWindowState>()
        lateinit var session: WebFullscreenWindow
        session = WebFullscreenWindow({ initial }, {
            changes += it
            if (it == initial) session.exit()
        })
        session.enter()
        session.exit()
        assertEquals(2, changes.size)
        assertEquals(initial, changes.last())
    }
}
