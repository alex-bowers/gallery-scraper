# Domain recipes

Recipes store a proven way to collect from a gallery layout. They are checked before discovery and saved automatically after a verified collection, including native-browser collection. They do not guarantee access to every website and are never executable browser scripts.

## Lookup before opening the helper

```sh
node <skill>/scripts/recipes.mjs lookup --url '<page-url>' --full
```

Only `recipes/<exact-hostname>.json` is read. Subdomains and sibling hosts are separate. The path is provenance, not an applicability restriction. `--full` returns the method checks and steps, not just names. Use the current page's own images; never reuse a previous run's image URLs.

The helper's startup/`recipe` command checks methods on its actual page, including redirects:

| Status | Action |
| --- | --- |
| `missing` | Discover normally; prepare a new proven method |
| `matched` | Follow the relevant method after confirming this page's identity |
| `unmatched` | Discover normally; add/correct the method after verification |
| `invalid` | Preserve the invalid file, report the problem and inspect normally |

A selector/text match does not establish image membership. Confirm which gallery opened the viewer, use specific scopes, and review samples. Recipes must not override the user's scope or access controls.

## Choose reusable checks and methods

The exact hostname selects the recipe. Its method checks should recognise the gallery layout or collection approach across pages on that host. Use the exact hostname as the site identifier. Keep brand, hotel, product and other subject names out of reusable method names, check reasons, matching conditions and instructions; use generic gallery or layout descriptions instead. Keep full page titles containing those names, individual gallery counts and subject-specific URL paths out of matching conditions and reusable instructions too. Retain specific names and page details only in verification provenance when relevant. Preserve existing method IDs when generalising wording; use generic layout descriptions for new IDs. Use observed structural selectors or shared gallery UI text, rather than copying an entire property-specific title.

When a method is unmatched, compare its steps with the current gallery before deciding to add another method. If the layout and collection approach are the same and only page-specific content caused the mismatch, generalise the existing check and update the method under its existing ID. A different page subject or URL alone does not justify a new method. Add a method when an observed layout or collection difference requires different steps, and record that difference.

Validate proposed checks against the current page observation and earlier saved observations for that method when available. Keep checks grounded in observed text or selectors; never invent a shared marker or remove layout checks merely to make the hostname match. Preserve relevant verification evidence from earlier runs when correcting an existing method. Recheck saved methods with `check-browser` for recorded UI observations, or the helper's `recipe` command for its current page.

## Draft format

Write `.debug/recipe-draft.json` in the run folder. This example illustrates a DOM-based method:

```json
{
  "version": 1,
  "hostname": "example.com",
  "methods": [{
    "id": "gallery-viewer",
    "name": "Gallery with expanded viewer",
    "checks": [{
      "selector": "#gallery",
      "reason": "Dedicated image grid observed at the entry state"
    }],
    "steps": [
      "Confirm the requested page and inspect #gallery.",
      "Open its first observed image and confirm the resulting .photo-viewer belongs to that grid.",
      "Scope .photo-viewer alone with replace:true, then collect its observed src and srcset variants in bulk.",
      "Only navigate if more candidates are required; skip videos and retain the user's saved-image cap."
    ],
    "verification": ["Review the manifest and saved samples against this page and gallery."],
    "limitations": ["Largest observed version is not necessarily original resolution."]
  }]
}
```

For native-browser collection without DOM access, replace the check with observed entry-state UI text:

```json
{"uiTextIncludes":"Open gallery","reason":"Observed gallery-opening control in the browser accessibility state"}
```

Record the actual browser navigation and saving method in `steps`. Use stable gallery labels rather than a particular product's name, a transient counter or a browser element index. `uiTextIncludes` is a case-sensitive substring check against the captured relevant UI text. It cannot be combined with a DOM selector/JSON path. The browser verifier evaluates it against `observation` in `browser-collection.json`; the helper can evaluate it against visible page text. DOM checks can use the bounded `observation.elements` records captured by connected-browser DOM queries; see [browser.md](browser.md). A DOM check remains unmatched when only native UI evidence is available.

