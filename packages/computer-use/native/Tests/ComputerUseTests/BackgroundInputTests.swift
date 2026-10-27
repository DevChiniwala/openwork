import XCTest
@testable import ComputerUse

final class BackgroundInputTests: XCTestCase {
    func testOnlyControlSessionsOnASupportedMacWorkInTheBackground() {
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: true, mode: .control, bundleID: "com.apple.TextEdit"), .background)
        XCTAssertEqual(InputDelivery.decide(enabled: false, available: true, mode: .control, bundleID: "com.apple.TextEdit"), .foreground)
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: false, mode: .control, bundleID: "com.apple.TextEdit"), .foreground,
            "a macOS without the private calls keeps the front")
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: true, mode: .assist, bundleID: "com.apple.TextEdit"), .foreground)
    }

    func testCanvasAppsKeepTheFront() {
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: true, mode: .control, bundleID: "org.blenderfoundation.blender"), .foreground)
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: true, mode: .control, bundleID: "com.unity3d.UnityEditor5.x"), .foreground)
        XCTAssertEqual(InputDelivery.decide(enabled: true, available: true, mode: .control, bundleID: "com.google.Chrome"), .background)
    }

    func testFocusRecordsActivateThenMakeTheWindowKey() {
        let records = BackgroundFocus.records(window: 0x0102_0304)
        XCTAssertEqual(records.count, 3)
        for record in records {
            XCTAssertEqual(record.count, 0xF8)
            XCTAssertEqual(record[0x04], 0xF8)
            XCTAssertEqual(Array(record[0x3C..<0x40]), [0x04, 0x03, 0x02, 0x01], "the window id is little-endian at 0x3C")
        }
        XCTAssertEqual(records.map { $0[0x08] }, [0x0D, 0x01, 0x02])
        XCTAssertEqual(records[0][0x8A], 0x01)
        XCTAssertTrue(records[0][0x20..<0x30].allSatisfy { $0 == 0 })
        for key in records.dropFirst() {
            XCTAssertEqual(key[0x3A], 0x10)
            XCTAssertTrue(key[0x20..<0x30].allSatisfy { $0 == 0xFF })
        }
    }

    func testAutomaticImagesOnlyWhenTheTreeIsTooThin() {
        XCTAssertFalse(ImagePolicy.include(requested: nil, automatic: true, namedControls: ImagePolicy.enoughControls))
        XCTAssertTrue(ImagePolicy.include(requested: nil, automatic: true, namedControls: ImagePolicy.enoughControls - 1))
        XCTAssertTrue(ImagePolicy.include(requested: nil, automatic: false, namedControls: 100), "foreground sessions keep today's default")
        XCTAssertTrue(ImagePolicy.include(requested: true, automatic: true, namedControls: 100))
        XCTAssertFalse(ImagePolicy.include(requested: false, automatic: false, namedControls: 0))
    }

    func testObservationLeavesTheImageToTheSessionUnlessAsked() throws {
        XCTAssertNil(try ObservationOptions(["session_id": "s"], policy: .embedded).image)
        XCTAssertEqual(try ObservationOptions(["session_id": "s", "include_image": false], policy: .embedded).image, false)
        XCTAssertEqual(try ObservationOptions(["session_id": "s", "elements": "none"], policy: .embedded).image, true,
            "a request for no elements still gets the picture")
        XCTAssertThrowsError(try ObservationOptions(["session_id": "s", "include_image": false, "elements": "none"], policy: .embedded))
    }

    func testDesktopChangesNameWhatThePersonWouldNotice() {
        let before = DesktopState(frontPID: 10, cursor: CGPoint(x: 100, y: 100), space: 2)
        let still = before.changes(to: DesktopState(frontPID: 10, cursor: CGPoint(x: 100.2, y: 100), space: 2))
        XCTAssertEqual(still["front_app_changed"] as? Bool, false)
        XCTAssertEqual(still["cursor_moved"] as? Bool, false)
        XCTAssertEqual(still["space_changed"] as? Bool, false)
        let moved = before.changes(to: DesktopState(frontPID: 11, cursor: CGPoint(x: 140, y: 100), space: 3))
        XCTAssertEqual(moved["front_app_changed"] as? Bool, true)
        XCTAssertEqual(moved["cursor_moved"] as? Bool, true)
        XCTAssertEqual(moved["space_changed"] as? Bool, true)
    }
}
