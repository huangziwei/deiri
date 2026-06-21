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

import AppKit
import Quartz

final class QuickLookController: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    static let shared = QuickLookController()

    // Strongly held: QLPreviewPanel's dataSource/delegate are weak, and the URL
    // backs the single preview item.
    private var url: URL?

    func show(path: String) {
        guard let panel = QLPreviewPanel.shared() else { return }
        let target = URL(fileURLWithPath: path)
        // Toggle off when Space is pressed again on the file already showing.
        if panel.isVisible, url == target {
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
public func quicklook_show(path: UnsafePointer<CChar>) {
    // Copy out of the C buffer synchronously — the pointer is only valid for the
    // duration of this call, and the panel work hops to the main thread.
    let pathStr = String(cString: path)
    DispatchQueue.main.async {
        QuickLookController.shared.show(path: pathStr)
    }
}
