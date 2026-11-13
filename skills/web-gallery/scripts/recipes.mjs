#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, writeFile, rename, link, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const recipeDirectory = fileURLToPath(new URL('../recipes/', import.meta.url));
const MAX_BYTES = 65536;

function pageUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) page URL without credentials');
  return url;
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a recipe object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown recipe field: ${key}`);
}
function text(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}: expected non-empty text up to ${max} characters`);
}
function list(value, label, min = 1, max = 30) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${label}: expected ${min}–${max} entries`);
}
function textList(value, label, min = 1) {
  list(value, label, min);
  value.forEach((entry) => text(entry, label));
}
export function validateRecipe(recipe, { draft = false } = {}) {
  object(recipe, ['version', 'hostname', 'methods']);
  if (recipe.version !== 1) throw new Error('Unsupported recipe version; expected 1');
  text(recipe.hostname, 'hostname', 253);
  const hostUrl = pageUrl(`https://${recipe.hostname}/`);
  if (hostUrl.hostname !== recipe.hostname || hostUrl.host !== recipe.hostname || hostUrl.pathname !== '/') throw new Error('Expected one canonical hostname without a port or path');
  list(recipe.methods, 'methods', 1, 12);
  const ids = new Set();
  for (const method of recipe.methods) {
    object(method, ['id', 'name', 'checks', 'steps', 'verification', 'limitations', ...(draft ? [] : ['verified'])]);
    if (typeof method.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(method.id)) throw new Error('Invalid method id');
    if (ids.has(method.id)) throw new Error(`Duplicate method id: ${method.id}`);
    ids.add(method.id);
    text(method.name, 'method name', 160);
    list(method.checks, 'checks', 1, 12);
    for (const check of method.checks) {
      object(check, ['selector', 'reason', 'textIncludes', 'jsonPath', 'valueType', 'uiTextIncludes']);
      if (check.uiTextIncludes !== undefined) {
        text(check.uiTextIncludes, 'UI text check');
        if (check.selector !== undefined || check.textIncludes !== undefined || check.jsonPath !== undefined || check.valueType !== undefined) {
          throw new Error('UI checks cannot contain DOM selectors or JSON checks');
        }
      } else text(check.selector, 'check selector', 500);
      text(check.reason, 'check reason');
      if (check.textIncludes !== undefined) text(check.textIncludes, 'textIncludes', 1000);
      if (check.jsonPath !== undefined) {
        list(check.jsonPath, 'jsonPath', 0, 16);
        for (const part of check.jsonPath) {
          if (!(typeof part === 'string' && part.length > 0 && part.length <= 160)
            && !(Number.isSafeInteger(part) && part >= 0)) throw new Error('Invalid JSON path segment');
          if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error('Unsafe JSON path segment');
        }
        if (!['array', 'object', 'string'].includes(check.valueType)) throw new Error('JSON checks require valueType: array, object or string');
      } else if (check.valueType !== undefined) throw new Error('valueType requires jsonPath');
    }
    textList(method.steps, 'steps');
    textList(method.verification, 'verification');
    textList(method.limitations, 'limitations', 0);
    if (!draft) {
      object(method.verified, ['url', 'at', 'evidence']);
      const url = pageUrl(method.verified.url);
      if (url.hostname !== recipe.hostname || url.search || url.hash) throw new Error('Verification URL must match the recipe hostname and omit query or fragment');
      if (typeof method.verified.at !== 'string' || !Number.isFinite(Date.parse(method.verified.at))) throw new Error('Invalid verification date');
      text(method.verified.evidence, 'verification evidence');
    }
  }
  if (Buffer.byteLength(JSON.stringify(recipe)) > MAX_BYTES) throw new Error('Recipe exceeds 64 KiB');
  return recipe;
}

// Read at most the budget plus one byte, even if a file grows during reading.
export async function readJson(file, maxBytes = MAX_BYTES) {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Expected a regular JSON file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error(`JSON file exceeds ${maxBytes} bytes`);
    return JSON.parse(buffer.toString('utf8', 0, size));
  } finally { await handle.close(); }
}

export async function lookupRecipe(url, directory = recipeDirectory) {
  const hostname = pageUrl(url).hostname;
  const file = path.join(directory, `${encodeURIComponent(hostname)}.json`);
  const result = { hostname, file };
  try {
    const recipe = validateRecipe(await readJson(file));
    if (recipe.hostname !== hostname) throw new Error('Recipe hostname does not match its filename');
    return { ...result, status: 'found', hash: createHash('sha256').update(JSON.stringify(recipe)).digest('hex'), recipe };
  } catch (error) {
    return { ...result, status: error.code === 'ENOENT' ? 'missing' : 'invalid', ...(error.code === 'ENOENT' ? {} : { error: error.message }) };
  }
}

