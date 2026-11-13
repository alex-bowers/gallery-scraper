# Collection through the user's browser

Use this route when the helper cannot access the gallery, or an applicable recipe specifies the user's browser. Use the browser-control tools actually available in the conversation; this script does not control Chrome, read its cookies or attach to its debugging port.

## Start or continue

First confirm that the existing browser can view the requested page. Use browser DOM tools when available; otherwise use native app control, accessibility state and screenshots. Open the gallery normally and capture its entry-state UI text while identifying its opening control. Keep the snapshot local and omit private browser/account information.

If the helper created a run, send `close` first, then continue the same folder:

```sh
node <skill>/scripts/browser.mjs start --manifest '<run>/manifest.json'
```

The original attempt is preserved in `.debug/helper-manifest.json`. Existing helper images still count towards the cap. Do not run this command twice; use the returned collection file after starting.

If no helper run exists:

```sh
node <skill>/scripts/browser.mjs start --url '<page-url>' --max-images 20 --out ./gallery-runs
```

Startup looks up the exact hostname and returns its full methods, the folder and a `browser-collection.json` template. Native methods can use observed UI text checks instead of selectors. DOM-only methods can guide discovery. Declare them matched only when connected-browser DOM observations confirm their checks; native UI text alone cannot establish a DOM match.

## Save and record

Save photos from the confirmed gallery/viewer into the returned folder using the available browser tool. Use the displayed image or an observed larger image URL. Prefer bulk extraction if the connected browser exposes all gallery entries; use Save Image As when necessary. Do not collect page-wide network images, guess CDN URLs, or save video posters as photographs.

Update the template with facts observed in this browser. Example (illustrative, not a real site's recipe or evidence):

```json
{
  "version": 1,
  "sourceUrl": "https://example.com/gallery",
  "pageUrl": "https://example.com/gallery",
  "gallery": {
    "openedBy": "Clicked Open gallery on the selected product page",
    "identityEvidence": "The page title and viewer identify the requested product",
    "largerImagesEvidence": "Opening a tile showed a larger photograph; saved that displayed image"
  },
  "observation": {
    "url": "https://example.com/gallery",
    "text": "Product example. Open gallery. Product photographs."
  },
  "exploration": {
    "status": "limit",
    "evidence": "Saved the requested two photographs; skipped the intervening video"
  },
  "photos": [
    {"filename": "one.jpg", "position": "1 / 12", "caption": "Front view"},
    {"filename": "two.jpg", "position": "3 / 12", "caption": "Detail"}
  ],
  "skipped": [
    {"position": "2 / 12", "reason": "Video slide; no poster saved"}
  ]
}
```

Keep `sourceUrl` as generated. `pageUrl` is the observed gallery/viewer URL. The observation can come from an earlier entry state on that same hostname, allowing recipes to recognise a gallery before it opens. Copy actual relevant accessibility/UI text; do not invent a DOM selector or infer positions from filenames. When there is no visible counter, record an observed category/item position such as `Rooms: third tile` and explain how it was observed in the exploration evidence.

When the connected browser exposes DOM inspection, `observation` may also include an `elements` array, copied from its actual queries:

```json
{"url":"https://example.com/gallery","text":"Gallery","elements":[{"selector":"#gallery","count":1,"localName":"section","textContent":"Product photographs"}]}
```

Record each queried selector once, its actual match count, element name and relevant text. Script elements can provide their bounded JSON text for the existing JSON path checks. Do not assert a count or selector from a screenshot. The verifier supports up to 120 observed selectors and four million characters of DOM evidence. DOM-based recipes can then be saved and reused through this route; omit `elements` when only native UI tools are available.

Each browser-saved photo needs a plain filename and an observed position. `caption` and the exact observed `sourceUrl` for an individual photograph are optional. Leave captions empty when absent. Helper-saved photos remain in the manifest: do not list them again. Record skipped videos, failed items or duplicate positions in `skipped` with the observed position and reason. Positions must be distinct across saved and skipped items.

Use `exploration.status` `limit` when the saved-image cap is reached, `exhausted` for an evidenced gallery end/cycle, or `incomplete` for a block/budget/uncertain end. Do not claim exhaustion from a failed Next action. For fewer photos than the cap, keep exploring unless an end or blocker is evidenced.

## Verify the local files

```sh
node <skill>/scripts/browser.mjs verify --collection '<run>/browser-collection.json'
```

This performs bounded local checks, verifies file signatures, decodes dimensions, computes SHA-256 hashes and reconciles every file against the combined record. It rejects duplicates, missing/extra files, unfinished downloads, path traversal, symlinks, invalid or undersized images and cap/byte overruns. No files are silently removed. Move rejected or duplicate files outside the run folder and correct their records before retrying; preserve evidence and honour explicit user instructions about duplicate slides.

The default minimum is an 800-pixel longest edge. On macOS, the verifier uses existing `sips` to read dimensions and render a small `.debug/` diagnostic without changing the source. On other platforms it uses the existing Playwright decoder on a local blank page, without revisiting the restricted website. Normal environment approval may be required to launch that decoder; do not install dependencies or evade permissions.

Browser traffic and rejected browser downloads cannot be measured by this verifier. Its byte limit applies to the saved local files; helper transfer totals remain in the manifest for mixed runs. Do not claim a browser network-transfer cap was enforced.

A successful verification writes the common `manifest.json`; it does not visually review the photographs. It clears any previous review/finalisation. Fix a shortfall by saving more photos from this gallery, updating the record, and verifying again. Changes to a file or record after verification are rejected at finalisation.

## Review and finish

Read the manifest, inspect saved samples, then use the shared `recipes.mjs review` and `finish` commands in [recipes.md](recipes.md). Native-browser collections are eligible for automatic recipe creation on the same terms as helper downloads. Never leave the outcome at “manual downloads cannot save recipes”. Keep a `uiTextIncludes` method grounded in the captured entry-state text when DOM access was unavailable. The finaliser checks those browser recipe conditions against the recorded observation.

The user's browser tab can stay open. Close only helper sessions created for the run. Report manual collection, dimensions, verified count, video/duplicate skips, stopping evidence and the explicit saved/reused/ineligible recipe outcome.
