# Naruhodo Privacy Policy

Effective date: 2026-10-28
Publisher: Sad Coder, Inc.

Naruhodo is a Chrome extension that translates Japanese manga on screen into Traditional Chinese, in place. This policy explains what data the extension handles and where it goes.

## The developer receives none of your data

Naruhodo has no server of its own and contains no analytics or tracking code. Everything listed below either stays on your computer or is sent by your browser directly to a third-party service. Sad Coder, Inc. receives none of it.

## Data processed only on your computer

- **Screen captures**: after you click the extension icon or press its shortcut on a tab, the extension captures the visible area of that tab and detects speech balloons and recognizes text (OCR) locally. **Captures are never uploaded** and are discarded after use.
- **Recognized text, translations and readings**: stored in the extension's local database as a translation cache, so a page you revisit does not need to be translated again.
- **Series and page addresses**: when you assign a page to a manga series, the extension remembers that page's address (without the part after `?`) so it can recognize the series next time.
- **Series Notes**: per-series names and glossary.
- **Anthropic API key**: the key you enter is stored in the extension's own local database. Web pages and the script the extension injects into them cannot read it, and it is never included in export files.
- **Display settings**, such as single-page or two-page spread mode.

## Data sent off your computer

- **Anthropic (api.anthropic.com)**, the translation service. Using **your own API key**, your browser sends directly to Anthropic: the Japanese text recognized on the current page, the original text and translations of the previous few pages of the same series (to keep translations consistent), and the series glossary. **No images and no page addresses are sent.** On first use the extension explains this and asks for your consent; nothing is sent before you agree. Anthropic handles this data under the [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy) and your agreement with Anthropic.
- **Hugging Face (huggingface.co)**: on first use the extension downloads its text-detection and OCR models from here (about 128 MB, or about 472 MB on computers with WebGPU). This is a plain file download and sends none of your data, although, as with any website, Hugging Face can see your IP address.

The extension connects to nothing else. All connections use HTTPS.

## Retention and deletion

Data stays on your computer until you delete it:

- "Delete" in the settings section removes your API key.
- "Clear cache" in the Series Notes section clears the translation cache.
- Removing the extension deletes all of its data.

For content already sent to Anthropic, see Anthropic's data retention policy.

## Limited Use

Naruhodo's use and transfer of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements. Data is used only to provide translation; it is not sold, not used for advertising, and not used to determine creditworthiness.

## Changes to this policy

When our data handling changes, we will update this policy and its effective date and notify you inside the extension. Past versions are available in this file's history on GitHub.

## Contact

dev@sadcoder.com

