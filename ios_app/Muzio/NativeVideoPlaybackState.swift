import Foundation

/// KVO can arrive off-main and be delivered to the UI after a newer command.
/// Capture its epoch at observation time, rather than reading player state later.
final class NativeVideoPlaybackState: @unchecked Sendable {
    struct Observation: Sendable {
        fileprivate let revision: Int
        fileprivate let duringSeek: Bool
        fileprivate let sequence: Int
    }
    private let lock = NSLock()
    private var revision = 0
    private var seekRevision = 0
    private var observationSequence = 0
    private var requestedPlay = false
    private var activeSeek = false

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }; return body()
    }
    var wantsPlay: Bool { locked { requestedPlay } }
    var seeking: Bool { locked { activeSeek } }
    func requestPlay(_ value: Bool) {
        locked { revision += 1; requestedPlay = value }
    }
    func reset() {
        locked { revision += 1; seekRevision += 1; requestedPlay = false; activeSeek = false }
    }
    @discardableResult func beginSeek() -> Int {
        locked { revision += 1; seekRevision += 1; activeSeek = true; return seekRevision }
    }
    func isCurrentSeek(_ token: Int) -> Bool { locked { activeSeek && seekRevision == token } }
    func finishSeek(_ token: Int) {
        locked {
            guard activeSeek && seekRevision == token else { return }
            revision += 1; activeSeek = false
        }
    }
    func captureObservation() -> Observation {
        locked {
            observationSequence += 1
            return Observation(revision: revision, duringSeek: activeSeek, sequence: observationSequence)
        }
    }
    func observePlaying(_ playing: Bool, observation: Observation) {
        locked {
            guard observation.revision == revision, observation.sequence == observationSequence, !observation.duringSeek, !activeSeek else { return }
            requestedPlay = playing
        }
    }
}