// Read-only browser checks. No recipe text is evaluated as code or navigation.
export function checkPageElements(checks, observedElements = null) {
  return checks.map((check) => {
    try {
      if (check.uiTextIncludes !== undefined) return { uiTextIncludes: check.uiTextIncludes,
        passed: document.body.innerText.includes(check.uiTextIncludes) };
      const observed = observedElements?.find((element) => element.selector === check.selector);
      const elements = observedElements === null ? document.querySelectorAll(check.selector)
        : observed?.count === 1 ? [observed] : Array.from({ length: Math.min(observed?.count || 0, 2) }, () => ({}));
      const result = { selector: check.selector, count: elements.length, passed: elements.length === 1 };
      if (!result.passed) return result;
      if (check.textIncludes !== undefined && !elements[0].textContent.includes(check.textIncludes)) {
        result.passed = false;
        return result;
      }
      if (check.jsonPath === undefined) return result;
      if (elements[0].localName !== 'script') throw new Error('JSON checks require a script element');
      const raw = elements[0].textContent;
      if (raw.length > 4 * 1024 * 1024) throw new Error('Embedded JSON exceeds the check budget');
      let values = [JSON.parse(raw)];
      for (const part of check.jsonPath) {
        const next = [];
        for (const value of values) {
          if (part === '*') {
            if (Array.isArray(value)) {
              for (const item of value) { next.push(item); if (next.length > 5000) throw new Error('JSON path exceeds the check budget'); }
            }
          } else if (value !== null && typeof value === 'object' && Object.hasOwn(value, part)) next.push(value[part]);
          if (next.length > 5000) throw new Error('JSON path exceeds the check budget');
        }
        values = next;
      }
      result.passed = values.some((value) => check.valueType === 'array' ? Array.isArray(value) && value.length > 0
        : check.valueType === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : typeof value === 'string' && value.length > 0);
      result.jsonPath = check.jsonPath;
      return result;
    } catch (error) { return { selector: check.selector, passed: false, error: error.message }; }
  });
}

export async function checkRecipe(page, lookup) {
  const { recipe, ...summary } = lookup;
  if (lookup.status !== 'found') return { ...summary, methods: [] };
  const url = pageUrl(page.url());
  const checks = [];
  const methods = [];
  for (const method of recipe.methods) {
    if (url.hostname !== recipe.hostname) {
      checks.push({ id: method.id, passed: false, reason: 'Hostname does not match' });
      continue;
    }
    let results;
    try { results = await page.evaluate(checkPageElements, method.checks); }
    catch (error) { results = [{ passed: false, error: error.message }]; }
    const passed = results.every((result) => result.passed);
    checks.push({ id: method.id, passed, results });
    if (passed) methods.push(method);
  }
  return { ...summary, status: methods.length ? 'matched' : 'unmatched', checks, methods };
}

// Native browser tools can supply an observed accessibility/UI text snapshot.
// DOM checks stay unmatched when no DOM is available; never invent selectors.
export function checkBrowserRecipe(observation, lookup) {
  const { recipe, ...summary } = lookup;
  if (lookup.status !== 'found') return { ...summary, methods: [] };
  const sameHost = pageUrl(observation.url).hostname === recipe.hostname;
  if (typeof observation.text !== 'string' || observation.text.length > 4 * 1024 * 1024) throw new Error('Supply a bounded browser UI text snapshot');
  const elements = observation.elements || [];
  if (!Array.isArray(elements) || elements.length > 120 || JSON.stringify(elements).length > 4 * 1024 * 1024) throw new Error('Supply bounded observed DOM elements');
  const selectors = new Set();
  for (const element of elements) {
    text(element.selector, 'observed selector', 500);
    if (selectors.has(element.selector)) throw new Error('Observed selectors must be unique');
    selectors.add(element.selector);
    if (!Number.isSafeInteger(element.count) || element.count < 0 || typeof element.textContent !== 'string'
      || typeof element.localName !== 'string') throw new Error('Observed elements require count, localName and textContent');
  }
  const checks = recipe.methods.map((method) => {
    const results = method.checks.map((check) => check.uiTextIncludes !== undefined
      ? { uiTextIncludes: check.uiTextIncludes, passed: observation.text.includes(check.uiTextIncludes) }
      : checkPageElements([check], elements)[0]);
    return { id: method.id, passed: sameHost && results.every(({ passed }) => passed), results };
  });
  const methods = recipe.methods.filter((method) => checks.find(({ id }) => id === method.id).passed);
  return { ...summary, status: methods.length ? 'matched' : 'unmatched', checks, methods };
}

