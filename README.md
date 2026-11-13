# Gallery Scraper

Web gallery image extraction using a Codex skill: Codex navigates in chat and bundled scripts collect, limit and verify images.

Use it for image galleries such as product images, portfolios, artwork or photos. The workflow targets the selected gallery and retains format, minimum-dimension and access limits; it does not guarantee extraction from every website.

## Codex chat workflow

The skill source is [skills/web-gallery/SKILL.md](skills/web-gallery/SKILL.md). Its scripts use the existing Playwright installation without calling a model API or loading `.env`.

Once the skill is linked into your Codex skills directory, invoke it in chat, for example:

> Use $web-gallery to collect up to 20 gallery images from this page URL: …

Every run requires an explicit image cap. The workflow checks an exact-host recipe first, identifies the gallery and operates its controls. Scripts collect only selected gallery scopes or evidenced gallery data. If the helper cannot access the page, Codex checks the user’s existing browser, including native app control when a browser connector is unavailable. Both routes produce a common manifest with verified files and a reusable recipe.

The cap applies to saved images. Browser page traffic and requests for rejected or alternative variants are separate; the downloader has configurable time and byte limits. The skill reports incomplete exploration and does not assume that an expanded image is the original image. Resized or recompressed duplicates may still require review.

See [the command reference](skills/web-gallery/references/commands.md) for the helper protocol and operational limits. Run the deterministic local fixture tests with:

```sh
node --test tests/*.test.mjs
```

No dependency installation or upgrade is needed for this workspace. The user-level skill link must continue to point at this project while we iterate.

Use pnpm to manage dependencies. The gallery helper can also be started directly from the project root:

```sh
pnpm start --url 'https://example.com/gallery' --max-images 20 --out ./gallery-runs
```

The helper accepts JSON commands on standard input; see the command reference above. It does not discover or navigate the gallery automatically.

## Optional information that helps

The page URL and image cap are enough to start. If you already know how the gallery works, sharing the details below can reduce repeated investigation and the amount of work AI needs to do. You do not need developer tools or technical knowledge.

| Information | How it helps |
| --- | --- |
| A direct gallery URL | Avoids searching for the gallery on the website. |
| Opening and navigation instructions, such as “click See the gallery, then Next” | Reduces work discovering the controls. Mention whether clicking a image enlarges it. |
| Preferred categories, such as products, details or artwork | Helps choose images when the gallery contains more than the image cap. |
| One confirmed full-size image URL | Helps identify the image host and available resolution without guessing URL transformations. |

For example:

> Use $web-gallery on [gallery URL] and download up to 20 images. Click “See the gallery”, then use Next. Clicking a image does not enlarge it. Prioritise product overview and detail images.

If you are comfortable with browser developer tools, these details can also help:

- The gallery container’s HTML or a CSS selector that identifies it, to separate gallery images from navigation, reviews and footer images.
- The selector for an observed Next button or lightbox, to reduce control discovery.
- The location of embedded gallery data, such as a JSON script element and the path to its image list.

Provide only the relevant gallery information. Large HTML or JSON captures can be saved locally with their file paths supplied in chat, so scripts can inspect them without pasting the whole contents into the conversation. Remove cookies, tokens and other private data before sharing captures.

## Saved domain recipes

The skill checks `skills/web-gallery/recipes/<hostname>.json` when a run starts. Recipes contain proven collection methods, DOM/data or observed browser UI checks, verification instructions and provenance. URL paths do not restrict applicability. Each exact hostname can have multiple methods; subdomains are kept separate. Only matching methods are returned, and missing or stale recipes fall back to inspection. The current gallery supplies its own image URLs.

After a verified collection, Codex automatically creates a recipe when missing, adds/corrects a proven method for a new layout, or records reuse of an unchanged matching method. No separate save question is needed. Explicit user refusals are honoured. Unsuccessful or unverified attempts cannot create proven recipes. Existing unrelated methods and invalid recipe files are preserved.

The shared finaliser requires review and an explicit recipe outcome before completion. It checks that verified files still match the manifest. Browser-saved files are eligible after local verification; they no longer remain outside the recipe workflow. Native-browser methods can use observed UI text when DOM selectors are unavailable.

See [the recipe reference](skills/web-gallery/references/recipes.md) and [browser collection guide](skills/web-gallery/references/browser.md) for commands and examples. Browser controls remain model-led; recipes guide actions and are not executable replay scripts. General flattened Nuxt extraction remains future work.

## Progress and recovery

Helper responses include `workflow.nextAction` and separate candidate/saved/rejected/duplicate counts. A blocked helper directs Codex to check the existing browser. A saved-image shortfall can be filled by collecting more and downloading again without resetting the cap, hash checks or transfer budget. Prefer a confirmed larger-image viewer over mixing thumbnail and viewer crops.

The ordered workflow is: recipe lookup, accessible browser, scoped collection, verification/review, then recipe finalisation. Recipes improve repeatability across layouts, but access restrictions and unfamiliar interactions can still require user help. No skill can guarantee that every model will interpret every website correctly.
