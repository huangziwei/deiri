// Drag-out file promises for the MTP browser.
//
// Drag-out from a WKWebView to Finder is not something WKWebView does on its
// own — HTML5 dragstart events don't bridge to NSFilePromiseProvider. We
// work around it by:
//
//   1. The frontend calls `filepromise_arm` from `mousedown` on a row,
//      stashing (objectPath, suggestedName, sizeBytes) into a pending slot.
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

private struct PendingDrag {
    let objectPath: String
    let suggestedName: String
    let sizeBytes: UInt64
}

private final class FilePromiseState {
    static let shared = FilePromiseState()
    var resolver: ResolverFn?
    var userCtx: UnsafeRawPointer?
    var pending: PendingDrag?
    var monitor: Any?
    var mouseDownEvent: NSEvent?
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
    resolver: ResolverFn
) {
    let state = FilePromiseState.shared
    state.userCtx = userCtx
    state.resolver = resolver

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
    sizeBytes: UInt64
) {
    FilePromiseState.shared.pending = PendingDrag(
        objectPath: String(cString: objectPath),
        suggestedName: String(cString: suggestedName),
        sizeBytes: sizeBytes
    )
}

@_cdecl("filepromise_cancel")
public func filepromise_cancel() {
    FilePromiseState.shared.pending = nil
}

// MARK: - Drag start

private func startDrag(view: NSView, downEvent: NSEvent, payload: PendingDrag) {
    let ext = (payload.suggestedName as NSString).pathExtension
    let uti = UTType(filenameExtension: ext) ?? UTType.data

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

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        NSLog("[filepromise] dragSource.endedAt %@ op=%lu", NSStringFromPoint(screenPoint), operation.rawValue)
        // Drop strong refs to the delegates that backed this session. We
        // only run one drag at a time, so clearing all is safe; if we ever
        // support multi-item drags we'd need per-session tracking.
        FilePromiseState.shared.activeDelegates.removeAll()
    }
}
