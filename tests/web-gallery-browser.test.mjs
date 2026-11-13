import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startBrowserRun, verifyBrowserCollection } from '../skills/web-gallery/scripts/browser.mjs';
import { reviewManifest, finishRun } from '../skills/web-gallery/scripts/workflow.mjs';
import { lookupRecipe } from '../skills/web-gallery/scripts/recipes.mjs';
import { png } from './fixtures/images.mjs';

const draft = { version: 1, hostname: 'example.com', methods: [{ id: 'browser-viewer', name: 'Native browser gallery',
  checks: [{ uiTextIncludes: 'Open gallery', reason: 'Observed gallery-opening control in the browser UI' }],
  steps: ['Open gallery, confirm the viewer, skip video slides and save its displayed photos.'],
  verification: ['Check positions, decoded dimensions and sampled images against this gallery.'], limitations: ['Original resolution is unproven.'] }] };

async function fixture(maxImages = 2) {
  const out = await mkdtemp(path.join(tmpdir(), 'gallery-browser-test-'));
  const directory = path.join(out, 'recipes');
  const run = await startBrowserRun({ url: 'https://example.com/gallery', maxImages, out, directory });
  const collection = JSON.parse(await readFile(run.collection, 'utf8'));
  collection.gallery = { openedBy: 'Clicked Open gallery on this page', identityEvidence: 'Page title and the opened photo viewer identify Hotel Example',
    largerImagesEvidence: 'Opened one thumbnail; saved the displayed larger image without changing its URL' };
  collection.observation = { url: collection.pageUrl, text: 'Hotel Example Open gallery' };
  collection.exploration = { status: 'limit', evidence: 'Requested image cap reached in saved photos, excluding the video at position 2' };
  collection.photos = [{ filename: 'one.png', position: '1 / 4' }, { filename: 'two.png', position: '3 / 4' }].slice(0, maxImages);
  collection.skipped = [{ position: '2 / 4', reason: 'Video slide; did not save its poster' }];
  for (const [i, photo] of collection.photos.entries()) await writeFile(path.join(run.runDir, photo.filename), png(900, 600, 50 + i));
  const save = () => writeFile(run.collection, `${JSON.stringify(collection, null, 2)}\n`);
  await save();
  return { ...run, directory, collectionData: collection, save };
}
const dimensions = async () => ({ width: 900, height: 600 });

test('native browser files verify, require review and draft, save automatically and reuse on another page', async () => {
  const f = await fixture();
  // Exercise the real existing-platform decoder, not just recorded dimensions.
  const verified = await verifyBrowserCollection({ collectionFile: f.collection, directory: f.directory });
  assert.equal(verified.saved, 2);
  assert.equal(verified.workflow.nextAction, 'review');
  await assert.rejects(finishRun({ manifestFile: f.manifest, directory: f.directory }), /Review/);
  const manifest = JSON.parse(await readFile(f.manifest, 'utf8'));
  assert.equal(manifest.photos[0].width, 900);
  assert.equal(manifest.photos[1].position, '3 / 4');
  assert.equal(manifest.browserVerification.skipped.length, 1);
  const review = await reviewManifest(manifest, { verified: true, evidence: 'Reviewed both real PNGs and their gallery positions; membership agrees.' }, f.directory);
  assert.equal(review.recipeSave.action, 'create');
  assert.equal(review.recipeSave.offer, false);
  await writeFile(f.manifest, JSON.stringify(manifest));
  await assert.rejects(finishRun({ manifestFile: f.manifest, directory: f.directory }), /--draft/);
  const draftFile = path.join(f.runDir, '.debug', 'recipe-draft.json');
  await writeFile(draftFile, JSON.stringify(draft));
  const result = await finishRun({ manifestFile: f.manifest, draftFile, directory: f.directory });
  assert.equal(result.complete, true);
  assert.equal(result.recipe.status, 'saved');
  assert.equal(result.workflow.nextAction, 'report');
  assert.equal((await finishRun({ manifestFile: f.manifest, directory: f.directory })).recipe.status, 'saved', 'retrying finish does not demand another draft or rewrite the recipe');
  assert.equal((await lookupRecipe('https://example.com/another-gallery', f.directory)).recipe.methods[0].checks[0].uiTextIncludes, 'Open gallery');
  // Re-verification checks this page afresh and clears old review/finalisation.
  f.collectionData.pageUrl = 'https://example.com/another-gallery';
  f.collectionData.observation.url = f.collectionData.pageUrl;
  await f.save();
  await verifyBrowserCollection({ collectionFile: f.collection, directory: f.directory, decode: dimensions });
  const reusedManifest = JSON.parse(await readFile(f.manifest, 'utf8'));
  assert.equal(reusedManifest.recipe.status, 'matched');
  assert.equal(reusedManifest.review, undefined);
  await reviewManifest(reusedManifest, { verified: true, evidence: 'Reviewed files against the current gallery.' }, f.directory);
  await writeFile(f.manifest, JSON.stringify(reusedManifest));
  assert.equal((await finishRun({ manifestFile: f.manifest, directory: f.directory })).recipe.status, 'reused');
});

