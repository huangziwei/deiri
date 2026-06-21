// Drag-out file promises for the MTP browser.
//
// Drag-out from a WKWebView to Finder is not something WKWebView does on its
// own — HTML5 dragstart events don't bridge to NSFilePromiseProvider. We
// work around it by:
//
//   1. The frontend calls `filepromise_arm` from `mousedown` on a row,
//      stashing (objectPath, suggestedName, sizeBytes, isDir) into a pending
//      slot.
//   2. A process-local NSEvent monitor watches every left-mouse-down/dragged
//      in the app. When a `.leftMouseDragged` lands while a row is armed, we
//      start an NSDraggingSession on the event's window using a real
//      NSFilePromiseProvider — Finder accepts the drop and AppKit calls our
//      delegate's `writePromiseTo:` when the user releases.
//   3. The delegate calls back into Rust through the `ResolverFn` set during
//      `filepromise_install`. Rust does the MTP `download_to` and returns
//      success/failure; AppKit shows a copy progress sheet in Finder.
//
// Why an event monitor and not a WKWebView subclass: Tauri owns the WebView
// and we can't easily inject a custom WKWebView subclass without forking the
// Wry integration. The monitor is non-invasive and only fires when armed.

import AppKit
import Foundation
import UniformTypeIdentifiers

// MARK: - C ABI

public typealias ResolverFn = @convention(c) (
    UnsafePointer<CChar>?,   // objectPath (device-relative)
    UnsafePointer<CChar>?,   // destPosixPath (already URL-decoded by Swift)
    UnsafeRawPointer?        // userCtx (opaque — Rust may use a global instead)
) -> Bool

// Reports the live cursor position of an in-progress drag back to Rust (which
// re-emits it to JS). The drag is a native NSDraggingSession, so the WebView
// gets no DOM drag events — this is the only channel by which the breadcrumb
// can track the drag and accept an in-window drop. Coordinates are already
// converted to web client space (CSS px, top-left origin). `phase`: 1 = moved,
// 2 = ended in-window (no external destination took it), 0 = ended externally.
public typealias PositionFn = @convention(c) (
    UnsafePointer<CChar>?,   // objectPath (device-relative)
    Double,                  // x (web client coords)
    Double,                  // y (web client coords)
    Int32                    // phase
) -> Void

private struct PendingDrag {
    let objectPath: String
    let suggestedName: String
    let sizeBytes: UInt64
    // Folders need a directory UTI (`public.folder`) so Finder treats the
    // promise as a tree to populate, not a flat file. The Rust resolver's
    // `download_to` figures out file-vs-folder on the device side on its own;
    // this flag is only here so `startDrag` can pick the right UTI/icon.
    let isDir: Bool
}

private final class FilePromiseState {
    static let shared = FilePromiseState()
    var resolver: ResolverFn?
    var position: PositionFn?
    var userCtx: UnsafeRawPointer?
    var pending: PendingDrag?
    var monitor: Any?
    var mouseDownEvent: NSEvent?
    // Set when a drag session actually begins, so the source callbacks can
    // convert screen points to this window's web-client coordinates and tell
    // JS which object is in flight. Cleared in `endedAt`.
    var dragWindow: NSWindow?
    var dragObjectPath: String?
    // Last screen point we reported, to throttle the high-frequency `movedTo`
    // stream so we don't flood the IPC channel with sub-pixel jitter.
    var lastEmit: NSPoint?
    // NSFilePromiseProvider's `delegate` property is WEAK. Without a strong
    // reference here, ARC deallocates the delegate the moment `startDrag`
    // returns — AppKit then queries a nil delegate, gets no filename, and
    // silently aborts the drag (which is exactly what we observed: monitor
    // logs "beginDraggingSession" but no drag image appears and no
    // delegate callbacks fire). We pin delegates for the lifetime of their
    // session and release in `endedAt`.
    var activeDelegates: [PromiseDelegate] = []
}