export function reviewedRun(manifest) {
  if (manifest.status !== 'downloaded' || !Array.isArray(manifest.photos) || !manifest.photos.length
    || !['limit', 'exhausted'].includes(manifest.exploration?.status)
    || !['image-cap', 'candidates-exhausted'].includes(manifest.stopReason)) {
    throw new Error('Recipes require a successful, non-empty collection; incomplete or failed runs cannot be saved');
  }
  if (manifest.exploration.status === 'limit' && manifest.limits?.maxImages
    && manifest.photos.length < manifest.limits.maxImages) {
    throw new Error('Image cap not filled: continue collection or establish an exhausted gallery before saving a recipe');
  }
  if (manifest.review?.verified !== true) throw new Error('Review the manifest and sample images before saving a recipe');
  text(manifest.review.evidence, 'review evidence');
  if (!Number.isFinite(Date.parse(manifest.review.at))) throw new Error('Review requires a valid date');
  return pageUrl(manifest.pageUrl || manifest.sourceUrl);
}

export async function saveRecipe({ draft, manifest, directory = recipeDirectory, approved = false, update = false }) {
  if (approved !== true) throw new Error('Explicit user approval is required to save or update recipes');
  validateRecipe(draft, { draft: true });
  const url = reviewedRun(manifest);
  if (url.hostname !== draft.hostname) throw new Error('Draft hostname does not match the reviewed page');
  url.search = ''; url.hash = '';
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${encodeURIComponent(draft.hostname)}.json`);
  const lockFile = `${file}.lock`;
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another recipe save is in progress; inspect the lock before retrying'); throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const existing = await lookupRecipe(url.href, directory);
    if (existing.status === 'invalid') throw new Error(`Existing recipe is invalid; preserve and repair it explicitly: ${existing.error}`);
    if (existing.status === 'found' && !update) throw new Error('Domain recipe already exists; updating it requires explicit update approval');
    if (existing.status === 'missing' && update) throw new Error('Cannot update a missing domain recipe');
    const methods = new Map((existing.recipe?.methods || []).map((method) => [method.id, method]));
    for (const method of draft.methods) methods.set(method.id, { ...method,
      verified: { url: url.href, at: manifest.review.at, evidence: manifest.review.evidence } });
    const recipe = validateRecipe({ version: 1, hostname: draft.hostname, methods: [...methods.values()] });
    const contents = `${JSON.stringify(recipe, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('Formatted recipe exceeds 64 KiB');
    await writeFile(temporary, contents, { flag: 'wx' });
    if (existing.status === 'missing') await link(temporary, file);
    else {
      const current = await lookupRecipe(url.href, directory);
      if (current.hash !== existing.hash) throw new Error('Recipe changed during save; inspect it before retrying');
      await rename(temporary, file);
    }
    return { saved: true, hostname: draft.hostname, file, methods: recipe.methods.map(({ id }) => id), updated: update };
  } finally {
    await lock.close();
    await unlink(lockFile);
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: { url: { type: 'string' }, draft: { type: 'string' },
    manifest: { type: 'string' }, directory: { type: 'string' }, approved: { type: 'boolean' }, update: { type: 'boolean' },
    full: { type: 'boolean' }, observation: { type: 'string' }, verified: { type: 'boolean' }, evidence: { type: 'string' },
    'recipe-declined': { type: 'string' } } });
  if (command === 'lookup') {
    const { recipe, ...summary } = await lookupRecipe(values.url, values.directory);
    return { ...summary, methods: recipe?.methods.map((method) => values.full ? method : { id: method.id, name: method.name }) || [] };
  }
  if (command === 'check-browser') return checkBrowserRecipe(await readJson(values.observation, 4 * 1024 * 1024),
    await lookupRecipe(values.url, values.directory));
  if (command === 'finish' || command === 'review' || command === 'status') {
    const { finishRun, reviewManifest, workflowStatus } = await import('./workflow.mjs');
    if (command === 'finish') return finishRun({ manifestFile: values.manifest, draftFile: values.draft, directory: values.directory, recipeDeclined: values['recipe-declined'] });
    const manifest = await readJson(values.manifest, 8 * 1024 * 1024);
    if (command === 'status') return workflowStatus(manifest);
    const result = await reviewManifest(manifest, { verified: values.verified === true, evidence: values.evidence }, values.directory);
    await writeFile(values.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    return result;
  }
  if (command === 'save') return saveRecipe({ draft: await readJson(values.draft),
    manifest: await readJson(values.manifest, 16 * 1024 * 1024), directory: values.directory,
    approved: values.approved, update: values.update });
  throw new Error('Usage: recipes.mjs lookup --url <url> --full | check-browser --url <url> --observation <json> | status/review/finish --manifest <json> [--draft <json>] | save --draft <json> --manifest <json> --approved');
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main().then((result) => console.log(JSON.stringify({ ok: true, result })))
  .catch((error) => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
