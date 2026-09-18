# Changelog

## 1.0.1

No new permissions. The `activeTab` permission was dropped (the host permissions already cover the supported sites), so existing users update silently.

### Fixed
- Opening the reader from the Capture tab could overwrite the saved copy's tags, notes or messages. That view is now read-only and links to the saved copy.
- A renamed title was reverted by "Update" and by live sync.
- "Delete all data" left data from 0.x versions behind, which came back after the next update.
- "Full thread" capture dropped repeated identical messages ("continue", "yes") and could label a partial capture as full.
- A visible-only re-capture could replace a full-thread capture.
- Deleting the last prompt template brought all defaults back.
- Titles containing backslashes produced broken download paths.
- Code blocks inside list items and blockquotes exported as invalid Markdown.
- Inserting a prompt or message into a chat replaced the draft already in the composer; it is now appended.
- `2 * 3 * 4` was rendered as italics; autolinks lost their query strings.
- Content search could show stale results after a conversation was updated.
- Escape inside a dialog also closed the reader behind it.
- The clipboard shortcut reported success when the copy had failed.
- The keyboard "download" command did nothing.

### Changed
- Default shortcuts are now Alt/⌥+Shift+B / C / S (Chrome reserves Ctrl+Shift+B and Ctrl+Shift+C). Settings shows the keys actually bound in your profile.
- Auto-topics and related-chat suggestions work for non-Latin languages.
- The same ChatGPT chat opened via chat.openai.com or a project URL is recognised as one conversation.
- Restoring a backup asks before replacing your settings, validates the file, and shows progress. Large imports are much faster.
- Library writes are serialised between the panel and the background worker.
- Perplexity capture ignores the page's own "Related" / "Sources" headings; ChatGPT tool messages are skipped.
- Dialogs keep keyboard focus inside and return it on close.

### Developer
- `npm test` (library tests) and `npm run test:dom` (DOM → Markdown snapshot in headless Chrome).
- MIT licence.

## 1.0.0

First public release on the Chrome Web Store.
