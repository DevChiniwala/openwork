import XCTest
@testable import ComputerUse

final class SharedDesktopTests: XCTestCase {
    func testOnlyThePersonsOwnInputCounts() {
        XCTAssertTrue(SharedDesktop.persons(inputAt: 99, agentPostedAt: nil))
        // Input landing right after the agent's own post is the agent's.
        XCTAssertFalse(SharedDesktop.persons(inputAt: 99.82, agentPostedAt: 99.8))
        // Input clearly after the agent's post, or before it, is the person's.
        XCTAssertTrue(SharedDesktop.persons(inputAt: 99.9, agentPostedAt: 99.8))
        XCTAssertTrue(SharedDesktop.persons(inputAt: 99.7, agentPostedAt: 99.8))
    }

    func testOnlyTypingOrAHeldButtonIsBusy() {
        XCTAssertTrue(SharedDesktop.personBusy(keyAt: 99.9, buttonDown: false, now: 100, agentPostedAt: nil))
        XCTAssertTrue(SharedDesktop.personBusy(keyAt: 0, buttonDown: true, now: 100, agentPostedAt: nil))
        XCTAssertFalse(SharedDesktop.personBusy(keyAt: 99, buttonDown: false, now: 100, agentPostedAt: nil))
        // The agent's own typing never holds it up.
        XCTAssertFalse(SharedDesktop.personBusy(keyAt: 99.95, buttonDown: false, now: 100, agentPostedAt: 99.94))
    }

    func testAClickOrKeyAfterTheMomentBeganInterruptsIt() {
        XCTAssertTrue(SharedDesktop.personInterrupted(inputAt: 10.3, since: 10, agentPostedAt: nil))
        XCTAssertFalse(SharedDesktop.personInterrupted(inputAt: 9.9, since: 10, agentPostedAt: nil))
        XCTAssertFalse(SharedDesktop.personInterrupted(inputAt: 10.31, since: 10, agentPostedAt: 10.3))
        XCTAssertEqual(SharedDesktop.interrupted.next, "observe")
    }

    @MainActor
    func testTheAgentGoesRightAwayWhenThePersonIsNotTyping() async throws {
        var events: [String] = []
        try await SharedDesktop.takeGap(busy: { false }, now: { 0 }, check: {
            events.append("check")
        }, sleep: { _ in events.append("sleep") })
        XCTAssertEqual(events, ["check"])
    }

    @MainActor
    func testTheAgentTakesTheNextGapInTyping() async throws {
        var clock: TimeInterval = 0
        try await SharedDesktop.takeGap(busy: { clock < 0.15 }, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertGreaterThanOrEqual(clock, 0.15)
        XCTAssertLessThan(clock, 0.25)
    }

    @MainActor
    func testNonstopTypingDelaysTheAgentAtMostHalfASecond() async throws {
        var clock: TimeInterval = 0
        try await SharedDesktop.takeGap(busy: { true }, now: { clock }, check: {}, sleep: { clock += $0 })
        XCTAssertGreaterThanOrEqual(clock, SharedDesktop.deferLimit)
        XCTAssertLessThan(clock, SharedDesktop.deferLimit + SharedDesktop.poll * 2)
    }

    @MainActor
    func testTakeOverWhileDeferringStopsTheStep() async throws {
        var clock: TimeInterval = 0
        do {
            try await SharedDesktop.takeGap(busy: { true }, now: { clock }, check: {
                if clock > 0.1 { throw UseError("session_paused", "The person took over", next: "human_takeover") }
            }, sleep: { clock += $0 })
            XCTFail("The step outlived Take over")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
        }
    }

    func testTheFrontGoesBackToTheAppThatHadIt() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, at: 10)
        // A second raise in the same moment does not replace who had the front.
        handBack.record(frontmost: 50, target: 7, own: 3, at: 11)
        XCTAssertEqual(handBack.take(frontmost: 7, target: 7, lastPersonInput: 9), 40)
        XCTAssertNil(handBack.pid)
        // The target itself and the helper are never handed the front.
        handBack.record(frontmost: 7, target: 7, own: 3, at: 12)
        handBack.record(frontmost: 3, target: 7, own: 3, at: 12)
        XCTAssertNil(handBack.pid)
    }

    func testAPersonWhoAlreadyMovedOnIsLeftWhereTheyAre() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, at: 10)
        XCTAssertNil(handBack.take(frontmost: 60, target: 7, lastPersonInput: 9))
        XCTAssertNil(handBack.pid)
        handBack.record(frontmost: 40, target: 7, own: 3, at: 10)
        handBack.forget()
        XCTAssertNil(handBack.take(frontmost: 7, target: 7, lastPersonInput: 9))
    }

    func testTypingInTheAgentsWindowKeepsTheFrontThere() {
        var handBack = SharedDesktop.HandBack()
        handBack.record(frontmost: 40, target: 7, own: 3, at: 10)
        // A key 20 ms after the agent's own post is filtered out of interrupts, but it
        // still keeps the front in the agent's window, so later keys stay there too.
        XCTAssertFalse(SharedDesktop.persons(inputAt: 10.52, agentPostedAt: 10.5))
        XCTAssertNil(handBack.take(frontmost: 7, target: 7, lastPersonInput: 10.52))
        XCTAssertNil(handBack.pid)
    }

    @MainActor
    func testWindowInFrontIsLeftAlone() async throws {
        var used = 0
        var focused = 0
        let refocused = try await SharedDesktop.returnFocus(used: &used, inFront: { true }, focus: { focused += 1 })
        XCTAssertFalse(refocused)
        XCTAssertEqual(used, 0)
        XCTAssertEqual(focused, 0)
    }

    @MainActor
    func testSwitchingAwayBringsTheWindowBackALimitedNumberOfTimes() async throws {
        var used = 0
        var focused = 0
        for _ in 0..<SharedDesktop.refocusLimit {
            let refocused = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: { focused += 1 })
            XCTAssertTrue(refocused)
        }
        do {
            _ = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: { focused += 1 })
            XCTFail("The agent kept taking the window back")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "focus_contested")
            XCTAssertEqual(error.next, "observe")
        }
        XCTAssertEqual(focused, SharedDesktop.refocusLimit)
    }

    @MainActor
    func testFocusThatDoesNotStickIsContestedNotATakeover() async throws {
        var used = 0
        do {
            _ = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: {
                throw UseError("window_not_frontmost", "Choose Continue", next: "human_takeover")
            })
            XCTFail("Focus that did not stick was reported as success")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "focus_contested")
            XCTAssertEqual(error.next, "observe")
        }
        // A closed or changed window still stops the step as before.
        do {
            _ = try await SharedDesktop.returnFocus(used: &used, inFront: { false }, focus: {
                throw UseError("window_unavailable", "Closed", next: "human_takeover")
            })
            XCTFail("A closed window was reported as focused")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "window_unavailable")
        }
    }

    func testAnotherWindowInFrontAsksTheModelToLookAgain() {
        let lost = SharedDesktop.yielding(UseError("window_not_frontmost", "Choose Continue", next: "human_takeover"))
        XCTAssertEqual(lost.code, "focus_lost")
        XCTAssertEqual(lost.next, "observe")
        let paused = SharedDesktop.yielding(UseError("session_paused", "Paused", next: "human_takeover"))
        XCTAssertEqual(paused.code, "session_paused")
        XCTAssertEqual(paused.next, "human_takeover")
        let other: Error = CancellationError()
        XCTAssertTrue(SharedDesktop.yielding(other) is CancellationError)
    }
}
