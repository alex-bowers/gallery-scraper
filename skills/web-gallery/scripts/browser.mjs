#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, lstat, readdir, copyFile } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { imageIdentity } from './gallery.mjs';
import { imageType } from './download.mjs';
import { readJson, lookupRecipe, checkBrowserRecipe } from './recipes.mjs';
import { workflowStatus } from './workflow.mjs';

const executeFile = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const requiredText = (value, name, max = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Supply ${name} (up to ${max} characters)`);
};

export async function startBrowserRun({ url, maxImages, out = './gallery-runs', minEdge = 800, manifestFile, directory }) {
  let manifest;
  let runDir;
  let helperSnapshot;
  if (manifestFile) {
    manifest = await readJson(manifestFile, 8 * 1024 * 1024);
    if (!manifest.finishedAt) throw new Error('Close the helper before continuing its run in the browser');
    if (manifest.transport === 'browser' || manifest.transport === 'mixed') throw new Error('Browser continuation already started; use its collection file');
    runDir = path.dirname(path.resolve(manifestFile));
    await mkdir(path.join(runDir, '.debug'), { recursive: true });
    helperSnapshot = structuredClone(manifest);
    try { imageIdentity(manifest.pageUrl); } catch { manifest.pageUrl = manifest.sourceUrl; }
    manifest.transport = manifest.photos.length ? 'mixed' : 'browser';
    manifest.fallback = { available: true, evidence: 'Browser continuation started; file verification and observed gallery evidence are still required.' };
  } else {
    imageIdentity(url);
    integer(maxImages, 'maxImages'); integer(minEdge, 'minEdge');
    await mkdir(out, { recursive: true });
    runDir = await mkdtemp(path.join(path.resolve(out), 'web-gallery-'));
    await mkdir(path.join(runDir, '.debug'));
    manifest = { version: 1, sourceUrl: url, pageUrl: url, transport: 'browser', status: 'exploring',
      startedAt: new Date().toISOString(), photos: [], limits: { maxImages, minEdge,
        maxBytes: 104857600, maxFileBytes: 20971520 },
      limitations: ['Largest observed image is not necessarily original resolution.',
        'Exact hashes do not identify every resized, cropped or recompressed duplicate.'] };
  }
  manifest.status = 'exploring';
  delete manifest.review; delete manifest.recipeSave; delete manifest.finalisation;
  const lookup = await lookupRecipe(manifest.pageUrl || manifest.sourceUrl, directory);
  if (helperSnapshot) {
    const backup = path.join(runDir, '.debug', 'helper-manifest.json');
    try { await copyFile(manifestFile, backup, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST' || JSON.stringify(await readJson(backup, 8 * 1024 * 1024)) !== JSON.stringify(helperSnapshot)) throw error;
    }
  }
  const collection = { version: 1, sourceUrl: manifest.sourceUrl, pageUrl: manifest.pageUrl || manifest.sourceUrl,
    gallery: { openedBy: '', identityEvidence: '', largerImagesEvidence: '' },
    observation: { url: manifest.pageUrl || manifest.sourceUrl, text: '' },
    exploration: { status: 'incomplete', evidence: '' }, photos: [], skipped: [] };
  const collectionFile = path.join(runDir, 'browser-collection.json');
  try { await writeFile(collectionFile, `${JSON.stringify(collection, null, 2)}\n`, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readJson(collectionFile, 4 * 1024 * 1024);
    if (existing.version !== 1 || existing.sourceUrl !== manifest.sourceUrl) throw new Error('Preserve the unrelated existing browser collection file');
  }
  await writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { runDir, collection: collectionFile, manifest: path.join(runDir, 'manifest.json'),
    recipe: { ...lookup, recipe: undefined, methods: lookup.recipe?.methods || [] },
    workflow: workflowStatus(manifest) };
}

async function localFile(runDir, filename, maxFileBytes) {
  if (typeof filename !== 'string' || filename !== path.basename(filename) || /[\\/]/.test(filename)
    || !/\.(jpe?g|png|webp|avif)$/i.test(filename)) throw new Error('Image filenames must be plain local JPEG, PNG, WebP or AVIF filenames');
  const file = path.join(runDir, filename);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Image must be a regular file, not a symlink: ${filename}`);
  if (!info.size || info.size > maxFileBytes) throw new Error(`Image exceeds the per-file byte limit or is empty: ${filename}`);
  const bytes = await readFile(file);
  if (bytes.length > maxFileBytes) throw new Error(`Image grew beyond the per-file byte limit: ${filename}`);
  return { file, bytes, sha256: hash(bytes), type: imageType(bytes) };
}

