import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workflowStatus, finishRun, reviewManifest } from '../skills/web-gallery/scripts/workflow.mjs';
import { checkBrowserRecipe, validateRecipe, saveRecipe, lookupRecipe } from '../skills/web-gallery/scripts/recipes.mjs';

const method = { id: 'native-gallery', name: 'Gallery in the user browser',
  checks: [{ uiTextIncludes: 'See the gallery', reason: 'Observed gallery-opening control' }],
  steps: ['Open See the gallery, confirm the current page’s viewer and collect its photographs.'],
  verification: ['Review saved image samples and observed positions.'], limitations: [] };

test('workflow makes browser fallback, saved counts, review and recipe resolution explicit', () => {
  const run = { status: 'exploring', limits: { maxImages: 20 }, photos: [], access: { blocked: true } };
  assert.equal(workflowStatus(run).nextAction, 'use-browser');
  run.fallback = { available: true, evidence: 'Target tab opened successfully in Chrome' };
  assert.equal(workflowStatus(run).nextAction, 'continue-browser');
  run.access.blocked = false;
  assert.equal(workflowStatus(run).nextAction, 'identify-gallery');
  run.scopes = [{ selector: '#viewer' }];
  assert.equal(workflowStatus(run).nextAction, 'collect');
  run.candidateGroups = 25;
  assert.equal(workflowStatus(run).nextAction, 'download');
  Object.assign(run, { status: 'downloaded', photos: [{ filename: 'one.jpg' }], stopReason: 'candidates-exhausted', exploration: { status: 'limit' } });
  assert.equal(workflowStatus(run).nextAction, 'collect-more');
  assert.equal(workflowStatus(run).counters.remaining, 19);
  run.exploration.status = 'exhausted';
  assert.equal(workflowStatus(run).nextAction, 'review');
  run.review = { verified: true }; run.recipeSave = { eligible: true, action: 'create' };
  assert.equal(workflowStatus(run).nextAction, 'save-recipe');
  run.recipeSave.action = 'reuse';
  assert.equal(workflowStatus(run).nextAction, 'finish');
  run.finalisation = { complete: true };
  assert.deepEqual(workflowStatus(run).pending, []);
  assert.equal(workflowStatus(run).nextAction, 'report');
});

test('browser recipes use observed UI checks across paths and never assume DOM checks passed', () => {
  const recipe = { version: 1, hostname: 'example.com', methods: [method] };
  validateRecipe(recipe, { draft: true });
  const lookup = { status: 'found', recipe };
  assert.equal(checkBrowserRecipe({ url: 'https://example.com/another/gallery', text: 'Hotel B See the gallery' }, lookup).status, 'matched');
  assert.equal(checkBrowserRecipe({ url: 'https://other.example/gallery', text: 'See the gallery' }, lookup).status, 'unmatched');
  assert.equal(checkBrowserRecipe({ url: 'https://example.com', text: 'Booking form' }, lookup).status, 'unmatched');
  const domOnly = structuredClone(recipe); domOnly.methods[0].checks = [{ selector: '#gallery', reason: 'Dedicated DOM gallery' }];
  assert.equal(checkBrowserRecipe({ url: 'https://example.com', text: 'See the gallery' }, { status: 'found', recipe: domOnly }).status, 'unmatched');
  const observation = { url: 'https://example.com', text: '', elements: [{ selector: '#gallery', count: 1, localName: 'section', textContent: 'Hotel Gallery' }] };
  assert.equal(checkBrowserRecipe(observation, { status: 'found', recipe: domOnly }).status, 'matched');
  domOnly.methods[0].checks[0].textIncludes = 'Hotel';
  assert.equal(checkBrowserRecipe(observation, { status: 'found', recipe: domOnly }).status, 'matched');
  observation.elements[0].count = 2;
  assert.equal(checkBrowserRecipe(observation, { status: 'found', recipe: domOnly }).status, 'unmatched');
  const invalid = structuredClone(recipe); invalid.methods[0].checks[0].selector = '#gallery';
  assert.throws(() => validateRecipe(invalid, { draft: true }), /UI checks/);
});

test('partial cap runs cannot save recipes and blocked runs cannot finish without a browser attempt', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'gallery-workflow-test-'));
  const file = path.join(out, 'manifest.json');
  const run = { sourceUrl: 'https://example.com/gallery', pageUrl: 'https://example.com/gallery', status: 'incomplete',
    access: { blocked: true }, photos: [], limits: { maxImages: 20 }, finishedAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(run));
  await assert.rejects(finishRun({ manifestFile: file }), /browser/);
  run.fallback = { available: false, evidence: 'Checked browser inventory; host unavailable and no native browser tool present. User asked to stop.' };
  await writeFile(file, JSON.stringify(run));
  const result = await finishRun({ manifestFile: file });
  assert.equal(result.complete, false); assert.equal(result.recipe.status, 'ineligible');
  Object.assign(run, { status: 'downloaded', photos: [{ filename: 'one.jpg' }], exploration: { status: 'limit' }, stopReason: 'candidates-exhausted' });
  const review = await reviewManifest(run, { verified: true, evidence: 'Saved sample belongs to this gallery but the cap is unfilled.' }, out);
  assert.equal(review.recipeSave.eligible, false);
  assert.match(review.recipeSave.reason, /cap not filled/);
});

test('an existing unmatched layout directs an automatic update and keeps unrelated methods', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gallery-workflow-recipe-'));
  const run = { sourceUrl: 'https://example.com/gallery', pageUrl: 'https://example.com/gallery', status: 'downloaded',
    photos: [{ filename: 'one.jpg' }], limits: { maxImages: 1 }, exploration: { status: 'limit' }, stopReason: 'image-cap',
    review: { verified: true, evidence: 'Reviewed gallery sample.', at: new Date().toISOString() } };
  const old = { ...method, id: 'old-layout' };
  await saveRecipe({ draft: { version: 1, hostname: 'example.com', methods: [old] }, manifest: run, directory, approved: true });
  run.recipe = { status: 'unmatched' };
  assert.equal((await reviewManifest(run, { verified: true, evidence: 'New viewer layout reviewed.' }, directory)).recipeSave.action, 'update');
  await saveRecipe({ draft: { version: 1, hostname: 'example.com', methods: [method] }, manifest: run, directory, approved: true, update: true });
  assert.deepEqual((await lookupRecipe(run.pageUrl, directory)).recipe.methods.map(({ id }) => id), ['old-layout', 'native-gallery']);
});
