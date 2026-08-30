package com.twkim.videiomusic.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
internal fun Modifier.verticalDismissGesture(onDismiss: () -> Unit): Modifier {
    val scope = rememberCoroutineScope()
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    val offset = remember { Animatable(0f) }
    val thresholdFloor = with(LocalDensity.current) { 110.dp.toPx() }
    val thresholdCeiling = with(LocalDensity.current) { 180.dp.toPx() }
    var heightPx = remember { 0 }

    return this
        .onSizeChanged { heightPx = it.height }
        .graphicsLayer { translationY = offset.value }
        .pointerInput(Unit) {
            detectVerticalDragGestures(
                onVerticalDrag = { change, amount ->
                    val next = (offset.value + amount).coerceIn(0f, heightPx.toFloat())
                    if (next > 0f || amount > 0f) {
                        change.consume()
                        scope.launch { offset.snapTo(next) }
                    }
                },
                onDragCancel = {
                    scope.launch { offset.animateTo(0f, tween(200)) }
                },
                onDragEnd = {
                    val threshold = (heightPx * 0.16f).coerceIn(thresholdFloor, thresholdCeiling)
                    scope.launch {
                        if (offset.value > threshold) {
                            offset.animateTo(heightPx.toFloat(), tween(180))
                            currentOnDismiss()
                        } else {
                            offset.animateTo(0f, tween(200))
                        }
                    }
                },
            )
        }
}