async function reconcileFiles(runDir, photos) {
  const names = new Set(photos.map(({ filename }) => filename));
  if (names.size !== photos.length) throw new Error('Each image filename must be represented exactly once');
  for (const entry of await readdir(runDir, { withFileTypes: true })) {
    if (['.debug', '.DS_Store', 'manifest.json', 'browser-collection.json'].includes(entry.name)) continue;
    if (!entry.isFile() || !names.has(entry.name)) throw new Error(`Unrecorded file or unfinished download in run folder: ${entry.name}`);
  }
}

async function createDecoder(runDir) {
  if (process.platform === 'darwin') return {
    async decode({ file, sha256 }) {
      const { stdout } = await executeFile('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 15000 });
      const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
      const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
      // Force a real decode into a small diagnostic; source files stay intact.
      await executeFile('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '16', file, '--out',
        path.join(runDir, '.debug', `decoded-${sha256}.png`)], { timeout: 15000 });
      return { width, height };
    }, close: async () => {},
  };
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  return { async decode({ bytes, type }) {
    return page.evaluate(async ({ data, type }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type }));
      const size = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return size;
    }, { data: bytes.toString('base64'), type });
  }, close: () => browser.close() };
}

export async function auditBrowserFiles(runDir, manifest) {
  const record = await readFile(path.join(runDir, 'browser-collection.json'));
  if (!manifest.browserVerification || hash(record) !== manifest.browserVerification.collectionHash) {
    throw new Error('Browser collection changed or has not been verified; run browser.mjs verify again');
  }
  await auditSavedFiles(runDir, manifest);
}

export async function auditSavedFiles(runDir, manifest) {
  if (manifest.photos.length > manifest.limits.maxImages) throw new Error('Saved files exceed the image cap');
  await reconcileFiles(runDir, manifest.photos);
  for (const photo of manifest.photos) {
    const file = await localFile(runDir, photo.filename, manifest.limits.maxFileBytes);
    if (file.sha256 !== photo.sha256 || file.bytes.length !== photo.bytes) throw new Error(`Verified file changed: ${photo.filename}`);
  }
}

