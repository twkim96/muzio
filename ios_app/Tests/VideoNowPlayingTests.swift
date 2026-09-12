import Foundation
import MediaPlayer

@MainActor
func testVideoNowPlaying() throws {
    var state: [String: Any] = ["generation": "current", "playing": false, "positionSec": 42.0, "durationSec": 120.0, "rate": 1.0]
    var commands: [(String, [String: Any])] = []
    let controls = VideoNowPlaying(read: { state }, command: { commands.append(($0, $1)) })
    func check(_ value: Bool, _ message: String) throws {
        if !value { throw NSError(domain: "VideoNowPlayingTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    controls.acquire(title: "Resume video")
    defer { controls.relinquish() }
    let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
    try check(info?[MPMediaItemPropertyTitle] as? String == "Resume video", "video title")
    try check((info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue == 42, "saved position")
    controls.perform("play")
    try check(commands.last?.0 == "video.play", "remote play")
    state["playing"] = true
    controls.perform("toggle")
    try check(commands.last?.0 == "video.pause", "remote toggle")
    controls.perform("forward")
    try check(commands.last?.1["positionSec"] as? Double == 52, "skip forward")
    controls.perform("backward")
    try check(commands.last?.1["positionSec"] as? Double == 32, "skip backward")
    controls.perform("seek", position: 200)
    try check(commands.last?.1["positionSec"] as? Double == 120, "bounded seek")
    let count = commands.count
    controls.perform("seek", position: .nan)
    try check(commands.count == count, "invalid position")
    controls.relinquish()
    controls.perform("play")
    try check(commands.count == count, "released video must not receive music commands")
    state["generation"] = "replacement"
    controls.acquire(title: "Next video")
    controls.perform("pause")
    try check(commands.last?.1["generation"] as? String == "replacement", "current source command")
    print("Video Now Playing command and ownership regressions passed")
}
