import XCTest
@testable import ComputerUse

final class SharedDesktopTests: XCTestCase {
    func testPersonIdleComesFromTheirOwnInput() {
        XCTAssertEqual(SharedDesktop.personIdle(secondsSinceInput: 3, buttonDown: false, now: 100, agentPostedAt: nil), 3)
        // A held button is a person mid-click or mid-drag.
        XCTAssertEqual(SharedDesktop.personIdle(secondsSinceInput: 30, buttonDown: true, now: 100, agentPostedAt: nil), 0)
        // Input landing right after the agent's own post is the agent's.
        XCTAssertEqual(SharedDesktop.personIdle(secondsSinceInput: 0.2, buttonDown: false, now: 100, agentPostedAt: 99.79), .infinity)
        // Input clearly after the agent's post, or before it, is the person's.
        XCTAssertEqual(SharedDesktop.personIdle(secondsSinceInput: 0.2, buttonDown: false, now: 100, agentPostedAt: 99.5), 0.2)
        XCTAssertEqual(SharedDesktop.personIdle(secondsSinceInput: 0.2, buttonDown: false, now: 100, agentPostedAt: 99.9), 0.2)
    }

    @MainActor
    func testIdlePersonDoesNotDelayTheAgent() async throws {
        var events: [String] = []
        let waited = try await SharedDesktop.waitForPerson(idle: { 5 }, now: { 0 }, check: {
            events.append("check")
        }, waiting: {
            events.append("waiting")
        }, sleep: { _ in events.append("sleep") })
        XCTAssertFalse(waited)
        XCTAssertEqual(events, ["check"])
    }

    @MainActor
    func testAgentWaitsUntilThePersonPauses() async throws {
        var clock: TimeInterval = 0
        var lastInput: TimeInterval = 0
        var waitingShown = 0
        let waited = try await SharedDesktop.waitForPerson(idle: { clock - lastInput }, now: { clock }, check: {
            // The person keeps moving the mouse for the first second.
            if clock < 1 { lastInput = clock }
        }, waiting: {
            waitingShown += 1
        }, sleep: { clock += $0 })
        XCTAssertTrue(waited)
        XCTAssertEqual(waitingShown, 1)
        XCTAssertGreaterThanOrEqual(clock - lastInput, SharedDesktop.quiet)
        XCTAssertLessThan(clock, 2)
    }

    @MainActor
    func testBusyPersonGetsPriorityAndTheModelLooksAgainLater() async throws {
        var clock: TimeInterval = 0
        do {
            _ = try await SharedDesktop.waitForPerson(idle: { 0 }, now: { clock }, check: {}, waiting: {}, sleep: { clock += $0 })
            XCTFail("The agent acted while the person kept working")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "person_active")
            XCTAssertEqual(error.next, "observe")
            XCTAssertGreaterThanOrEqual(clock, SharedDesktop.patience)
            XCTAssertLessThan(clock, SharedDesktop.patience + 0.5)
        }
    }

    @MainActor
    func testTakeOverWhileWaitingStopsTheWait() async throws {
        var clock: TimeInterval = 0
        do {
            _ = try await SharedDesktop.waitForPerson(idle: { 0 }, now: { clock }, check: {
                if clock > 0.2 { throw UseError("session_paused", "The person took over", next: "human_takeover") }
            }, waiting: {}, sleep: { clock += $0 })
            XCTFail("The wait outlived Take over")
        } catch let error as UseError {
            XCTAssertEqual(error.code, "session_paused")
        }
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