@_cdecl("filepromise_install")
public func filepromise_install(
    userCtx: UnsafeRawPointer?,
    resolver: ResolverFn,
    position: PositionFn
) {
    let state = FilePromiseState.shared
    state.userCtx = userCtx
    state.resolver = resolver
    state.position = position

    if state.monitor != nil { return }

    state.monitor = NSEvent.addLocalMonitorForEvents(
        matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
    ) { event in
        let s = FilePromiseState.shared
        switch event.type {
        case .leftMouseDown:
            s.mouseDownEvent = event
        case .leftMouseDragged:
            if let pending = s.pending,
               let window = event.window {
                // hitTest the actual view at the cursor — that's the WKWebView,
                // not the bare contentView. Starting the drag from the wrong
                // view is the most plausible reason `beginDraggingSession`
                // looks like it succeeded (no error) but no drag image ever
                // appeared. AppKit's drag is rendered by the dragging source's
                // window, so the view passed in must be a real responder for
                // the event.
                let hitView = window.contentView?.hitTest(event.locationInWindow)
                guard let view = hitView ?? window.contentView else { break }

                // Consume so a second drag needs a fresh `arm` from JS.
                s.pending = nil
                // Use the dragged event itself, not the stored mouseDown.
                // AppKit accepts either; the dragged event is fresher and
                // its locationInWindow is where the drag image should appear.
                NSLog(
                    "[filepromise] beginDraggingSession from %@ for %@",
                    String(describing: type(of: view)),
                    pending.suggestedName
                )
                startDrag(view: view, downEvent: event, payload: pending)
            }
        case .leftMouseUp:
            s.mouseDownEvent = nil
            // Defensive: pending should only persist while the cursor is over
            // a row. Once the button comes up, any prior arm is moot — JS
            // will re-arm on the next mouseenter.
            s.pending = nil
        default:
            break
        }
        return event
    }
}

@_cdecl("filepromise_arm")
public func filepromise_arm(
    objectPath: UnsafePointer<CChar>,
    suggestedName: UnsafePointer<CChar>,
    sizeBytes: UInt64,
    isDir: Bool
) {
    FilePromiseState.shared.pending = PendingDrag(
        objectPath: String(cString: objectPath),
        suggestedName: String(cString: suggestedName),
        sizeBytes: sizeBytes,
        isDir: isDir
    )
}

@_cdecl("filepromise_cancel")
public func filepromise_cancel() {
    FilePromiseState.shared.pending = nil
}

// MARK: - Drag start

private func startDrag(view: NSView, downEvent: NSEvent, payload: PendingDrag) {
    let uti: UTType
    if payload.isDir {
        // public.folder — Finder makes a directory at the promise URL and our
        // resolver fills it via the recursive `download_folder`.
        uti = .folder
    } else {
        let ext = (payload.suggestedName as NSString).pathExtension
        uti = UTType(filenameExtension: ext) ?? UTType.data
    }

    // Remember the window + dragged object so the source callbacks can map
    // screen points into this WebView's client coordinates and tell JS which
    // object is moving. Cleared when the session ends.
    FilePromiseState.shared.dragWindow = view.window
    FilePromiseState.shared.dragObjectPath = payload.objectPath
    FilePromiseState.shared.lastEmit = nil

    let delegate = PromiseDelegate(payload: payload)
    // Strong-retain the delegate until the drag session ends — see comment
    // in FilePromiseState. The DragSource.endedAt callback drops it.
    FilePromiseState.shared.activeDelegates.append(delegate)

    let provider = NSFilePromiseProvider(
        fileType: uti.identifier,
        delegate: delegate
    )
    // Stash the device-side path on the provider so the delegate can read it
    // without holding the closure capture in two places.
    provider.userInfo = payload.objectPath

    let item = NSDraggingItem(pasteboardWriter: provider)
    let icon = NSWorkspace.shared.icon(for: uti)
    item.setDraggingFrame(
        NSRect(
            origin: NSPoint(
                x: downEvent.locationInWindow.x - 16,
                y: downEvent.locationInWindow.y - 16
            ),
            size: NSSize(width: 32, height: 32)
        ),
        contents: icon
    )

    view.beginDraggingSession(
        with: [item],
        event: downEvent,
        source: DragSource.shared
    )
}

// MARK: - In-window drag tracking

// Convert a drag screen point into the WebView's client coordinates (CSS px,
// top-left origin) and hand it to Rust via the position callback. No-op if no
// drag is active. `convertFromScreen(_:)` (NSRect form) is used instead of the
// macOS 14+ `convertPoint(fromScreen:)` so this compiles at the 11.0 Swift
// deployment target the build uses.
private func reportDragPosition(_ screenPoint: NSPoint, phase: Int32) {
    let s = FilePromiseState.shared
    guard let position = s.position,
          let window = s.dragWindow,
          let content = window.contentView,
          let path = s.dragObjectPath else { return }
    let winPoint = window.convertFromScreen(NSRect(origin: screenPoint, size: .zero)).origin
    let viewPoint = content.convert(winPoint, from: nil) // window → content view (bottom-left)
    let clientX = Double(viewPoint.x)
    let clientY = Double(content.bounds.height - viewPoint.y) // flip to top-left origin
    path.withCString { ptr in
        position(ptr, clientX, clientY, phase)
    }
}

