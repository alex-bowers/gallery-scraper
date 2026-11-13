#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compactInspection, inspectPage, extractGallery, mergeCandidates, imageIdentity } from './gallery.mjs';
import { downloadCandidates } from './download.mjs';
import { lookupRecipe, checkRecipe } from './recipes.mjs';
import { reviewManifest, workflowStatus } from './workflow.mjs';

const require = createRequire(import.meta.url);

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    url: { type: 'string' }, out: { type: 'string', default: './gallery-runs' },
    'max-images': { type: 'string' }, 'max-bytes': { type: 'string', default: '104857600' },
    'max-file-bytes': { type: 'string', default: '20971520' },
    'max-actions': { type: 'string', default: '120' }, 'max-ms': { type: 'string', default: '600000' },
    'max-candidates': { type: 'string', default: '500' }, 'min-edge': { type: 'string', default: '800' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  imageIdentity(values.url);
  const integer = (name) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
    return value;
  };
  return { url: values.url, out: path.resolve(values.out), maxImages: integer('max-images'),
    maxBytes: integer('max-bytes'), maxFileBytes: integer('max-file-bytes'), maxActions: integer('max-actions'),
    maxMs: integer('max-ms'), maxCandidates: integer('max-candidates'), minEdge: integer('min-edge') };
}

export class GallerySession {
  constructor(options) {
    this.options = options;
    this.groups = new Map();
    this.scopes = new Map();
    this.actions = 0;
    this.abort = new AbortController();
    this.manifest = { version: 1, sourceUrl: options.url, pageUrl: options.url, limits: options, status: 'exploring', photos: [],
      limitations: [
        'Downloader byte budgets exclude normal browser traffic and may overshoot by an in-flight stream chunk.',
        'Exact-content deduplication does not detect every resized, cropped or recompressed duplicate.',
        'Gallery completeness and original resolution are unproven unless separately evidenced.',
      ] };
  }

