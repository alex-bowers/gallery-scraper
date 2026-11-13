import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { compactInspection, inspectPage, extractGallery, imageIdentity, mergeCandidates } from '../skills/web-gallery/scripts/gallery.mjs';
import { downloadCandidates, readImage } from '../skills/web-gallery/scripts/download.mjs';
import { GallerySession, parseOptions } from '../skills/web-gallery/scripts/session.mjs';
import { checkPageElements, lookupRecipe, saveRecipe } from '../skills/web-gallery/scripts/recipes.mjs';

test('compact inspection keeps gallery controls and leaves full evidence unchanged', () => {
  const state = { url: 'https://example.com/gallery', title: 'Art collection',
    containers: Array.from({ length: 30 }, (_, i) => ({ selector: `#container-${i}`, images: i })),
    controls: Array.from({ length: 120 }, (_, i) => ({ selector: `#control-${i}`, label: `Link ${i}`, href: 'https://example.com/' + 'x'.repeat(300) })),
    dataSources: [], details: { html: '<div>Requested detail</div>' } };
  state.controls[0].label = 'Rooms & Suites';
  state.controls[118].label = 'View images';
  state.controls[119].label = 'See the gallery';
  const result = compactInspection(state);
  assert.equal(result.controls.length, 24);
  assert.equal(result.containers.length, 8);
  assert.deepEqual(result.controls.slice(0, 2).map(({ label }) => label), ['View images', 'See the gallery']);
  assert.equal(result.controls[0].href, undefined);
  assert.equal(result.available.controls, 120);
  assert.equal(state.controls[119].href.length > 300, true);
  assert.equal(result.details.html, state.details.html);
  assert.ok(JSON.stringify(result).length < JSON.stringify(state).length / 4);
});

test('run options require an explicit positive image cap', () => {
  for (const value of [undefined, '0', '-1', '1.5', 'abc']) {
    const args = ['--url', 'https://example.com/gallery'];
    if (value !== undefined) args.push('--max-images', value);
    assert.throws(() => parseOptions(args), /max-images/);
  }
  assert.equal(parseOptions(['--url', 'https://example.com', '--max-images', '2']).maxImages, 2);
  assert.throws(() => parseOptions(['--url', 'file:///etc/passwd', '--max-images', '2']), /HTTP/);
  assert.notEqual(imageIdentity('https://example.com/image?id=one&w=400'), imageIdentity('https://example.com/image?id=two&w=400'));
  assert.equal(imageIdentity('https://example.com/image?id=one&w=400'), imageIdentity('https://example.com/image?w=1600&id=one'));
});

test('overlapping observed variants merge grid and viewer groups without guessing crop URLs', () => {
  const groups = new Map();
  const evidence = { selector: '#gallery', reason: 'Selected gallery' };
  const item = (urls) => ({ identityUrl: urls[0], alt: 'Shared caption', variants: urls.map((url) => ({ url, priority: 0, widthHint: 0 })) });
  mergeCandidates(groups, [item(['https://cdn.example/small/a.jpg'])], evidence, 20);
  mergeCandidates(groups, [item(['https://cdn.example/large/a.jpg', 'https://cdn.example/small/a.jpg'])], evidence, 20);
  assert.equal(groups.size, 1);
  assert.equal([...groups.values()][0].variants.length, 2);
  // A matching filename/caption cannot prove two different crop paths equivalent.
  mergeCandidates(groups, [item(['https://cdn.example/crop/a.jpg'])], evidence, 20);
  assert.equal(groups.size, 2);
  mergeCandidates(groups, [item(['https://cdn.example/crop/a.jpg', 'https://cdn.example/large/a.jpg'])], evidence, 20);
  assert.equal(groups.size, 1, 'an observed bridge can join previously separate groups');
});

