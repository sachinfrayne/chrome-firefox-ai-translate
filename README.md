# AI Translate (Gemini)

A Chrome and Firefox extension that translates text right on the page using Google Gemini and your own API key. One folder works in both browsers, with no build step.

## What it does

- **Pick a block**: press `Alt+B` (or use the toolbar button or right-click menu), hover until the block you want is outlined, and click it. The translation appears right next to the block. Up/Down arrows grow or shrink the outlined block, and Esc cancels. Good for chat messages and other text that is awkward to select.
- **Write a reply**: press `Alt+R` (or click **Reply** on a translation). Type what you want to say in your own language, pick a tone (Casual, Neutral, Formal), and press Enter. Gemini rewrites it the way a native speaker would say it in a chat, not word for word, and shows a literal back-translation under it so you can check the meaning. **Insert** types it into the page's message box (it never sends it for you), **Try again** gives another wording. If you just translated a message, it is used as context so the reply matches its regional variety and vocabulary. The reply language (default Spanish) and default tone are on the settings page.
- **Transcribe a voice message**: press `Alt+V` (or use the toolbar button or right-click menu), then press play on the voice message. The extension reads the audio the page starts playing, pauses it, and shows the translation with the original transcript under it. **Reply** opens the reply writer with the transcript as context, and **Another** waits for the next message. The audio is sent to Gemini; recordings over about 14 MB are refused.
- **Translate selection**: select text, then right-click and choose "Translate selection with Gemini", or press `Alt+T`. The translation appears in a small panel at the top right of the page, with a Copy button.
- **Translate page**: right-click the page and choose "Translate this page with Gemini", or use the toolbar button. (Chrome allows an extension four default shortcuts, so this one has none; you can assign one yourself.) Text is replaced in place, starting with what is on screen. Run it again to translate content that loaded later.
- **Show original**: restores the page text.

## Install

### Chrome (also Edge, Brave)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and choose `manifest.json` in this folder.

Firefox removes temporary add-ons when it restarts. Your saved key and settings survive because the extension has a fixed ID. A permanent install needs the extension signed by Mozilla (free, unlisted, through addons.mozilla.org), or Firefox Developer Edition with `xpinstall.signatures.required` set to `false`.

## Set up

The settings page opens on first install (later: toolbar button, then **Settings**).

1. Paste your Gemini API key (get one at https://aistudio.google.com/apikey).
2. Click **Test key and load models** to confirm it works and pick a model. The default is `gemini-flash-latest`.
3. Choose the language to translate into, then **Save**.

Shortcuts can be changed at `chrome://extensions/shortcuts` in Chrome, or in Firefox under Add-ons, gear icon, **Manage Extension Shortcuts**.

## Where your API key goes

- It is saved in the browser's local extension storage (`storage.local`), not synced storage, so it stays in this browser profile on this device.
- It is read only by the background script, which sends it as the `x-goog-api-key` header to `generativelanguage.googleapis.com`. That is required for Gemini to accept the request. It is never put in a URL.
- The manifest grants network access to that one host only, and the extension pages' content security policy limits connections to it as well.
- The script that runs inside web pages never receives the key. It only passes text to the background script and gets translations back.
- Like all extension data, the key sits unencrypted in your browser profile on disk. **Remove key** on the settings page deletes it.

The text you translate, the replies you draft and the voice messages you transcribe are sent to Google's Gemini API. Nothing is sent until you trigger one of those actions, and the extension only touches a tab after you invoke it there.

## Limits

- Browser-internal pages (`chrome://`, `about:`, the extension stores) cannot be translated.
- Page translation covers the top frame, not embedded iframes.
- Text inside code blocks, form fields and editable areas is left alone.
- Very long pages use many API requests. On a free-tier key you may hit rate limits, in which case the extension retries a few times and then reports the error.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3, shared by Chrome and Firefox |
| `background.js` | Gemini API client, context menus, shortcuts |
| `content.js` | On-page panel and in-place page translation |
| `popup.html`, `popup.js` | Toolbar popup |
| `options.html`, `options.js` | Settings page and API key storage |

## License

Copyright 2026 Sachin Frayne. Licensed under the [Apache License, Version 2.0](LICENSE).
