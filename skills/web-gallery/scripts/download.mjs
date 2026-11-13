import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { imageIdentity } from './gallery.mjs';

const FORMATS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };

export function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return 'image/avif';
  throw new Error('Unsupported or invalid image signature');
}

export async function readImage(url, { budget, maxFileBytes, signal, cookies = async () => [], referer }) {
  imageIdentity(url);
  const requestSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]);
  for (let redirect = 0; redirect <= 5; redirect++) {
    const jar = await cookies(url);
    const headers = { Accept: 'image/avif,image/webp,image/png,image/jpeg', Referer: referer };
    if (jar.length) headers.Cookie = jar.map(({ name, value }) => `${name}=${value}`).join('; ');
    const response = await fetch(url, { headers, redirect: 'manual', signal: requestSignal });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel();
      if (redirect === 5) throw new Error('Too many image redirects');
      url = new URL(response.headers.get('location'), url).href;
      imageIdentity(url);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!FORMATS[type]) { await response.body?.cancel(); throw new Error(`Unsupported content type: ${type || 'missing'}`); }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxFileBytes || declared > budget.max - budget.received) {
      await response.body?.cancel();
      throw new Error('Declared image size exceeds the remaining or per-file byte budget');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        budget.received += value.byteLength;
        if (size > maxFileBytes || budget.received > budget.max) {
          await reader.cancel();
          throw new Error('Image transfer exceeded the remaining or per-file byte budget');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const detectedType = imageType(bytes);
    return { bytes, type: detectedType, finalUrl: url };
  }
}

// The caller supplies a browser decoder so no image-processing dependency is needed.
export async function downloadCandidates({ groups, runDir, maxImages, maxBytes, maxFileBytes,
  minEdge, decode, cookies, referer, signal, prior = {}, onProgress = async () => {} }) {
  const budget = { max: maxBytes, received: prior.downloadedBytes || 0 };
  const photos = [...(prior.photos || [])];
  const hashes = new Set(photos.map(({ sha256 }) => sha256));
  const attempts = [...(prior.attempts || [])];
  const attemptedUrls = new Set(attempts.map(({ url }) => url));
  const savedGroups = new Set(photos.map(({ groupKey }) => groupKey));
  let stopReason = 'candidates-exhausted';
  for (const group of groups) {
    if (photos.length >= maxImages) { stopReason = 'image-cap'; break; }
    if (budget.received >= budget.max) { stopReason = 'byte-budget'; break; }
    if (signal?.aborted) { stopReason = 'time-budget-or-cancelled'; break; }
    if (savedGroups.has(group.key)) continue;
    let best = null;
    for (const variant of group.variants) {
      if (budget.received >= budget.max || signal?.aborted) break;
      if (attemptedUrls.has(variant.url)) continue;
      attemptedUrls.add(variant.url);
      try {
        const file = await readImage(variant.url, { budget, maxFileBytes, signal, cookies, referer });
        const dimensions = await decode(file.bytes, file.type);
        if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)
          || Math.max(dimensions.width, dimensions.height) < minEdge) {
          throw new Error(`Image is too small or has invalid dimensions: ${dimensions.width}×${dimensions.height}`);
        }
        attempts.push({ url: variant.url, status: 'verified', width: dimensions.width, height: dimensions.height });
        if (!best || dimensions.width * dimensions.height > best.width * best.height) {
          best = { ...file, ...dimensions, sourceUrl: variant.url };
        }
      } catch (error) {
        attempts.push({ url: variant.url, status: 'rejected', error: error.message });
      }
    }
    if (!best) continue;
    const hash = createHash('sha256').update(best.bytes).digest('hex');
    if (hashes.has(hash)) { attempts.push({ url: best.sourceUrl, status: 'duplicate-content' }); continue; }
    const filename = `${String(photos.length + 1).padStart(3, '0')}-${hash.slice(0, 12)}.${FORMATS[best.type]}`;
    await writeFile(path.join(runDir, filename), best.bytes, { flag: 'wx' });
    hashes.add(hash);
    photos.push({ filename, groupKey: group.key, sourceUrl: best.sourceUrl, finalUrl: best.finalUrl, width: best.width,
      height: best.height, bytes: best.bytes.length, sha256: hash, alt: group.alt, evidence: group.evidence,
      resolution: 'Largest successfully decoded version checked from observed candidates; original resolution is unproven' });
    await onProgress({ photos, attempts, downloadedBytes: budget.received,
      savedBytes: photos.reduce((sum, photo) => sum + photo.bytes, 0) });
  }
  if (photos.length >= maxImages) stopReason = 'image-cap';
  else if (budget.received >= budget.max) stopReason = 'byte-budget';
  else if (signal?.aborted) stopReason = 'time-budget-or-cancelled';
  return { photos, attempts, downloadedBytes: budget.received, savedBytes: photos.reduce((sum, p) => sum + p.bytes, 0), stopReason };
}
