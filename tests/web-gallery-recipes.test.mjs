import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lookupRecipe, checkRecipe, checkPageElements, saveRecipe, validateRecipe } from '../skills/web-gallery/scripts/recipes.mjs';

const method = (overrides = {}) => ({ id: 'gallery-grid', name: 'Gallery grid',
  checks: [{ selector: '#gallery', reason: 'Dedicated gallery container' }],
  steps: ['Register #gallery as the selected gallery scope, then collect its observed variants.'],
  verification: ['Confirm the images and captions belong to the selected hotel.'], limitations: [], ...overrides });
const manifest = (overrides = {}) => ({ sourceUrl: 'https://example.com/hotels/one?tracking=private',
  pageUrl: 'https://example.com/hotels/one?tracking=private', status: 'downloaded', photos: [{ filename: '001.png' }],
  exploration: { status: 'limit' }, stopReason: 'image-cap',
  review: { verified: true, at: '2026-11-12T12:00:00.000Z', evidence: 'Checked manifest and sample; selected hotel matches.' }, ...overrides });
const draft = (overrides = {}) => ({ version: 1, hostname: 'example.com', methods: [method()], ...overrides });
const directory = () => mkdtemp(path.join(tmpdir(), 'gallery-recipes-'));

// These storage tests need no browser, network, or installed recipe files.
test('approved save, exact-host lookup and provenance retain methods without old image lists', async () => {
  const dir = await directory();
  assert.equal((await lookupRecipe('https://example.com/hotels/one', dir)).status, 'missing');
  const saved = await saveRecipe({ draft: draft(), manifest: manifest(), directory: dir, approved: true });
  assert.equal(saved.hostname, 'example.com');
  const lookup = await lookupRecipe('https://EXAMPLE.com/hotels/two', dir);
  assert.equal(lookup.status, 'found');
  assert.equal(lookup.recipe.methods[0].verified.url, 'https://example.com/hotels/one');
  assert.equal(lookup.recipe.methods[0].verified.at, '2026-11-12T12:00:00.000Z');
  assert.equal((await lookupRecipe('https://www.example.com/hotels/two', dir)).status, 'missing');
  assert.equal((await lookupRecipe('https://other.example/hotels/two', dir)).status, 'missing');
  assert.ok(!JSON.stringify(lookup.recipe).includes('001.png'));
  assert.ok(!JSON.stringify(lookup.recipe).includes('tracking'));
});

test('save guards reject unapproved, unsuccessful, unreviewed and wrong-domain runs but allow another path', async () => {
  const dir = await directory();
  await assert.rejects(saveRecipe({ draft: draft(), manifest: manifest(), directory: dir }), /approval/);
  for (const run of [manifest({ status: 'download-error' }), manifest({ photos: [] }),
    manifest({ exploration: { status: 'incomplete' } }), manifest({ review: undefined }),
    manifest({ stopReason: 'byte-budget' }), manifest({ pageUrl: 'https://other.example/hotels/one' })]) {
    await assert.rejects(saveRecipe({ draft: draft(), manifest: run, directory: dir, approved: true }));
  }
  const saved = await saveRecipe({ draft: draft(), manifest: manifest({ pageUrl: 'https://example.com/resorts/one?tracking=private' }),
    directory: dir, approved: true });
  assert.equal(saved.saved, true);
  assert.equal((await lookupRecipe('https://example.com/resorts/one', dir)).status, 'found');
  assert.equal((await lookupRecipe('https://example.com', dir)).status, 'found');
});

test('existing domains require an approved update and preserve unrelated methods', async () => {
  const dir = await directory();
  const options = { draft: draft(), manifest: manifest(), directory: dir, approved: true };
  await saveRecipe(options);
  const before = await readFile(path.join(dir, 'example.com.json'), 'utf8');
  await assert.rejects(saveRecipe(options), /already exists/);
  assert.equal(await readFile(path.join(dir, 'example.com.json'), 'utf8'), before);
  await assert.rejects(saveRecipe({ ...options, approved: false, update: true }), /approval/);
  await saveRecipe({ ...options, update: true, draft: draft({ methods: [method({ id: 'lightbox' })] }) });
  let lookup = await lookupRecipe('https://example.com', dir);
  assert.deepEqual(lookup.recipe.methods.map(({ id }) => id), ['gallery-grid', 'lightbox']);
  await saveRecipe({ ...options, update: true, draft: draft({ methods: [method({ name: 'Revised grid' })] }) });
  lookup = await lookupRecipe('https://example.com', dir);
  assert.deepEqual(lookup.recipe.methods.map(({ name }) => name), ['Revised grid', 'Gallery grid']);
});

