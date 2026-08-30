package com.twkim.videiomusic.playback

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class PlaybackRuntimeState(
    val stopAfterCurrent: Boolean = false,
    val sleepTimerEndsAtMs: Long? = null,
    val sleepTimerRemainingSec: Int = 0,
    val sleepTimerExpired: Boolean = false,
    val volume: Float = 1f,
    val muted: Boolean = false,
)

/** Process-local command bridge to the service-owned playback policy. */
object PlaybackRuntime {
    private val mutableState = MutableStateFlow(PlaybackRuntimeState())
    val state: StateFlow<PlaybackRuntimeState> = mutableState.asStateFlow()

    internal var actions: PlaybackRuntimeActions? = null

    fun toggleStopAfterCurrent() = actions?.toggleStopAfterCurrent() ?: Unit

    fun startSleepTimer(minutes: Double) = actions?.startSleepTimer(minutes) ?: Unit

    fun cancelSleepTimer() = actions?.cancelSleepTimer() ?: Unit

    fun setVolume(volume: Float) = actions?.setVolume(volume) ?: Unit

    fun toggleMute() = actions?.toggleMute() ?: Unit

    internal fun update(transform: (PlaybackRuntimeState) -> PlaybackRuntimeState) {
        mutableState.value = transform(mutableState.value)
    }
}

internal interface PlaybackRuntimeActions {
    fun toggleStopAfterCurrent()
    fun startSleepTimer(minutes: Double)
    fun cancelSleepTimer()
    fun setVolume(volume: Float)
    fun toggleMute()
}
