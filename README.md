# History by Date

A Chrome extension that lists your browsing history in plain reverse-chronological order.

This reads browsing history through Chrome's extension APIs and renders it as a
flat list, newest first, with date headings.

## Install

Not on the Chrome Web Store. Load it unpacked:

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Choose **Load unpacked** and select this directory
4. Pin **History by Date** from the extensions menu in the toolbar

The ID of an unpacked extension is derived from its path, so moving the directory
makes Chrome treat it as a new extension. It will need to be loaded and pinned again.

## Usage

Three tabs share one list:

| Tab | Shows |
|---|---|
| All | Up to 1,000 URL entries ordered by latest visit, with date headings |
| Recently Closed | Tabs and windows closed recently |
| Tabs From Other Devices | Open tabs on your other signed-in devices, grouped by device |

The search box filters whichever tab is active. Arrow keys move between tabs.

Clicking a row opens it in a new tab. Cmd/Ctrl-click and middle-click open it in the
background and leave the popup open.

The toolbar icons open Chrome's own **Clear browsing data** dialog, and a menu with
**Open History Page**.

By default the All tab requests the 1000 most recent entries. Adjust `MAX_RESULTS` at the
top of `popup.js` to change that.

## Permissions

| Permission | Used for |
|---|---|
| `history` | Reading browsing history |
| `sessions` | Reading recently closed tabs and tabs from other devices |
| `favicon` | Site icons, served from Chrome's own favicon cache |
| `tabs` | Reading tab titles and URLs returned by the sessions API |

No host permissions. The extension contains no analytics, remote code, upload
logic, or persistent storage of its own. History and session results are read
when the popup is opened and displayed in memory. Site icons are requested
through Chrome's built-in favicon service.

The other-device view uses data Chrome already syncs through the browser
account; it depends on your Chrome sync settings. Opening a row navigates to
the selected website.

## Layout

```text
manifest.json   Manifest V3
popup.html      Markup and styles
popup.js        Fetching, shaping, rendering
icons/          PNGs at four sizes, and the SVG they are generated from
```

## Notes

`collapseByURL()` defensively merges repeated URLs if they appear in the
results, keeping the latest visit time and highest visit count. The All view
shows URL entries rather than every individual visit; there is no pagination.

Timestamp units differ between the two APIs: `chrome.history` reports milliseconds,
while `lastModified` on a `chrome.sessions` entry is in seconds. `rowsFromSessions()`
normalises to milliseconds.

Deleting history is irreversible, so the trash button opens Chrome's native dialog
rather than clearing anything directly.

## Requirements

Chrome 104 or later, which is where the `favicon` permission landed. Developed against
Chrome 153.

## License

The extension code is [MIT licensed](LICENSE). Both the toolbar icons and
in-popup glyphs are from Google's Material Symbols under
[Apache License 2.0](licenses/Apache-2.0.txt). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution.

## Development

No build step or dependencies are required to load the extension. To run
the asynchronous view/search regression tests with Node.js 18 or later:

```bash
node --test tests/popup.test.cjs
```

Tests use synthetic browser API responses and do not access browser profiles.
