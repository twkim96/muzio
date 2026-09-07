import Foundation

@main struct NativeVideoPlaybackStateTests {
    static func main() {
        let state = NativeVideoPlaybackState()
        state.requestPlay(true)
        let forward = state.beginSeek()
        let transientPause = state.captureObservation()
        state.observePlaying(false, observation: transientPause)
        precondition(state.wantsPlay && state.seeking, "Seek pause must not become a web pause")
        state.finishSeek(forward)
        state.observePlaying(false, observation: transientPause)
        precondition(state.wantsPlay && !state.seeking, "Delayed seek KVO must not erase resume intent")

        let next = state.beginSeek()
        state.requestPlay(false)
        precondition(!state.wantsPlay, "Explicit pause during seek must win")
        state.finishSeek(next)
        precondition(!state.wantsPlay && !state.seeking)

        state.requestPlay(true)
        let oldSeek = state.beginSeek()
        let reverseSeek = state.beginSeek()
        state.finishSeek(oldSeek)
        precondition(state.seeking && !state.isCurrentSeek(oldSeek) && state.isCurrentSeek(reverseSeek), "Older seek completion must not finish latest opposite seek")
        state.finishSeek(reverseSeek)
        precondition(state.wantsPlay && !state.seeking)

        let pipPause = state.captureObservation()
        state.observePlaying(false, observation: pipPause)
        precondition(!state.wantsPlay, "PiP pause outside seek must synchronize")
        let stalePiP = state.captureObservation()
        state.requestPlay(true)
        state.observePlaying(false, observation: stalePiP)
        precondition(state.wantsPlay, "New play command must beat queued pause observation")
        let older = state.captureObservation()
        let newer = state.captureObservation()
        state.observePlaying(true, observation: newer)
        state.observePlaying(false, observation: older)
        precondition(state.wantsPlay, "Out-of-order observation delivery must keep latest state")

        let replaced = state.beginSeek()
        state.reset()
        state.finishSeek(replaced)
        precondition(!state.wantsPlay && !state.seeking && !state.isCurrentSeek(replaced), "Source replacement must invalidate old completions")
        print("Native video playback intent regressions passed")
    }
}