export async function verifyBrowserCollection({ collectionFile, directory, decode }) {
  const runDir = path.dirname(path.resolve(collectionFile));
  if (path.basename(collectionFile) !== 'browser-collection.json') throw new Error('Use the run folder’s browser-collection.json');
  const manifestFile = path.join(runDir, 'manifest.json');
  const manifest = await readJson(manifestFile, 8 * 1024 * 1024);
  const collection = await readJson(collectionFile, 4 * 1024 * 1024);
  if (!['browser', 'mixed'].includes(manifest.transport)) throw new Error('Start browser continuation before verifying files');
  if (collection.version !== 1 || collection.sourceUrl !== manifest.sourceUrl) throw new Error('Collection source must match this run');
  imageIdentity(collection.pageUrl);
  if (new URL(collection.pageUrl).hostname !== new URL(manifest.pageUrl || manifest.sourceUrl).hostname) throw new Error('Browser page hostname changed; confirm the destination in a new run');
  for (const field of ['openedBy', 'identityEvidence', 'largerImagesEvidence']) requiredText(collection.gallery?.[field], `gallery.${field}`);
  if (!['limit', 'exhausted', 'incomplete'].includes(collection.exploration?.status)) throw new Error('Supply exploration limit, exhausted or incomplete');
  requiredText(collection.exploration.evidence, 'exploration evidence');
  if (!Array.isArray(collection.photos) || collection.photos.length > manifest.limits.maxImages) throw new Error('Supply a bounded photos array within the image cap');
  if (!Array.isArray(collection.skipped) || collection.skipped.length > 500) throw new Error('Supply a bounded skipped array');
  const positions = new Set();
  for (const item of [...collection.photos, ...collection.skipped]) {
    requiredText(item.position, 'observed gallery position', 80);
    if (positions.has(item.position)) throw new Error(`Repeated gallery position: ${item.position}`);
    positions.add(item.position);
  }
  for (const item of collection.skipped) requiredText(item.reason, 'skip reason');
  const helperPhotos = (manifest.photos || []).filter((photo) => photo.transport !== 'browser');
  if (helperPhotos.length + collection.photos.length > manifest.limits.maxImages) throw new Error('Combined helper and browser files exceed the image cap');
  await reconcileFiles(runDir, [...helperPhotos, ...collection.photos]);
  const photos = [];
  const hashes = new Set();
  let totalBytes = 0;
  let decoder;
  try {
    if (!decode) { decoder = await createDecoder(runDir); decode = decoder.decode; }
    for (const photo of [...helperPhotos, ...collection.photos]) {
      const file = await localFile(runDir, photo.filename, manifest.limits.maxFileBytes);
      if (hashes.has(file.sha256)) throw new Error(`Exact duplicate image: ${photo.filename}; record the skip and move it outside the run folder`);
      hashes.add(file.sha256);
      totalBytes += file.bytes.length;
      if (totalBytes > manifest.limits.maxBytes) throw new Error('Saved files exceed the byte budget');
      const size = await decode(file);
      if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width < 1 || size.height < 1
        || Math.max(size.width, size.height) < manifest.limits.minEdge) throw new Error(`Invalid or undersized image: ${photo.filename}`);
      if (helperPhotos.includes(photo)) {
        if (file.sha256 !== photo.sha256) throw new Error(`Previously saved helper file changed: ${photo.filename}`);
        photos.push(photo);
      } else {
        if (photo.sourceUrl !== undefined) imageIdentity(photo.sourceUrl);
        photos.push({ filename: photo.filename, position: photo.position, alt: String(photo.caption || '').slice(0, 300),
          ...(photo.sourceUrl ? { sourceUrl: photo.sourceUrl } : {}), ...size, sha256: file.sha256, bytes: file.bytes.length,
          transport: 'browser', evidence: [{ pageUrl: collection.pageUrl, ...collection.gallery }],
          resolution: 'Saved from the observed gallery; original resolution is unproven' });
      }
    }
  } finally { await decoder?.close(); }
  let recipe = await lookupRecipe(collection.pageUrl, directory);
  if (!collection.observation?.url || new URL(collection.observation.url).hostname !== new URL(collection.pageUrl).hostname) {
    throw new Error('Browser entry-state observation must belong to the observed gallery hostname');
  }
  recipe = checkBrowserRecipe(collection.observation, recipe);
  manifest.recipe = { ...recipe, methods: recipe.methods.map(({ id }) => id) };
  manifest.pageUrl = collection.pageUrl;
  manifest.photos = photos;
  manifest.savedBytes = totalBytes;
  manifest.status = 'downloaded';
  manifest.exploration = collection.exploration;
  manifest.stopReason = photos.length >= manifest.limits.maxImages ? 'image-cap' : 'candidates-exhausted';
  manifest.browserVerification = { at: new Date().toISOString(), collectionHash: hash(await readFile(collectionFile)),
    skipped: collection.skipped, files: photos.length };
  delete manifest.review; delete manifest.recipeSave; delete manifest.finalisation;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest: manifestFile, saved: photos.length, skipped: collection.skipped.length, workflow: workflowStatus(manifest) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: { url: { type: 'string' }, 'max-images': { type: 'string' },
    out: { type: 'string' }, 'min-edge': { type: 'string' }, manifest: { type: 'string' }, collection: { type: 'string' }, directory: { type: 'string' } } });
  if (command === 'start') return startBrowserRun({ url: values.url, maxImages: Number(values['max-images']),
    minEdge: values['min-edge'] ? Number(values['min-edge']) : 800, out: values.out, manifestFile: values.manifest, directory: values.directory });
  if (command === 'verify') return verifyBrowserCollection({ collectionFile: values.collection, directory: values.directory });
  throw new Error('Usage: browser.mjs start --url <url> --max-images <cap> [--out <folder>] | start --manifest <closed-helper-manifest> | verify --collection <browser-collection.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((result) => console.log(JSON.stringify({ ok: true, result })))
    .catch((error) => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