test('malformed, oversized and unsupported files fall back without changing them', async () => {
  const dir = await directory();
  for (const contents of ['{broken', JSON.stringify({ version: 99 }), ' '.repeat(65537)]) {
    await writeFile(path.join(dir, 'example.com.json'), contents);
    const lookup = await lookupRecipe('https://example.com', dir);
    assert.equal(lookup.status, 'invalid');
    assert.ok(lookup.error);
    await assert.rejects(saveRecipe({ draft: draft(), manifest: manifest(), directory: dir, approved: true, update: true }), /invalid/);
    assert.equal(await readFile(path.join(dir, 'example.com.json'), 'utf8'), contents);
  }
  assert.throws(() => validateRecipe(draft({ hostname: '../outside' }), { draft: true }));
  assert.throws(() => validateRecipe(draft({ methods: [method(), method()] }), { draft: true }), /Duplicate/);
  assert.throws(() => validateRecipe(draft({ images: ['https://cdn.example/old.jpg'] }), { draft: true }), /Unknown/);
  assert.throws(() => validateRecipe(draft({ methods: [method({ checks: [] })] }), { draft: true }));
  assert.throws(() => validateRecipe(draft({ methods: [method({ pathPrefix: '/hotels' })] }), { draft: true }), /Unknown recipe field: pathPrefix/);
});

test('concurrent saves publish one complete file and leave no helper artefacts', async () => {
  const dir = await directory();
  const options = { draft: draft(), manifest: manifest(), directory: dir, approved: true };
  const results = await Promise.allSettled([saveRecipe(options), saveRecipe(options)]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.deepEqual(await readdir(dir), ['example.com.json']);
  assert.equal((await lookupRecipe('https://example.com', dir)).status, 'found');
});

test('applicability uses exact host and element content checks across paths', async () => {
  const dir = await directory();
  const hotelMethod = method({ checks: [{ selector: '#gallery', reason: 'Hotel gallery container', textIncludes: 'Hotel' }] });
  await saveRecipe({ draft: draft({ methods: [hotelMethod] }), manifest: manifest(), directory: dir, approved: true });
  const lookup = await lookupRecipe('https://example.com/hotels/one', dir);
  const page = (url, count, textContent = 'Hotel gallery') => ({ url: () => url, evaluate: async (_fn, checks) => {
    globalThis.document = { querySelectorAll: () => Array.from({ length: count }, () => ({
      localName: 'div', textContent,
    })) };
    try { return checkPageElements(checks); }
    finally { delete globalThis.document; }
  } });
  for (const url of ['https://example.com/hotels/one', 'https://example.com/resorts/another/gallery']) {
    const result = await checkRecipe(page(url, 1), lookup);
    assert.equal(result.status, 'matched');
    assert.equal(result.methods[0].id, 'gallery-grid');
  }
  assert.equal((await checkRecipe(page('https://example.com/resorts/another/gallery', 1, 'Our Suites'), lookup)).status, 'unmatched');
  assert.equal((await checkRecipe(page('https://other.example/hotels/one', 1), lookup)).status, 'unmatched');
  for (const count of [0, 2]) {
    const result = await checkRecipe(page('https://example.com/resorts/another/gallery', count), lookup);
    assert.equal(result.status, 'unmatched');
    assert.equal(result.methods.length, 0);
    assert.equal(result.checks[0].results[0].count, count);
  }
});

test('textIncludes is validated and only passes when the unique element contains expected text', async () => {
  assert.throws(() => validateRecipe(draft({ methods: [method({ checks: [{ selector: '#gallery', reason: 'Gallery', textIncludes: '' }] })] }), { draft: true }), /textIncludes/);
  globalThis.document = { querySelectorAll: () => [{ localName: 'div', textContent: 'Our Suites' }] };
  try {
    assert.equal(checkPageElements([{ selector: '#gallery', reason: 'Hotel gallery', textIncludes: 'Hotel' }])[0].passed, false);
    globalThis.document.querySelectorAll = () => [{ localName: 'div', textContent: 'Hotel Gallery' }];
    assert.equal(checkPageElements([{ selector: '#gallery', reason: 'Hotel gallery', textIncludes: 'Hotel' }])[0].passed, true);
  } finally { delete globalThis.document; }
});
