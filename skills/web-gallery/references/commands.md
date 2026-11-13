# Browser session commands

## Start

Use the existing Node.js, Playwright and Chromium installation. Do not install/upgrade dependencies or load `.env`. Resolve scripts from the skill source (the installed skill is a symlink to it).

Check the exact-host recipe first using `recipes.mjs lookup --url '<url>' --full`, then:

```sh
node <skill>/scripts/session.mjs --url '<page-url>' --max-images 20 --out ./gallery-runs
```

Use a persistent terminal with `tty:true`, stdin open and a short initial yield. Send one JSON object per line and read the response before choosing the next action. A PTY can echo input: result lines have `ok` and `result`/`error`.

Each run gets a new folder, a manifest and `.debug/` evidence. The headless browser saves a viewport screenshot after inspection/actions. Compact responses include up to eight containers and 24 controls; image targets are included even when their clickable parent has no text. Full bounded inspection (30 containers, 120 controls, 20 JSON sources) is saved locally. Prefer reading needed fields locally to dumping HTML/JSON into chat.

Responses include workflow counters, `nextAction` and an instruction. These describe the next required step, not proof that the model performed it. `status` is safe to use after an interruption. Inspection marks common access-error/CAPTCHA text; also assess the screenshot and actual errors, because no text detector covers every site.

If the helper is blocked, check the existing user browser and native app controls before abandoning collection. Record the attempt, close this helper and continue with [browser.md](browser.md). Do not equate a connector outage with an inaccessible native browser.

## Commands

Selectors must be observed and match exactly one element. The following selectors are illustrative:

```json
{"type":"status"}
{"type":"inspect"}
{"type":"inspect","full":true}
{"type":"inspect","selector":"#gallery"}
{"type":"recipe"}
{"type":"act","action":"click","selector":"#open-gallery"}
{"type":"scope","selector":"#viewer","replace":true,"reason":"Viewer opened from the selected gallery; exposes larger photo variants"}
{"type":"collect"}
{"type":"act","action":"click","selector":"#next"}
{"type":"repeat","steps":10,"action":{"action":"click","selector":"#next"}}
{"type":"act","action":"scroll","selector":"#viewer","deltaY":600}
{"type":"repeat","steps":5,"action":{"action":"scroll","deltaY":1000}}
{"type":"act","action":"key","key":"ArrowRight"}
{"type":"act","action":"wait","ms":1000}
{"type":"add","urls":["https://images.example.com/item.jpg"],"evidence":"Exact URL from inspected metadata for this selected gallery"}
{"type":"download","exploration":"limit","evidence":"Collected enough candidate photographs; downloader will check the saved count"}
{"type":"close","reason":"Downloads complete; continue with shared review and recipe finalisation"}
```

- `inspect` observes only; it does not collect. A selected element's HTML is limited to 24,000 characters and reports truncation. Never infer the unseen remainder. Inspect a smaller relevant element or use scoped collection.
- `scope` selects a gallery outside navigation/header/footer. With `replace:true`, it clears prior scopes and candidates so a better viewer supersedes thumbnail collection. Already saved files stay in the run and count towards the cap. Without it, scopes accumulate. Do not use a broad page wrapper containing unrelated reviews/promotions.
- `collect` returns `added`, total `groups`, unattempted `pending` groups, variants, warnings and a caption preview. Exact overlapping observed variants are grouped; different crop paths are not guessed equivalent. Counts are not verified saved photos.
- `add` accepts only exact observed gallery metadata URLs, with source/membership evidence and a selected scope. A page-wide network request alone is insufficient evidence.
- `act` supports click, bounded scrolling (at most 2000 pixels), supported navigation keys and waits of 1–3000 ms. Dismiss an observed obstructing notice before retrying a blocked click. Do not force clicks through overlays.
- `repeat` accepts 1–20 steps of an already-tested click/scroll/key action. It collects before and after actions and stops when enough unattempted candidates remain to fill the saved-image shortfall, at three unchanged collections, a disabled control, warning, error or budget. Review partial/no-progress results; they do not establish gallery exhaustion.
- `download` can be repeated after collecting more. Saved files, hashes, attempted URLs and transfer totals persist, so retries do not reset the image/byte cap or repeat every failed request. New observed variants can still be checked. It records rejected/duplicate files and chooses the largest successfully decoded variant per candidate.
- `close` always releases the helper, including after an interaction/time budget. It reports pending workflow work; closing alone does not finalise the result. The user's existing browser tabs are independent.

`download.exploration` is `limit` for a candidate stopping point, `exhausted` for an evidenced end/cycle, or `incomplete` for blocks/errors/uncertain progress. If `limit` leaves fewer saved photos than requested, collect more and download again; establish an exhausted gallery explicitly when appropriate. A shortfall cannot silently produce a proven recipe.

For browser fallback, record actual checks before closing when the helper is still alive:

```json
{"type":"fallback","available":true,"evidence":"The existing target page opens normally in the user's Chrome; its gallery control is visible"}
{"type":"close","reason":"Continue this run through the accessible user browser"}
```

Use `available:false` only after checking the available browser and native-app tools. If no tool can access the page, ask the user to open/share it. If startup already failed and exited, continue its returned manifest using `browser.mjs start --manifest ...`.

The session's older `review` command remains supported, but both routes can close first and use the common commands:

```sh
node <skill>/scripts/recipes.mjs review --manifest '<run>/manifest.json' --verified --evidence '<observed review evidence>'
node <skill>/scripts/recipes.mjs finish --manifest '<run>/manifest.json' --draft '<run>/.debug/recipe-draft.json'
```

See [recipes.md](recipes.md) for automatic save/update/reuse and incomplete outcomes. Do not stop after download/review without resolving the recipe.

## Operational limits

| Option | Default | Meaning |
| --- | --- | --- |
| `--max-images` | Required | Positive cap on saved images |
| `--max-bytes` | 104857600 | 100 MiB of downloader image response bodies across download batches |
| `--max-file-bytes` | 20971520 | 20 MiB per attempted image |
| `--max-actions` | 120 | Attempted browser actions, including explicit waits |
| `--max-ms` | 600000 | Ten-minute session budget, including idle time |
| `--max-candidates` | 500 | Candidate groups, up to eight variants per group |
| `--min-edge` | 800 | Minimum decoded longest edge, including portrait images |

Byte accounting includes rejected/duplicate/alternative image bodies, excluding browser page traffic and HTTP headers. Streaming cancellation may overshoot by an in-flight chunk. Overrides must honour the user's requirements; do not silently enlarge the image cap. Browser operations have finite timeouts and shutdown waits for an operation to unwind. These limits prove neither original resolution nor gallery completeness.

## Evidence files

- `manifest.json`: source/current URL, limits, scopes, actions, decoded dimensions, SHA-256 hashes, attempts, transfer totals, review, recipe checks and finalisation.
- `.debug/current.jpg`: latest inspected viewport.
- `.debug/inspection.json`: latest full bounded inspection before compaction.
- `.debug/actions.jsonl`: attempted interactions.
- `.debug/candidates.json`: latest scoped DOM collection. Full variant URLs stay here rather than in compact responses.
- `browser-collection.json`: observed browser file/position ledger when that route is used; verifier imports it into the common manifest.

Run the deterministic local fixtures from the project root:

```sh
node --test tests/*.test.mjs
```

They use temporary files and local servers, not public websites or the installed recipe store. Chromium launch may require normal sandbox approval.