test('browser verification rejects duplicate bytes, extras, cap overruns and invalid or undersized files', async () => {
  const duplicate = await fixture();
  await writeFile(path.join(duplicate.runDir, 'two.png'), png(900, 600, 50));
  await assert.rejects(verifyBrowserCollection({ collectionFile: duplicate.collection, decode: dimensions }), /duplicate/);
  const extra = await fixture();
  await writeFile(path.join(extra.runDir, 'unfinished.crdownload'), 'partial');
  await assert.rejects(verifyBrowserCollection({ collectionFile: extra.collection, decode: dimensions }), /Unrecorded/);
  const cap = await fixture(1);
  cap.collectionData.photos.push({ filename: 'two.png', position: '3 / 4' }); await cap.save();
  await assert.rejects(verifyBrowserCollection({ collectionFile: cap.collection, decode: dimensions }), /cap/);
  const small = await fixture(1);
  await assert.rejects(verifyBrowserCollection({ collectionFile: small.collection, decode: async () => ({ width: 40, height: 40 }) }), /undersized/);
  await writeFile(path.join(small.runDir, 'one.png'), '<html>not a photo</html>');
  await assert.rejects(verifyBrowserCollection({ collectionFile: small.collection, decode: dimensions }), /signature/);
});

test('browser verification rejects traversal, symlinks, repeated positions and wrong gallery host', async () => {
  const traversal = await fixture(1);
  traversal.collectionData.photos[0].filename = '../secret.png'; await traversal.save();
  await assert.rejects(verifyBrowserCollection({ collectionFile: traversal.collection, decode: dimensions }), /Unrecorded|plain local/);
  const linked = await fixture(1);
  await symlink(path.join(linked.runDir, 'one.png'), path.join(linked.runDir, 'linked.png'));
  linked.collectionData.photos.push({ filename: 'linked.png', position: '3 / 4' });
  const m = JSON.parse(await readFile(linked.manifest)); m.limits.maxImages = 2; await writeFile(linked.manifest, JSON.stringify(m));
  await linked.save();
  await assert.rejects(verifyBrowserCollection({ collectionFile: linked.collection, decode: dimensions }), /Unrecorded|symlink/);
  const positions = await fixture();
  positions.collectionData.photos[1].position = '1 / 4'; await positions.save();
  await assert.rejects(verifyBrowserCollection({ collectionFile: positions.collection, decode: dimensions }), /Repeated gallery position/);
  const host = await fixture();
  host.collectionData.pageUrl = 'https://other.example/gallery'; await host.save();
  await assert.rejects(verifyBrowserCollection({ collectionFile: host.collection, decode: dimensions }), /hostname/);
});

test('finalisation rejects changed files, changed records and unmatched browser recipe checks', async () => {
  for (const changed of ['file', 'record', 'draft']) {
    const f = await fixture(1);
    await verifyBrowserCollection({ collectionFile: f.collection, directory: f.directory, decode: dimensions });
    const manifest = JSON.parse(await readFile(f.manifest));
    await reviewManifest(manifest, { verified: true, evidence: 'Sample reviewed against the opened gallery.' }, f.directory);
    await writeFile(f.manifest, JSON.stringify(manifest));
    const draftFile = path.join(f.runDir, '.debug', 'recipe-draft.json');
    const method = structuredClone(draft);
    if (changed === 'file') await writeFile(path.join(f.runDir, 'one.png'), png(900, 600, 200));
    if (changed === 'record') { f.collectionData.photos[0].position = '4 / 4'; await f.save(); }
    if (changed === 'draft') method.methods[0].checks[0].uiTextIncludes = 'Unobserved control';
    await writeFile(draftFile, JSON.stringify(method));
    await assert.rejects(finishRun({ manifestFile: f.manifest, draftFile, directory: f.directory }), /changed|checks must match/);
  }
});