To check an observed native state independently:

```sh
node <skill>/scripts/recipes.mjs check-browser --url '<page-url>' --observation '<observed-url-and-text.json>'
```

The observation is an object with `url` and `text`, captured through the available browser tool. Do not include private account or browser information. The check reads it locally and never controls the browser.

DOM checks require exactly one matching element and a reason. They may use `textIncludes` when it meaningfully distinguishes gallery layouts, or a JSON structure check:

```json
{"selector":"#__NEXT_DATA__","reason":"Observed gallery media structure","jsonPath":["props","pageProps","galleries","*","media"],"valueType":"array"}
```

JSON checks inspect structure, not image membership or automatic extraction. `*` expands arrays; property names and non-negative indices are supported. They do not decode flattened Nuxt data. Record the proven data path, image/caption fields, responsive variant selection and video exclusions in the steps if metadata extraction was actually tested.

Every method needs an entry-state check, 1–30 steps, 1–30 verification instructions and 0–30 limitations. Stable IDs use lowercase letters, digits and hyphens, up to 64 characters. Different layouts/transports can have separate methods on one hostname. Methods should describe observed, successful actions without raw website instructions, old image URLs, executable code, cookies or secrets.

Files remain version 1, limited to 64 KiB and 12 methods. Checks are limited to 1–12 per method; strings to 1000 characters (names 160, selectors 500); JSON paths to 16 segments, 5000 intermediate values and four million input characters. Unknown fields and unsafe paths fail validation. Do not put `verified` in a draft; saving derives provenance from the reviewed run and strips URL query/fragment.

## Shared review and automatic completion

1. Verify the saved files and visually inspect samples. Close the helper if used. Native browser files must first pass `browser.mjs verify`.
2. Record factual review:

   ```sh
   node <skill>/scripts/recipes.mjs review --manifest '<run>/manifest.json' --verified --evidence '<what was actually checked>'
   ```

   Omit `--verified` for unresolved membership uncertainty. The result gives an explicit next action: `create`, `update`, `reuse`, `repair` or `ineligible`. No save-question is needed.
3. For a new or corrected method, prepare the draft from the proven run, then finish:

   ```sh
   node <skill>/scripts/recipes.mjs finish --manifest '<run>/manifest.json' --draft '<run>/.debug/recipe-draft.json'
   ```

   This saves a missing domain, or updates the supplied method IDs while preserving unrelated methods. An unchanged, checked recipe needs no draft: omit `--draft` to record reuse. If the recipe changed since lookup, recheck it rather than silently declaring reuse.
4. Read the result and report its recipe path/outcome. `ready:true` means the outcome was resolved; inspect `complete` as well. Incomplete attempts return `complete:false` and an ineligible reason. A proven method cannot be saved from an empty, failed, unreviewed, unverified or unfilled-cap run. Establish an exhausted gallery explicitly if fewer than the cap exist.

Both routes use this same manifest, review and finaliser. It audits files again and refuses a valid new/changed layout without a draft. Do not finish a blocked helper run without checking the user's browser and recording the attempt. If the helper already exited, browser continuation retains that attempt and supplies its own verified result.

If the user explicitly declined recipe saving, pass `--recipe-declined '<their explicit instruction>'` instead of a draft and report `declined`. Never use this to skip the workflow silently. Invalid stored recipes are preserved: repair them explicitly or report that recipe completion failed. Do not save a guessed method to satisfy a checklist.

The older low-level `save --draft ... --manifest ... --approved [--update]` remains available for compatibility. Normal runs use `finish`; its purpose includes the authorised automatic save. Writes use per-domain locks and exclusive/atomic publication, and reject concurrent changes or malformed existing files.

## Checking progress

```sh
node <skill>/scripts/recipes.mjs status --manifest '<run>/manifest.json'
```

This returns saved/candidate/rejected/duplicate counts, remaining target, next action and pending completion work. Use it after an interruption or uncertainty rather than reconstructing progress from chat history.
