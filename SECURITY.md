# Security Notes

Emblem Studio is a static browser app plus an optional Tauri shell. It does not
intentionally send loaded images, GIFs, videos, webcam frames, or generated
exports to a server.

## Expected browser prompts

- Webcam capture asks for camera permission.
- Clipboard copy may ask for permission or fall back to selectable text.
- Download buttons create local files using browser APIs.

## Untrusted files

Media files are decoded by the browser and local JavaScript. Public limits are
enforced for file size, dimensions, and GIF frame counts to reduce accidental
memory exhaustion. Avoid opening media from sources you do not trust.

## Share links

Share links contain render settings only. Decoded settings are sanitized before
use: enums are allow-listed, numbers are clamped, strings are capped, and colors
are coerced to numeric RGB values.

## Reporting

Report security issues privately to a1v@rm3.pro with:

- Browser and OS.
- Reproduction steps.
- A minimized input file or share link when safe to provide.