test('a closed blocked helper can continue through browser verification and recipe creation', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'gallery-fallback-test-'));
  await mkdir(path.join(out, '.debug'));
  const manifestFile = path.join(out, 'manifest.json');
  const original = { version: 1, sourceUrl: 'https://example.com/gallery', pageUrl: 'https://example.com/gallery',
    status: 'incomplete', finishedAt: new Date().toISOString(), access: { blocked: true }, photos: [],
    limits: { maxImages: 1, minEdge: 800, maxBytes: 104857600, maxFileBytes: 20971520 } };
  await writeFile(manifestFile, JSON.stringify(original));
  await assert.rejects(finishRun({ manifestFile }), /browser/);
  const run = await startBrowserRun({ manifestFile });
  assert.deepEqual(JSON.parse(await readFile(path.join(out, '.debug', 'helper-manifest.json'))), original);
  const c = JSON.parse(await readFile(run.collection));
  c.gallery = { openedBy: 'Clicked Open gallery', identityEvidence: 'Selected hotel title and viewer match', largerImagesEvidence: 'Saved the displayed gallery photo' };
  c.observation.text = 'Open gallery'; c.photos = [{ filename: 'one.png', position: '1 / 1' }];
  c.exploration = { status: 'limit', evidence: 'One requested photo saved' };
  await writeFile(path.join(out, 'one.png'), png()); await writeFile(run.collection, JSON.stringify(c));
  const directory = path.join(out, 'recipes');
  await verifyBrowserCollection({ collectionFile: run.collection, directory, decode: dimensions });
  const m = JSON.parse(await readFile(manifestFile));
  await reviewManifest(m, { verified: true, evidence: 'Checked the saved photo against the user browser gallery.' }, directory);
  assert.equal(m.recipeSave.action, 'create');
  await writeFile(manifestFile, JSON.stringify(m));
  const draftFile = path.join(out, '.debug', 'recipe-draft.json'); await writeFile(draftFile, JSON.stringify(draft));
  assert.equal((await finishRun({ manifestFile, draftFile, directory })).recipe.status, 'saved');
});

test('browser continuation recovers from blank navigation and a previously written backup/template', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'gallery-blank-test-'));
  await mkdir(path.join(out, '.debug'));
  const manifestFile = path.join(out, 'manifest.json');
  const original = { sourceUrl: 'https://example.com/gallery', pageUrl: 'about:blank', status: 'incomplete',
    finishedAt: new Date().toISOString(), access: { blocked: true }, photos: [], limits: { maxImages: 1, minEdge: 800, maxBytes: 104857600, maxFileBytes: 20971520 } };
  await writeFile(manifestFile, JSON.stringify(original));
  await copyFile(manifestFile, path.join(out, '.debug', 'helper-manifest.json'));
  const run = await startBrowserRun({ manifestFile, directory: path.join(out, 'recipes') });
  const collection = JSON.parse(await readFile(run.collection));
  assert.equal(collection.pageUrl, original.sourceUrl);
  assert.equal(run.workflow.nextAction, 'collect-browser');
  // Reproduce an interruption after creating the template but before publishing the new manifest.
  collection.gallery.identityEvidence = 'Preserve the already recorded observation';
  await writeFile(run.collection, JSON.stringify(collection));
  await writeFile(manifestFile, JSON.stringify(original));
  await startBrowserRun({ manifestFile, directory: path.join(out, 'recipes') });
  assert.equal(JSON.parse(await readFile(run.collection)).gallery.identityEvidence, collection.gallery.identityEvidence);
});