test('gallery extraction and downloads against a local browser fixture', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const makePng = async (width, height, colour) => Buffer.from(await page.evaluate(({ width, height, colour }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = colour;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height, colour }), 'base64');
  const files = {
    '/a.png': await makePng(1200, 800, 'blue'),
    '/b.png': await makePng(900, 1200, 'red'),
    '/c.png': await makePng(1400, 900, 'green'),
    '/small.png': await makePng(900, 600, 'blue'),
    '/tiny.png': await makePng(40, 40, 'black'),
  };
  files['/alias.png'] = files['/a.png'];
  files['/one/photo.png'] = files['/a.png'];
  files['/two/photo.png'] = files['/b.png'];
  files['/cdn/resize,w_1600/a.png'] = files['/a.png'];
  const requested = [];
  const fixture = `<!doctype html><html><head><title>Fixture art collection</title></head><body>
    <header id="header"><img src="/c.png" alt="Brand hero"></header>
    <nav><img src="/c.png" alt="Promotion"></nav>
    <button id="open" onclick="document.querySelector('#lightbox').hidden=false">See the gallery</button>
    <section id="gallery" aria-label="Artwork gallery">
      <img src="/tiny.png" data-original="/a.png" alt="Landscape painting">
      <picture><source srcset="/small.png 900w, /cdn/resize,w_1600/a.png 1600w"><img src="/small.png" alt="Sculpture"></picture>
      <nav><img src="/c.png" alt="Unrelated nested navigation"></nav>
      <footer><img src="/c.png" alt="Unrelated nested footer"></footer>
      <img src="/c.png" alt="Brand logo">
    </section>
    <div id="lightbox" role="dialog" hidden><img src="/b.png" alt="Ceramic artwork"></div>
    <footer id="footer"><img src="/c.png" alt="Other destination"></footer>
  </body></html>`;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    requested.push(pathname);
    if (pathname === '/reset') { request.socket.destroy(); return; }
    if (pathname === '/redirect-gallery') { response.writeHead(302, { location: `${origin.replace('127.0.0.1', 'localhost')}/gallery` }); response.end(); return; }
    if (pathname === '/gallery' || pathname.startsWith('/gallery/')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end(fixture); return; }
    if (pathname === '/html.jpg') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>Not an image</html>'); return; }
    if (pathname === '/broken.jpg') { response.writeHead(200, { 'content-type': 'image/jpeg' }); response.end(Buffer.from([255, 216, 255, 0, 1])); return; }
    if (pathname === '/redirect') { response.writeHead(302, { location: '/a.png' }); response.end(); return; }
    if (pathname === '/chunked.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.write(files['/a.png']); response.end(); return;
    }
    const file = files[pathname];
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': file.length });
    response.end(file);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const decode = (bytes, type) => page.evaluate(async ({ base64, type }) => {
    const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data], { type }));
    const result = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  }, { base64: bytes.toString('base64'), type });
  const makeGroup = (urls) => ({ key: urls[0], alt: 'Fixture gallery image',
    evidence: [{ selector: '#gallery', reason: 'Local artwork fixture gallery' }],
    variants: urls.map((url) => ({ url: `${origin}${url}`, priority: 0, widthHint: 0 })) });
  const makeOptions = async (groups, overrides = {}) => ({ groups, decode, referer: `${origin}/gallery`,
    runDir: await mkdtemp(path.join(tmpdir(), 'web-gallery-test-')), maxImages: 2,
    maxBytes: 1024 * 1024, maxFileBytes: 1024 * 1024, minEdge: 800, ...overrides });

  await t.test('gallery membership excludes header, footer, navigation and logos; lightboxes need a scope', async () => {
    await page.goto(`${origin}/gallery`, { waitUntil: 'load' });
    const batch = await page.evaluate(extractGallery, { selector: '#gallery', maxCandidates: 20 });
    assert.equal(batch.items.length, 2);
    assert.deepEqual(batch.items.map(({ alt }) => alt), ['Landscape painting', 'Sculpture']);
    const urls = batch.items.flatMap(({ variants }) => variants.map(({ url }) => url));
    assert.ok(urls.includes(`${origin}/a.png`));
    assert.ok(urls.includes(`${origin}/cdn/resize,w_1600/a.png`), 'srcset URLs containing commas survive parsing');
    assert.ok(!urls.includes(`${origin}/b.png`));
    assert.ok(!urls.includes(`${origin}/c.png`));
    for (const selector of ['body', 'html', '#header', '#footer', 'img']) {
      await assert.rejects(page.evaluate(extractGallery, { selector, maxCandidates: 20 }), /specific gallery|exactly one/);
    }
    await page.locator('#open').click();
    const lightbox = await page.evaluate(extractGallery, { selector: '#lightbox', maxCandidates: 20 });
    assert.equal(lightbox.items.length, 1);
    assert.ok(lightbox.items[0].variants.some(({ url }) => url === `${origin}/b.png`));
    assert.equal((await page.evaluate(extractGallery, { selector: '#gallery', maxCandidates: 1 })).truncated, true);
  });

  await t.test('candidate limits and variant grouping retain distinct image identities', () => {
    const groups = new Map();
    const items = ['/a.png?w=400', '/a.png?w=1600', '/b.png', '/c.png'].map((name) => ({
      identityUrl: `${origin}${name}`, variants: [{ url: `${origin}${name}`, widthHint: 0, priority: 0 }],
    }));
    const result = mergeCandidates(groups, items, { selector: '#gallery', reason: 'Fixture' }, 2);
    assert.equal(groups.size, 2);
    assert.equal([...groups.values()][0].variants.length, 2);
    assert.equal(result.truncated, true);
  });

  await t.test('invalid, small and duplicate files do not consume the saved image cap', async () => {
    requested.length = 0;
    const options = await makeOptions(['/html.jpg', '/broken.jpg', '/tiny.png', '/one/photo.png', '/alias.png', '/two/photo.png', '/c.png'].map((url) => makeGroup([url])));
    const result = await downloadCandidates(options);
    assert.equal(result.photos.length, 2);
    assert.equal(result.stopReason, 'image-cap');
    assert.equal(result.attempts.filter(({ status }) => status === 'rejected').length, 3);
    assert.equal(result.attempts.filter(({ status }) => status === 'duplicate-content').length, 1);
    assert.ok(!requested.includes('/c.png'), 'no extra image is requested once the cap is filled');
    assert.equal((await readdir(options.runDir)).length, 2);
    assert.equal(result.photos[1].width, 900, 'portrait images are accepted by longest edge');
  });

  await t.test('the largest actually decoded variant wins and keeps its real file type', async () => {
    const result = await downloadCandidates(await makeOptions([makeGroup(['/small.png', '/a.png'])]));
    assert.equal(result.photos.length, 1);
    assert.equal(result.photos[0].width, 1200);
    assert.equal(result.photos[0].height, 800);
    assert.match(result.photos[0].filename, /\.png$/);
    assert.equal(result.attempts.filter(({ status }) => status === 'verified').length, 2);
  });

  await t.test('inspection identifies helper restrictions and exposes image targets; descriptorless sources survive', async () => {
    const inspect = await browser.newPage();
    t.after(() => inspect.close());
    await inspect.setContent('<h1>Access Restricted</h1><p>Your browser did something unexpected</p>');
    assert.equal((await inspect.evaluate(inspectPage)).access.blocked, true);
    await inspect.setContent(`<section id="viewer"><a role="button"><img alt="Gallery photograph" src="${origin}/small.png"></a>
      <picture><source srcset="${origin}/a.png"><img src="${origin}/tiny.png" alt="Expanded photo"></picture>
      <video poster="${origin}/c.png"></video></section>`);
    const state = await inspect.evaluate(inspectPage);
    assert.equal(state.access.blocked, false);
    assert.ok(state.controls.some(({ label, role }) => label === 'Gallery photograph' && role === 'img'));
    const batch = await inspect.evaluate(extractGallery, { selector: '#viewer', maxCandidates: 20 });
    assert.ok(batch.items.some(({ variants }) => variants.some(({ url }) => url === `${origin}/a.png`)));
    assert.ok(!batch.items.some(({ variants }) => variants.some(({ url }) => url === `${origin}/c.png`)), 'video posters are not photos');
  });

  await t.test('downloads resume after rejected or duplicate candidates and retain caps, hashes and transfer totals', async () => {
    const options = await makeOptions([makeGroup(['/tiny.png']), makeGroup(['/a.png'])]);
    const first = await downloadCandidates(options);
    assert.equal(first.photos.length, 1);
    assert.equal(first.stopReason, 'candidates-exhausted');
    const before = requested.length;
    const second = await downloadCandidates({ ...options, groups: [makeGroup(['/tiny.png']), makeGroup(['/a.png']),
      makeGroup(['/alias.png']), makeGroup(['/b.png']), makeGroup(['/c.png'])], prior: first });
    assert.equal(second.photos.length, 2);
    assert.equal(second.stopReason, 'image-cap');
    assert.ok(second.downloadedBytes > first.downloadedBytes);
    assert.equal(second.attempts.filter(({ status }) => status === 'duplicate-content').length, 1);
    assert.deepEqual(requested.slice(before), ['/alias.png', '/b.png']);
    const limited = await downloadCandidates({ ...options, prior: first, groups: [makeGroup(['/b.png'])], maxBytes: first.downloadedBytes });
    assert.equal(limited.stopReason, 'byte-budget');
    assert.equal(limited.photos.length, 1);
  });

  await t.test('session supports viewer-only replacement and topping up within the same run', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'web-gallery-topup-'));
    const session = new GallerySession(parseOptions(['--url', `${origin}/gallery`, '--max-images', '2', '--out', out]));
    t.after(() => session.close('test-cleanup'));
    await session.start();
    await session.page.setContent(`<section id="grid"><img src="${origin}/tiny.png"></section>
      <section id="viewer"><img src="${origin}/a.png"></section>`);
    await session.dispatch({ type: 'scope', selector: '#grid', reason: 'Original gallery grid' });
    await session.dispatch({ type: 'collect' });
    await session.dispatch({ type: 'scope', selector: '#viewer', reason: 'Larger image viewer opened from that grid', replace: true });
    assert.deepEqual([...session.scopes.keys()], ['#viewer']);
    assert.equal(session.groups.size, 0);
    await session.dispatch({ type: 'collect' });
    assert.equal((await session.dispatch({ type: 'download', exploration: 'limit', evidence: 'Collected initial viewer candidates' })).saved, 1);
    assert.equal((await session.dispatch({ type: 'status' })).nextAction, 'collect-more');
    await session.dispatch({ type: 'add', urls: [`${origin}/b.png`], evidence: 'Exact URL observed in this viewer’s gallery metadata' });
    assert.equal((await session.dispatch({ type: 'download', exploration: 'limit', evidence: 'Another observed gallery image fills the cap' })).saved, 2);
    assert.equal((await session.dispatch({ type: 'status' })).nextAction, 'review');
  });

  await t.test('failed navigation preserves a usable HTTP URL and directs browser fallback', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'web-gallery-navigation-'));
    const session = new GallerySession(parseOptions(['--url', `${origin}/reset`, '--max-images', '2', '--out', out]));
    t.after(() => session.close('test-cleanup'));
    await session.start();
    assert.equal(session.manifest.pageUrl, `${origin}/reset`);
    assert.equal((await session.dispatch({ type: 'status' })).nextAction, 'use-browser');
    await session.dispatch({ type: 'fallback', available: true, evidence: 'Local fixture simulates an accessible existing browser tab' });
    assert.equal((await session.dispatch({ type: 'status' })).nextAction, 'continue-browser');
    const closed = await session.dispatch({ type: 'close', reason: 'Continue in browser' });
    assert.equal(closed.closed, true);
  });

  await t.test('startup checks the destination hostname recipe after a cross-host redirect', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'web-gallery-redirect-'));
    const recipes = path.join(out, 'recipes');
    const destination = `${origin.replace('127.0.0.1', 'localhost')}/gallery`;
    await saveRecipe({ directory: recipes, approved: true,
      draft: { version: 1, hostname: 'localhost', methods: [{ id: 'gallery', name: 'Gallery',
        checks: [{ selector: '#gallery', reason: 'Fixture gallery' }], steps: ['Collect #gallery.'], verification: ['Review gallery samples.'], limitations: [] }] },
      manifest: { pageUrl: destination, status: 'downloaded', photos: [{ filename: 'fixture.png' }], exploration: { status: 'limit' },
        stopReason: 'image-cap', review: { verified: true, evidence: 'Fixture sample reviewed.', at: new Date().toISOString() } } });
    const session = new GallerySession({ ...parseOptions(['--url', `${origin}/redirect-gallery`, '--max-images', '1', '--out', out]), recipeDirectory: recipes });
    t.after(() => session.close('test-cleanup'));
    const state = await session.start();
    assert.equal(state.recipe.status, 'matched');
    assert.equal(state.recipe.hostname, 'localhost');
    assert.equal(session.manifest.pageUrl, destination);
  });

  await t.test('verified progress survives a later output failure', async () => {
    const progress = [];
    const options = await makeOptions([makeGroup(['/a.png']), makeGroup(['/b.png'])]);
    options.onProgress = async (state) => {
      progress.push(state.photos.length);
      if (state.photos.length === 2) throw new Error('Fixture manifest write failed');
    };
    await assert.rejects(downloadCandidates(options), /manifest write failed/);
    assert.deepEqual(progress, [1, 2]);
    assert.equal((await readdir(options.runDir)).length, 2);
  });

  await t.test('relative redirects work and malformed image signatures fail', async () => {
    const redirected = await readImage(`${origin}/redirect`, { budget: { max: 1000000, received: 0 }, maxFileBytes: 1000000, referer: origin });
    assert.equal(redirected.finalUrl, `${origin}/a.png`);
    assert.equal(redirected.type, 'image/png');
    await assert.rejects(readImage(`${origin}/html.jpg`, { budget: { max: 1000000, received: 0 }, maxFileBytes: 1000000, referer: origin }), /content type/);
  });

  await t.test('streamed byte overruns stop further downloads without saving partial files', async () => {
    const options = await makeOptions([makeGroup(['/chunked.png']), makeGroup(['/b.png'])], { maxBytes: 16 });
    const result = await downloadCandidates(options);
    assert.equal(result.photos.length, 0);
    assert.equal(result.stopReason, 'byte-budget');
    assert.ok(result.downloadedBytes > 16, 'account for the in-flight chunk that triggers cancellation');
    assert.deepEqual(await readdir(options.runDir), []);
  });

  await t.test('session commands preserve gallery evidence, cap downloads and write a manifest', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'web-gallery-session-'));
    const options = parseOptions(['--url', `${origin}/gallery`, '--max-images', '1', '--out', out, '--max-actions', '1']);
    const session = new GallerySession(options);
    t.after(() => session.close('test-cleanup'));
    const state = await session.start();
    assert.equal(state.title, 'Fixture art collection');
    assert.match(path.basename(state.runDir), /^web-gallery-/);
    assert.ok(state.controls.some(({ selector }) => selector === '#open'));
    const details = await session.dispatch({ type: 'inspect', selector: '#gallery' });
    assert.match(details.details.html, /data-original="\/a.png"/);
    await assert.rejects(session.dispatch({ type: 'collect' }), /scope/);
    await session.dispatch({ type: 'scope', selector: '#gallery', reason: 'Artwork gallery fixture' });
    const collection = await session.dispatch({ type: 'collect' });
    assert.equal(collection.groups, 2);
    await session.dispatch({ type: 'act', action: 'click', selector: '#open' });
    await assert.rejects(session.dispatch({ type: 'act', action: 'key', key: 'ArrowRight' }), /budget/);
    const result = await session.dispatch({ type: 'download', exploration: 'incomplete', evidence: 'Stopped at the fixture interaction budget' });
    assert.equal(result.saved, 1);
    const review = await session.dispatch({ type: 'review', verified: true, evidence: 'Fixture image matches, but exploration was incomplete.' });
    assert.equal(review.recipeSave.eligible, false);
    assert.equal(review.recipeSave.offer, false);
    assert.equal((await session.dispatch({ type: 'collect' })).groups, 2, 'collection can resume after a download');
    await session.close('fixture-finished');
    const manifest = JSON.parse(await readFile(path.join(result.runDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.photos.length, 1);
    assert.equal(manifest.photos[0].width, 1200);
    assert.equal(manifest.scopes[0].selector, '#gallery');
    assert.equal(manifest.exploration.status, 'incomplete');
    assert.equal(manifest.closeReason, 'fixture-finished');
  });

  await t.test('a reviewed new domain can be saved after close and reused on another gallery', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'web-gallery-recipes-browser-'));
    const recipes = path.join(out, 'recipes');
    const options = (url) => ({ ...parseOptions(['--url', url, '--max-images', '1', '--out', out]), recipeDirectory: recipes });
    const session = new GallerySession(options(`${origin}/gallery/one`));
    t.after(() => session.close('test-cleanup'));
    assert.equal((await session.start()).recipe.status, 'missing');
    await assert.rejects(session.dispatch({ type: 'review', verified: true, evidence: 'Too early' }), /Download/);
    await session.dispatch({ type: 'scope', selector: '#gallery', reason: 'Fixture artwork gallery' });
    await session.dispatch({ type: 'collect' });
    const result = await session.dispatch({ type: 'download', exploration: 'limit', evidence: 'Requested fixture image collected' });
    assert.equal(result.saved, 1);
    await assert.rejects(session.dispatch({ type: 'review', verified: true }), /evidence/);
    const unverified = await session.dispatch({ type: 'review', verified: false, evidence: 'Sample not yet reviewed' });
    assert.equal(unverified.recipeSave.offer, false);
    const photo = session.manifest.photos[0];
    assert.ok(photo.evidence.some(({ selector }) => selector === '#gallery'));
    const review = await session.dispatch({ type: 'review', verified: true,
      evidence: 'Fixture manifest and decoded landscape image belong to the artwork gallery.' });
    assert.equal(review.recipeSave.eligible, true);
    assert.equal(review.recipeSave.offer, false);
    assert.equal(review.recipeSave.action, 'create');
    assert.equal((await lookupRecipe(origin, recipes)).status, 'missing', 'review does not save automatically');
    await session.close('reviewed');
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    const draft = { version: 1, hostname: '127.0.0.1', methods: [{ id: 'artwork', name: 'Artwork gallery',
      checks: [{ selector: '#gallery', reason: 'Selected artwork section' }],
      steps: ['Scope #gallery, then collect its image variants.'], verification: ['Check the selected artwork.'], limitations: [] }] };
    const draftFile = path.join(out, 'recipe-draft.json');
    await writeFile(draftFile, JSON.stringify(draft));
    // The separate save CLI remains available after the browser has closed.
    const child = spawn(process.execPath, ['skills/web-gallery/scripts/recipes.mjs', 'save', '--draft', draftFile,
      '--manifest', result.manifest, '--directory', recipes, '--approved']);
    let output = ''; let stderr = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(output).result.saved, true);
    assert.equal(manifest.recipeSave.action, 'create');
    const repeat = new GallerySession(options(`${origin}/gallery/two`));
    t.after(() => repeat.close('test-cleanup'));
    const state = await repeat.start();
    assert.equal(state.recipe.status, 'matched');
    assert.equal(state.recipe.methods[0].id, 'artwork');
    assert.equal(repeat.groups.size, 0, 'recipe lookup never collects or navigates automatically');
    await repeat.page.locator('#gallery').evaluate((element) => element.remove());
    assert.equal((await repeat.dispatch({ type: 'recipe' })).status, 'unmatched');
    await repeat.page.goto(`${origin}/gallery/two`);
    await repeat.dispatch({ type: 'scope', selector: '#gallery', reason: 'Fixture artwork gallery' });
    await repeat.dispatch({ type: 'collect' });
    await repeat.dispatch({ type: 'download', exploration: 'limit', evidence: 'Requested fixture image collected' });
    const existing = await repeat.dispatch({ type: 'review', verified: true, evidence: 'Reviewed fixture gallery sample and manifest' });
    assert.equal(existing.recipeSave.eligible, true);
    assert.equal(existing.recipeSave.offer, false, 'existing domains do not prompt again');
  });

  await t.test('embedded JSON applicability checks reject missing paths, malformed data and ambiguous selectors', async () => {
    const fixturePage = await browser.newPage();
    t.after(() => fixturePage.close());
    await fixturePage.setContent('<script id="gallery-data" type="application/json">{"props":{"galleries":[{"media":[{"src":"/a.png"}]}]}}</script>');
    const check = { selector: '#gallery-data', reason: 'Gallery media data',
      jsonPath: ['props', 'galleries', '*', 'media'], valueType: 'array' };
    assert.equal((await fixturePage.evaluate(checkPageElements, [check]))[0].passed, true);
    for (const jsonPath of [['missing'], ['props', 'galleries', '*', 'wrong'], ['__proto__']]) {
      assert.equal((await fixturePage.evaluate(checkPageElements, [{ ...check, jsonPath }]))[0].passed, false);
    }
    await fixturePage.locator('#gallery-data').evaluate((element) => { element.textContent = '{broken'; });
    assert.equal((await fixturePage.evaluate(checkPageElements, [check]))[0].passed, false);
    await fixturePage.setContent('<div class="gallery"></div><div class="gallery"></div>');
    const result = await fixturePage.evaluate(checkPageElements, [{ selector: '.gallery' }, { selector: '[' }]);
    assert.equal(result[0].passed, false);
    assert.equal(result[0].count, 2);
    assert.equal(result[1].passed, false);
  });

  await t.test('the CLI works through an installed-style symlink and accepts commands during startup', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'web-gallery-cli-'));
    const installed = path.join(out, 'web-gallery');
    await symlink(path.resolve('skills/web-gallery'), installed);
    const child = spawn(process.execPath, [path.join(installed, 'scripts/session.mjs'), '--url', `${origin}/gallery`, '--max-images', '1', '--out', out], { cwd: tmpdir() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const commands = [
      { type: 'scope', selector: '#gallery', reason: 'Fixture art collection gallery' }, { type: 'collect' },
      { type: 'download', exploration: 'limit', evidence: 'One requested image available in the gallery' },
      { type: 'close', reason: 'CLI test finished' },
    ];
    child.stdin.end(commands.map((command) => JSON.stringify(command)).join('\n') + '\n');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr || stdout);
    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(responses.length, 5, stdout);
    assert.ok(responses.every(({ ok }) => ok), stdout);
    assert.equal(responses[3].result.saved, 1);
    assert.equal(responses[4].result.closed, true);
  });

  await t.test('repeat collects each step and stops at the candidate cap or lack of progress', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'web-gallery-repeat-'));
    const session = new GallerySession(parseOptions(['--url', `${origin}/gallery`, '--max-images', '3', '--out', out]));
    t.after(() => session.close('test-cleanup'));
    await session.start();
    await session.page.setContent(`<section id="gallery"><img src="${origin}/a.png" alt="Landscape painting"></section>
      <button id="next" onclick="this.n=(this.n||0)+1;document.querySelector('img').src=['${origin}/b.png','${origin}/c.png'][Math.min(this.n-1,1)]">Next</button>`);
    await session.dispatch({ type: 'scope', selector: '#gallery', reason: 'Fixture gallery' });
    await assert.rejects(session.dispatch({ type: 'repeat', steps: 21, action: { action: 'click', selector: '#next' } }), /1–20/);
    const cap = await session.dispatch({ type: 'repeat', steps: 10, action: { action: 'click', selector: '#next' } });
    assert.equal(cap.stopReason, 'candidate-cap');
    assert.equal(cap.steps, 2);
    assert.equal(cap.groups, 3);
    const compact = await session.dispatch({ type: 'inspect' });
    const full = JSON.parse(await readFile(compact.inspection, 'utf8'));
    assert.equal(full.controls[0].label, 'Next');
    session.groups.clear();
    const stalled = await session.dispatch({ type: 'repeat', steps: 10, action: { action: 'click', selector: '#next' } });
    assert.equal(stalled.stopReason, 'no-progress');
    assert.equal(stalled.steps, 3);
    const failed = await session.dispatch({ type: 'repeat', steps: 2, action: { action: 'click', selector: '#missing' } });
    assert.equal(failed.stopReason, 'action-error');
    assert.match(failed.error, /exactly one/);
    await session.page.locator('#next').evaluate((el) => { el.disabled = true; });
    const disabled = await session.dispatch({ type: 'repeat', steps: 10, action: { action: 'click', selector: '#next' } });
    assert.equal(disabled.stopReason, 'disabled-control');
    assert.equal(disabled.steps, 0);
    await session.page.locator('#next').evaluate((el) => { el.disabled = false; });
    session.options.maxActions = session.actions;
    const budget = await session.dispatch({ type: 'repeat', steps: 10, action: { action: 'click', selector: '#next' } });
    assert.equal(budget.stopReason, 'action-error');
    assert.match(budget.error, /budget/);
    await session.page.locator('#gallery').evaluate((el) => el.remove());
    const absent = await session.dispatch({ type: 'repeat', steps: 10, action: { action: 'click', selector: '#next' } });
    assert.equal(absent.stopReason, 'collection-warning');
    assert.equal(absent.steps, 0);
  });
});
