// Quick Look preview for device files.
//
// Space in the file list previews the selected file. The file lives on the MTP
// device, so the Rust side first pulls it to a local temp copy (shared with the
// open-with-default-app path) and hands us that local path; we drive the shared
// QLPreviewPanel with it. Pressing Space again on the same file toggles the
// panel closed, matching Finder.
//
// We set the panel's dataSource directly and order it front rather than going
// through the responder-chain control protocol (acceptsPreviewPanelControl:):
// Wry owns the WKWebView and its responder chain, and a single transient
// preview doesn't need focus-driven controller switching.
//
// The open panel takes key focus, so the WebView stops seeing key events — the
// arrow keys included, which is why the preview used to be stuck on whichever
// file opened it. We forward the arrows to Rust instead, which passes them to
// the frontend as `quicklook-key` events; JS moves the selection and asks for
// the next preview. Everything else — Space and Escape to dismiss, ⌘-shortcuts
// — is left to the panel.
//
// Two hooks catch those arrows, because which one AppKit uses isn't ours to
// decide: the panel's content is a remote view served by QuickLookUIService.xpc,
// so depending on the macOS version its key events may never enter our own event
// queue at all.
//   * `previewPanel:handleEvent:` — the panel handing back what it didn't
//     consume. The documented path, and the one that still works when the
//     events live in the service process.
//   * A process-local NSEvent monitor, the same mechanism the drag-out plugin
//     uses for the mouse, gated on the panel being the key window.
// They can't both fire for one keypress: the monitor runs first and swallows
// what it forwards, so the panel never sees it. Each logs which one acted.

import AppKit
import Quartz

/// Called with an arrow key name ("ArrowUp"…) the preview panel didn't consume.
public typealias QuickLookKeyFn = @convention(c) (UnsafePointer<CChar>) -> Void

final class QuickLookController: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    static let shared = QuickLookController()

    // Strongly held: QLPreviewPanel's dataSource/delegate are weak, and the URL
    // backs the single preview item.
    private var url: URL?
    private var keyCallback: QuickLookKeyFn?
    private var keyMonitor: Any?

    /// `toggle` is Space's "press it again to dismiss" — only that path may
    /// close the panel. Arrow navigation passes false, so stepping back onto
    /// the file already showing re-previews it instead of dismissing.
    func show(path: String, toggle: Bool) {
        guard let panel = QLPreviewPanel.shared() else { return }
        let target = URL(fileURLWithPath: path)
        if toggle, panel.isVisible, url == target {
            panel.orderOut(nil)
            return
        }
        url = target
        panel.dataSource = self
        panel.delegate = self
        if panel.isVisible {
            panel.reloadData()
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    /// True while the panel is on screen — including when the user has clicked
    /// back into the app window, where the WebView gets the arrow keys itself
    /// and has to ask whether a preview is still up there to follow along.
    func isPanelVisible() -> Bool {
        QLPreviewPanel.sharedPreviewPanelExists() && (QLPreviewPanel.shared()?.isVisible ?? false)
    }

    func installKeyHooks(callback: @escaping QuickLookKeyFn) {
        keyCallback = callback
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            QuickLookController.shared.handleMonitoredKey(event)
        }
    }

    /// The key name to forward for `event`, or nil to leave it alone.
    ///
    /// Only the four held modifiers are worth testing: AppKit reports arrow keys
    /// with `.function` and `.numericPad` already set, so the whole
    /// device-independent mask is never empty for one. A *held* modifier does
    /// mean something else in the list — ⌘↓ opens, ⇧↓ extends a selection — and
    /// neither applies while previewing.
    private func arrowName(_ event: NSEvent) -> String? {
        guard event.type == .keyDown else { return nil }
        let held: NSEvent.ModifierFlags = [.command, .shift, .option, .control]
        guard event.modifierFlags.intersection(held).isEmpty else { return nil }
        switch event.keyCode {
        case 125: return "ArrowDown"
        case 126: return "ArrowUp"
        case 123: return "ArrowLeft"
        case 124: return "ArrowRight"
        default: return nil
        }
    }

    /// Returns nil to swallow the event (we acted on it), or the event to let it
    /// through untouched. Runs for every key the app sees, so the
    /// not-our-business checks come first and stay cheap — and
    /// `sharedPreviewPanelExists` is what keeps a keystroke from conjuring a
    /// panel that was never opened.
    private func handleMonitoredKey(_ event: NSEvent) -> NSEvent? {
        guard QLPreviewPanel.sharedPreviewPanelExists(),
              let panel = QLPreviewPanel.shared(),
              panel.isVisible, panel.isKeyWindow,
              let name = arrowName(event),
              let callback = keyCallback else { return event }
        NSLog("[quicklook] monitor forwarded %@", name)
        name.withCString { callback($0) }
        return nil
    }

    // MARK: - QLPreviewPanelDelegate

    /// Events the panel received and didn't consume itself. We take the bare
    /// arrows — returning true, so the panel stops there — and leave the rest,
    /// Space and Escape included: those are the panel's own dismiss.
    func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
        guard event.type == .keyDown else { return false }
        guard let name = arrowName(event), let callback = keyCallback else {
            NSLog("[quicklook] delegate saw keyCode %d, not forwarding", event.keyCode)
            return false
        }
        NSLog("[quicklook] delegate forwarded %@", name)
        name.withCString { callback($0) }
        return true
    }

    // MARK: - QLPreviewPanelDataSource

    func numberOfPreviewItems(in panel: QLPreviewPanel) -> Int {
        url == nil ? 0 : 1
    }

    func previewPanel(_ panel: QLPreviewPanel, previewItemAt index: Int) -> QLPreviewItem {
        // NSURL conforms to QLPreviewItem (it supplies previewItemURL).
        url! as NSURL
    }
}

@_cdecl("quicklook_show")
public func quicklook_show(path: UnsafePointer<CChar>, toggle: Bool) {
    // Copy out of the C buffer synchronously — the pointer is only valid for the
    // duration of this call, and the panel work hops to the main thread.
    let pathStr = String(cString: path)
    DispatchQueue.main.async {
        QuickLookController.shared.show(path: pathStr, toggle: toggle)
    }
}

@_cdecl("quicklook_install")
public func quicklook_install(key: QuickLookKeyFn) {
    DispatchQueue.main.async {
        QuickLookController.shared.installKeyHooks(callback: key)
    }
}

@_cdecl("quicklook_visible")
public func quicklook_visible() -> Bool {
    if Thread.isMainThread {
        return QuickLookController.shared.isPanelVisible()
    }
    // AppKit state is main-thread-only; the Tauri command asking this runs on a
    // worker, so hop and wait (the answer is a bool read — no work to block on).
    return DispatchQueue.main.sync { QuickLookController.shared.isPanelVisible() }
}