test('connected-browser DOM evidence can save and reuse a DOM recipe', async () => {
  const f = await fixture(1);
  f.collectionData.observation.elements = [{ selector: '#gallery', count: 1, localName: 'section', textContent: 'Hotel gallery' }];
  await f.save();
  await verifyBrowserCollection({ collectionFile: f.collection, directory: f.directory, decode: dimensions });
  let manifest = JSON.parse(await readFile(f.manifest));
  await reviewManifest(manifest, { verified: true, evidence: 'Reviewed the current gallery sample and observed DOM.' }, f.directory);
  await writeFile(f.manifest, JSON.stringify(manifest));
  const domDraft = structuredClone(draft);
  domDraft.methods[0].checks = [{ selector: '#gallery', textIncludes: 'Hotel', reason: 'Observed dedicated gallery element' }];
  const draftFile = path.join(f.runDir, '.debug', 'recipe-draft.json');
  await writeFile(draftFile, JSON.stringify(domDraft));
  assert.equal((await finishRun({ manifestFile: f.manifest, draftFile, directory: f.directory })).recipe.status, 'saved');
  await verifyBrowserCollection({ collectionFile: f.collection, directory: f.directory, decode: dimensions });
  manifest = JSON.parse(await readFile(f.manifest));
  assert.equal(manifest.recipe.status, 'matched');
  await reviewManifest(manifest, { verified: true, evidence: 'Checked the sample again.' }, f.directory);
  await writeFile(f.manifest, JSON.stringify(manifest));
  assert.equal((await finishRun({ manifestFile: f.manifest, directory: f.directory })).recipe.status, 'reused');
});

test('mixed collections keep helper files and enforce a combined cap', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'gallery-mixed-test-'));
  await mkdir(path.join(out, '.debug'));
  const bytes = png(900, 600, 100);
  await writeFile(path.join(out, 'helper.png'), bytes);
  const manifestFile = path.join(out, 'manifest.json');
  const helper = { sourceUrl: 'https://example.com/gallery', pageUrl: 'https://example.com/gallery', status: 'downloaded',
    finishedAt: new Date().toISOString(), photos: [{ filename: 'helper.png', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), width: 900, height: 600 }],
    limits: { maxImages: 2, minEdge: 800, maxBytes: 104857600, maxFileBytes: 20971520 } };
  await writeFile(manifestFile, JSON.stringify(helper));
  const directory = await mkdtemp(path.join(tmpdir(), 'gallery-mixed-recipes-'));
  const run = await startBrowserRun({ manifestFile, directory });
  const c = JSON.parse(await readFile(run.collection));
  c.gallery = { openedBy: 'Opened gallery', identityEvidence: 'Requested hotel and viewer agree', largerImagesEvidence: 'Viewer exposes the saved photograph' };
  c.observation.text = 'Open gallery';
  c.exploration = { status: 'limit', evidence: 'One helper file plus one browser photograph fill the cap' };
  c.photos = [{ filename: 'browser.png', position: '2 / 4' }];
  await writeFile(path.join(out, 'browser.png'), png(900, 600, 101));
  await writeFile(run.collection, JSON.stringify(c));
  assert.equal((await verifyBrowserCollection({ collectionFile: run.collection, directory, decode: dimensions })).saved, 2);
  const m = JSON.parse(await readFile(manifestFile));
  assert.equal(m.transport, 'mixed'); assert.equal(m.photos[0].filename, 'helper.png');
  await reviewManifest(m, { verified: true, evidence: 'Reviewed the helper and browser samples against the gallery.' }, directory);
  await writeFile(manifestFile, JSON.stringify(m));
  const draftFile = path.join(out, '.debug', 'recipe-draft.json'); await writeFile(draftFile, JSON.stringify(draft));
  assert.equal((await finishRun({ manifestFile, draftFile, directory })).recipe.status, 'saved');
  c.photos.push({ filename: 'extra.png', position: '3 / 4' }); await writeFile(run.collection, JSON.stringify(c));
  await assert.rejects(verifyBrowserCollection({ collectionFile: run.collection, directory, decode: dimensions }), /Combined.*cap/);
});

test('an explicit user refusal resolves the recipe outcome without writing a recipe', async () => {
  const f = await fixture(1);
  await verifyBrowserCollection({ collectionFile: f.collection, directory: f.directory, decode: dimensions });
  const manifest = JSON.parse(await readFile(f.manifest));
  await reviewManifest(manifest, { verified: true, evidence: 'Checked the saved gallery sample.' }, f.directory);
  await writeFile(f.manifest, JSON.stringify(manifest));
  const result = await finishRun({ manifestFile: f.manifest, directory: f.directory, recipeDeclined: 'User explicitly asked not to save a recipe for this run.' });
  assert.equal(result.complete, true);
  assert.equal(result.recipe.status, 'declined');
  assert.equal((await lookupRecipe(manifest.pageUrl, f.directory)).status, 'missing');
});