// MARK: - Delegate

private final class PromiseDelegate: NSObject, NSFilePromiseProviderDelegate {
    let payload: PendingDrag

    init(payload: PendingDrag) {
        self.payload = payload
    }

    func filePromiseProvider(
        _ filePromiseProvider: NSFilePromiseProvider,
        fileNameForType fileType: String
    ) -> String {
        NSLog("[filepromise] delegate.fileNameForType called for %@", payload.suggestedName)
        return payload.suggestedName
    }

    func filePromiseProvider(
        _ filePromiseProvider: NSFilePromiseProvider,
        writePromiseTo url: URL,
        completionHandler: @escaping (Error?) -> Void
    ) {
        NSLog("[filepromise] delegate.writePromiseTo %@ for %@", url.path, payload.suggestedName)
        guard let resolver = FilePromiseState.shared.resolver else {
            completionHandler(NSError(
                domain: "filepromise",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "no Rust resolver registered"]
            ))
            return
        }

        // MTP download blocks on USB — keep it off the main queue so AppKit's
        // copy progress sheet remains responsive. Capture `payload` by value
        // up front so the closure doesn't need to retain `self`.
        let payload = self.payload
        DispatchQueue.global(qos: .userInitiated).async {
            let ok = payload.objectPath.withCString { pathPtr in
                url.path.withCString { destPtr in
                    resolver(pathPtr, destPtr, FilePromiseState.shared.userCtx)
                }
            }
            completionHandler(ok ? nil : NSError(
                domain: "filepromise",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "MTP download failed"]
            ))
        }
    }

    func operationQueue(
        for filePromiseProvider: NSFilePromiseProvider
    ) -> OperationQueue {
        Self.queue
    }

    private static let queue: OperationQueue = {
        let q = OperationQueue()
        q.qualityOfService = .userInitiated
        return q
    }()
}

private final class DragSource: NSObject, NSDraggingSource {
    static let shared = DragSource()

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        NSLog("[filepromise] dragSource.sourceOperationMaskFor context=%ld",
              context == .outsideApplication ? 0 : 1)
        // Always .copy — Finder respects this and the MTP side never deletes
        // the original. If we ever add "drag out then delete on device",
        // expose .move and check session.operationMask in the resolver.
        return .copy
    }

    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {
        NSLog("[filepromise] dragSource.willBeginAt %@", NSStringFromPoint(screenPoint))
    }

    func draggingSession(_ session: NSDraggingSession, movedTo screenPoint: NSPoint) {
        // Throttle: AppKit fires this continuously; skip sub-2pt jitter so we
        // don't flood the IPC channel. JS only needs enough resolution to
        // light up the crumb under the cursor.
        let s = FilePromiseState.shared
        if let last = s.lastEmit,
           abs(last.x - screenPoint.x) < 2, abs(last.y - screenPoint.y) < 2 {
            return
        }
        s.lastEmit = screenPoint
        reportDragPosition(screenPoint, phase: 1)
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        NSLog("[filepromise] dragSource.endedAt %@ op=%lu", NSStringFromPoint(screenPoint), operation.rawValue)
        // Always report the release as a candidate breadcrumb drop (phase 2)
        // and let JS decide by hit-testing the point against the crumbs. We
        // deliberately DON'T gate on `operation`: a drop on Finder lands
        // outside the window (no crumb there, so JS won't move), while a drop
        // on a crumb may report a non-empty operation if Wry's webview claims
        // the drag — gating on `operation` would wrongly suppress that move.
        reportDragPosition(screenPoint, phase: 2)

        // Drop strong refs to the delegates that backed this session and the
        // per-drag tracking state. We only run one drag at a time, so clearing
        // all is safe; multi-item drags would need per-session tracking.
        let s = FilePromiseState.shared
        s.activeDelegates.removeAll()
        s.dragWindow = nil
        s.dragObjectPath = nil
        s.lastEmit = nil
    }
}