  async start() {
    await mkdir(this.options.out, { recursive: true });
    this.runDir = await mkdtemp(path.join(this.options.out, 'web-gallery-'));
    await mkdir(path.join(this.runDir, '.debug'));
    this.startedAt = Date.now();
    this.manifest.startedAt = new Date(this.startedAt).toISOString();
    const preflight = await lookupRecipe(this.options.url, this.options.recipeDirectory);
    this.manifest.recipe = { ...preflight, recipe: undefined, methods: [] };
    await this.saveManifest();
    let chromium;
    try {
      try { ({ chromium } = require('playwright')); }
      catch { throw new Error('Existing Playwright installation was not found. Run from the gallery-scraper skill source; do not auto-install dependencies.'); }
      this.browser = await chromium.launch({ headless: true });
      this.context = await this.browser.newContext({ viewport: { width: 1440, height: 1000 } });
      this.context.setDefaultTimeout(10000);
      this.context.setDefaultNavigationTimeout(30000);
      this.page = await this.context.newPage();
      this.decoder = await this.context.newPage();
      try { await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' }); }
      catch (error) { this.manifest.navigationWarning = error.message; }
      const recipe = await this.refreshRecipe();
      return { ...await this.inspect(), recipe };
    } catch (error) {
      this.manifest.access = { blocked: true, evidence: `Helper startup failed: ${error.message.slice(0, 300)}` };
      await this.close('startup-error');
      error.runDir = this.runDir; error.workflow = workflowStatus(this.manifest);
      throw error;
    }
  }

  async saveManifest() {
    if (!this.runDir) return;
    this.manifest.candidateGroups = this.groups.size;
    this.manifest.scopes = [...this.scopes].map(([selector, reason]) => ({ selector, reason }));
    this.manifest.actions = this.actions;
    if (this.page) {
      try { imageIdentity(this.page.url()); this.manifest.pageUrl = this.page.url(); } catch { /* Keep the requested HTTP URL after failed navigation. */ }
    }
    await writeFile(path.join(this.runDir, 'manifest.json'), JSON.stringify(this.manifest, null, 2));
  }

  async refreshRecipe() {
    let result;
    try {
      let recipeUrl = this.manifest.pageUrl || this.options.url;
      try { imageIdentity(this.page.url()); recipeUrl = this.page.url(); } catch { /* Preserve a usable lookup URL after failed navigation. */ }
      const lookup = await lookupRecipe(recipeUrl, this.options.recipeDirectory);
      try { imageIdentity(this.page.url()); result = await checkRecipe(this.page, lookup); }
      catch { result = { ...lookup, recipe: undefined, status: lookup.status === 'found' ? 'unmatched' : lookup.status, methods: [] }; }
    } catch (error) { result = { status: 'invalid', error: error.message, methods: [] }; }
    this.manifest.recipe = { ...result, methods: result.methods.map(({ id }) => id) };
    await this.saveManifest();
    return result;
  }

  async inspect(selector = null, full = false) {
    const screenshot = path.join(this.runDir, '.debug', 'current.jpg');
    await this.page.screenshot({ path: screenshot, type: 'jpeg', quality: 75, timeout: 10000 });
    const state = await this.page.evaluate(inspectPage, { selector });
    this.manifest.access = this.manifest.navigationWarning && !state.containers.length && !state.controls.length
      ? { blocked: true, evidence: this.manifest.navigationWarning.slice(0, 300) } : state.access;
    await this.saveManifest();
    const inspection = path.join(this.runDir, '.debug', 'inspection.json');
    await writeFile(inspection, JSON.stringify(state, null, 2));
    return { runDir: this.runDir, screenshot, inspection, ...(full ? state : compactInspection(state)),
      workflow: workflowStatus(this.manifest),
      progress: { groups: this.groups.size, saved: this.manifest.photos.length, actions: this.actions, maxImages: this.options.maxImages,
        elapsedMs: Date.now() - this.startedAt } };
  }

  async dispatch(command) {
    if (this.closed) throw new Error('Session is closed');
    if (command.type === 'close') return this.close(command.reason || 'closed');
    if (command.type === 'status') return workflowStatus(this.manifest);
    if (command.type === 'fallback') {
      if (typeof command.available !== 'boolean' || typeof command.evidence !== 'string' || !command.evidence.trim()) {
        throw new Error('Record whether the user’s browser is available and what was actually checked');
      }
      this.manifest.fallback = { available: command.available, evidence: command.evidence.slice(0, 1000) };
      await this.saveManifest();
      return { fallback: this.manifest.fallback, workflow: workflowStatus(this.manifest) };
    }
    if (this.abort.signal.aborted || Date.now() - this.startedAt >= this.options.maxMs) throw new Error('Session time budget exhausted');
    const { type } = command;
    if (type === 'inspect') return this.inspect(command.selector, command.full === true);
    if (type === 'recipe') return this.refreshRecipe();
    if (type === 'review') {
      const result = await reviewManifest(this.manifest, command, this.options.recipeDirectory);
      await this.saveManifest();
      return result;
    }
    if (['scope', 'collect', 'add', 'act', 'download'].includes(type)) {
      delete this.manifest.review; delete this.manifest.recipeSave; delete this.manifest.finalisation;
    }
    if (type === 'scope') {
      if (typeof command.reason !== 'string' || !command.reason.trim()) throw new Error('Explain why this selector belongs to the selected gallery');
      await this.page.evaluate(extractGallery, { selector: command.selector, maxCandidates: this.options.maxCandidates });
      if (command.replace === true) { this.scopes.clear(); this.groups.clear(); }
      this.scopes.set(command.selector, command.reason.trim());
      await this.saveManifest();
      return { scopes: [...this.scopes.keys()] };
    }
    if (type === 'collect') {
      if (!this.scopes.size) throw new Error('Select a gallery scope before collecting');
      let added = 0;
      const warnings = [];
      for (const [selector, reason] of this.scopes) {
        if (await this.page.locator(selector).count() === 0) { warnings.push(`Scope currently absent: ${selector}`); continue; }
        const batch = await this.page.evaluate(extractGallery, { selector, maxCandidates: this.options.maxCandidates });
        const result = mergeCandidates(this.groups, batch.items, { selector, reason, pageUrl: this.page.url() }, this.options.maxCandidates);
        added += result.added;
        if (batch.truncated || result.truncated) warnings.push('Candidate or variant budget reached; collection is partial');
      }
      this.manifest.collectionWarnings = [...new Set([...(this.manifest.collectionWarnings || []), ...warnings])];
      await writeFile(path.join(this.runDir, '.debug', 'candidates.json'), JSON.stringify([...this.groups.values()], null, 2));
      await this.saveManifest();
      return { added, groups: this.groups.size, pending: this.pendingGroups(), variants: [...this.groups.values()].reduce((total, group) => total + group.variants.length, 0), warnings,
        preview: [...this.groups.values()].slice(-3).map(({ alt, variants }) => ({ alt, variants: variants.length })) };
    }
    if (type === 'add') {
      if (!this.scopes.size || typeof command.evidence !== 'string' || !command.evidence.trim()) {
        throw new Error('Manual gallery data requires a selected scope and source evidence');
      }
      if (!Array.isArray(command.urls) || !command.urls.length || command.urls.length > this.options.maxCandidates) {
        throw new Error('Supply a bounded non-empty urls array');
      }
      // Validate the entire batch before mutating the candidate store.
      for (const url of command.urls) imageIdentity(url);
      const result = mergeCandidates(this.groups, command.urls.map((url) => ({ identityUrl: url,
        variants: [{ url, widthHint: 0, priority: 30, source: 'evidenced-gallery-data' }] })),
      { selector: [...this.scopes.keys()][0], reason: command.evidence, pageUrl: this.page.url() }, this.options.maxCandidates);
      if (result.truncated) this.manifest.collectionWarnings = [...(this.manifest.collectionWarnings || []), 'Manual candidate budget reached'];
      await this.saveManifest();
      return { ...result, groups: this.groups.size };
    }
    if (type === 'repeat') return this.repeat(command);
    if (type === 'act') {
      if (this.actions >= this.options.maxActions) throw new Error('Interaction budget exhausted; download a partial result or close');
      this.actions++;
      await appendFile(path.join(this.runDir, '.debug', 'actions.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), command })}\n`);
      try {
        switch (command.action) {
          case 'click': {
            const target = this.page.locator(command.selector);
            if (await target.count() !== 1) throw new Error('Click selector must match exactly one element');
            await target.click();
            break;
          }
          case 'key': {
            if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Escape', 'PageDown', 'PageUp', 'End', 'Home', 'Tab', 'Enter', 'Space'].includes(command.key)) throw new Error('Unsupported navigation key');
            await this.page.keyboard.press(command.key);
            break;
          }
          case 'scroll': {
            if (!Number.isFinite(command.deltaY) || Math.abs(command.deltaY) > 2000) throw new Error('Scroll deltaY must be between -2000 and 2000');
            if (command.selector) {
              const target = this.page.locator(command.selector);
              if (await target.count() !== 1) throw new Error('Scroll selector must match exactly one element');
              await target.evaluate((el, deltaY) => el.scrollBy(0, deltaY), command.deltaY);
            } else await this.page.mouse.wheel(0, command.deltaY);
            break;
          }
          case 'wait': {
            if (!Number.isSafeInteger(command.ms) || command.ms < 1 || command.ms > 3000) throw new Error('Wait must be 1–3000 ms');
            await this.page.waitForTimeout(command.ms);
            break;
          }
          default: throw new Error('Unknown action');
        }
        return await this.inspect();
      } finally { await this.saveManifest(); }
    }
    if (type === 'download') {
      if (!this.groups.size) throw new Error('No evidenced gallery candidates collected');
      if (!['limit', 'exhausted', 'incomplete'].includes(command.exploration)
        || typeof command.evidence !== 'string' || !command.evidence.trim()) {
        throw new Error('Supply exploration (limit/exhausted/incomplete) and evidence; do not assume completeness');
      }
      this.downloadStarted = true;
      this.manifest.pageUrl = this.page.url();
      this.manifest.status = 'downloading';
      this.manifest.exploration = { status: command.exploration, evidence: command.evidence };
      await this.saveManifest();
      try {
        const result = await downloadCandidates({ ...this.options, runDir: this.runDir, groups: this.groups.values(), prior: this.manifest,
          cookies: (url) => this.context.cookies(url), referer: this.page.url(), signal: this.abort.signal,
          onProgress: async (progress) => { Object.assign(this.manifest, progress); await this.saveManifest(); },
          decode: (bytes, type) => this.decoder.evaluate(async ({ base64, type }) => {
            const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([data], { type }));
            const dimensions = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
            return dimensions;
          }, { base64: bytes.toString('base64'), type }) });
        Object.assign(this.manifest, result, { status: 'downloaded' });
        return { runDir: this.runDir, saved: result.photos.length, downloadedBytes: result.downloadedBytes,
          stopReason: result.stopReason, manifest: path.join(this.runDir, 'manifest.json') };
      } catch (error) {
        this.manifest.status = 'download-error';
        this.manifest.error = error.message;
        throw error;
      } finally { await this.saveManifest(); }
    }
    throw new Error(`Unknown command: ${type}`);
  }

  async repeat(command) {
    if (!Number.isSafeInteger(command.steps) || command.steps < 1 || command.steps > 20) throw new Error('Repeat steps must be 1–20');
    if (!command.action || !['click', 'scroll', 'key'].includes(command.action.action)) throw new Error('Repeat an observed click, scroll or key action');
    let collection = await this.dispatch({ type: 'collect' });
    let steps = 0;
    let unchanged = 0;
    let stopReason = 'step-limit';
    let error;
    let state;
    while (steps < command.steps) {
      if (collection.pending >= this.options.maxImages - this.manifest.photos.length) { stopReason = 'candidate-cap'; break; }
      if (collection.warnings.length) { stopReason = 'collection-warning'; break; }
      try {
        if (command.action.action === 'click') {
          const control = this.page.locator(command.action.selector);
          if (await control.count() === 1 && (await control.isDisabled() || await control.getAttribute('aria-disabled') === 'true')) {
            stopReason = 'disabled-control'; break;
          }
        }
        state = await this.dispatch({ ...command.action, type: 'act' });
        steps++;
        const next = await this.dispatch({ type: 'collect' });
        unchanged = next.groups === collection.groups && next.variants === collection.variants ? unchanged + 1 : 0;
        collection = next;
        if (collection.warnings.length) { stopReason = 'collection-warning'; break; }
        if (unchanged >= 3) { stopReason = 'no-progress'; break; }
      } catch (cause) { stopReason = 'action-error'; error = cause.message; break; }
    }
    if (collection.pending >= this.options.maxImages - this.manifest.photos.length) stopReason = 'candidate-cap';
    const result = { steps, stopReason, error, ...collection, state };
    this.manifest.lastRepeat = { command, steps, stopReason, error, groups: collection.groups };
    await this.saveManifest();
    return result;
  }

  pendingGroups() {
    const attempted = new Set((this.manifest.attempts || []).map(({ url }) => url));
    const saved = new Set(this.manifest.photos.map(({ groupKey }) => groupKey));
    return [...this.groups.values()].filter((group) => !saved.has(group.key)
      && group.variants.some(({ url }) => !attempted.has(url))).length;
  }

  async close(reason = 'closed') {
    if (this.closed) return { closed: true, runDir: this.runDir };
    this.closed = true;
    this.manifest.closeReason = reason;
    this.manifest.finishedAt = new Date().toISOString();
    if (this.manifest.status === 'exploring') this.manifest.status = 'incomplete';
    try { await this.saveManifest(); }
    finally { await this.browser?.close(); }
    return { closed: true, runDir: this.runDir, workflow: workflowStatus(this.manifest) };
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node session.mjs --url <page-url> --max-images <count> [--out <parent-directory>]');
    console.log('Budgets: --max-bytes 104857600 --max-file-bytes 20971520 --max-actions 120 --max-ms 600000 --max-candidates 500 --min-edge 800');
    console.log('Send JSON lines on stdin: inspect, recipe, act, scope, collect, repeat, add, download, review, close. See references/commands.md.');
    return;
  }
  const session = new GallerySession(options);
  // Attach input before browser startup so piped commands are not lost.
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const timer = setTimeout(() => { session.abort.abort(new Error('Session time budget exhausted')); input.close(); }, options.maxMs);
  const stop = () => { session.abort.abort(new Error('Session cancelled')); input.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const commands = input[Symbol.asyncIterator]();
    console.log(JSON.stringify({ ok: true, result: await session.start() }));
    for await (const line of { [Symbol.asyncIterator]: () => commands }) {
      if (!line.trim()) continue;
      try {
        const result = await session.dispatch(JSON.parse(line));
        console.log(JSON.stringify({ ok: true, result, workflow: workflowStatus(session.manifest) }));
        if (session.closed) break;
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error.message, workflow: workflowStatus(session.manifest),
          recovery: 'Inspect the current page/screenshot before retrying. Dismiss an observed obstruction, or check the user browser when the helper cannot access the gallery.' }));
      }
    }
  } finally {
    clearTimeout(timer);
    input.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await session.close(session.abort.signal.aborted ? 'time-budget-or-cancelled' : 'input-closed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => { console.error(JSON.stringify({ ok: false, error: error.message, runDir: error.runDir, workflow: error.workflow })); process.exitCode = 1; });
}
