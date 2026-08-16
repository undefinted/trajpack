# trajpack Authorized DOM Capture

This Manifest V3 extension captures only rendered message text from an explicitly
selected active tab. It has no content script, background service worker, network
interception, cookie access, page storage access, or commercial AI site presets.

The extension requires a user-supplied `selector-recipe/0.1` document that:

- names one exact HTTP(S) origin;
- records site ownership, written permission, or a contract evidence reference;
- expires at a stated time;
- maps page-specific roles to `user`, `assistant`, `system`, or `tool`;
- gives fail-closed selector counts and fingerprint probes; and
- carries a SHA-256 integrity digest over the canonical recipe without the
  `recipe_sha256` member.

Use **Calculate recipe integrity hash** after writing or modifying the recipe.
Capture is a separate click, followed by a plaintext preview, followed by a final
approval click. A one-time pairing nonce is never stored and is cleared before the
upload attempt. The receiver must consume the nonce once and validate the
`chrome-extension://` Origin header.

Load the unpacked extension from `build/` after running `pnpm build`.
Commercial ChatGPT, Claude, and DeepSeek web origins are blocked; use their
official data export and `trajpack import` instead.

`pnpm test:e2e` loads the packaged extension in installed Chrome and Edge with
Playwright and verifies that it has a click-driven popup and no background
service worker. The browser suite also exercises fail-closed selector drift and
Shadow DOM behavior, point-in-time dynamic-page snapshots, and inert preview
rendering for markup-looking provider text.

## Browser boundaries

- Capture is one synchronous, point-in-time DOM traversal initiated by the
  **Capture visible text for preview** click. The extension installs no DOM
  observer, timer, content script, or background worker. Content loaded later is
  absent until the user clicks capture again.
- CSS selectors intentionally do not pierce a shadow boundary. Open or closed
  Shadow DOM that hides a required root/content node therefore causes the recipe
  count checks to fail closed. An authorized site must expose the capture surface
  in accessible light DOM; closed shadow roots cannot be inspected through the
  standard extension DOM API.
- Browsers provide no atomic snapshot of a live document. A page can mutate
  during the short synchronous traversal, and element visibility checks cannot
  prove that every pixel is unobscured. Let the authorized page settle, inspect
  the plaintext preview, and capture again if it changed.
- "Visible" here means the element has a layout box and neither it nor any light
  DOM ancestor is suppressed by `hidden`, `aria-hidden=true`, `display:none`,
  `visibility:hidden|collapse`, `content-visibility:hidden`, or zero opacity.
  The check does not require intersection with the current viewport: an
  off-screen or scrolled-out element can still qualify. It also does not perform
  hit-testing, stacking-context analysis, clipping-area measurement, or
  occlusion detection, so another element may cover otherwise qualifying text.
  The plaintext preview is the user's final confirmation of the captured scope.
- Preview values are assigned with `textContent`; strings resembling HTML,
  scripts, event handlers, or links remain inert text. The extension never
  follows or activates captured links.
