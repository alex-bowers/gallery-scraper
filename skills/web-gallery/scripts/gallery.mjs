export function compactInspection(state) {
  const relevant = /gallery|photo|image|picture|album|slideshow|zoom|enlarge|next|previous|prev\b|close|cookie|accept|reject|consent/i;
  const controls = [...state.controls].sort((a, b) => Number(relevant.test(b.label)) - Number(relevant.test(a.label)));
  return { ...state, containers: state.containers.slice(0, 8),
    controls: controls.slice(0, 24).map(({ href, ...control }) => control),
    dataSources: state.dataSources.slice(0, 8),
    available: { containers: state.containers.length, controls: state.controls.length, dataSources: state.dataSources.length } };
}

// Keep the browser functions self-contained: Playwright serialises their source.
export function inspectPage({ selector = null } = {}) {
  const selectorFor = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    while (el && el !== document.documentElement) {
      const siblings = [...el.parentElement.children].filter((item) => item.tagName === el.tagName);
      parts.unshift(`${el.localName}:nth-of-type(${siblings.indexOf(el) + 1})`);
      el = el.parentElement;
    }
    return `html > ${parts.join(' > ')}`;
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const containers = [...document.querySelectorAll('[id], [class], [role="dialog"]')]
    .filter((el) => /gallery|lightbox|fancybox|carousel|swiper|photo|modal/i.test(`${el.id} ${el.className}`)
      || el.getAttribute('role') === 'dialog')
    .map((el) => ({ selector: selectorFor(el), images: el.querySelectorAll('img, picture').length,
      visible: visible(el), role: el.getAttribute('role'), label: el.getAttribute('aria-label') }))
    .sort((a, b) => Number(b.visible) - Number(a.visible) || b.images - a.images).slice(0, 30);
  const controls = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], img')]
    .filter(visible).map((el) => ({ selector: selectorFor(el),
      label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.getAttribute('alt')
        || (el.localName === 'img' ? 'Image (no caption)' : '')).trim().slice(0, 140),
      role: el.getAttribute('role') || el.localName,
      href: el.localName === 'a' ? el.href : undefined }))
    .filter((el) => el.label)
    .sort((a, b) => Number(/gallery|next|previous|close|cookie|accept|reject/i.test(b.label))
      - Number(/gallery|next|previous|close|cookie|accept|reject/i.test(a.label))).slice(0, 120);
  const dataSources = [...document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')]
    .slice(0, 20).map((el) => ({ selector: selectorFor(el), characters: el.textContent.length }));
  let details;
  if (selector) {
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) throw new Error('Inspection selector must match exactly one element');
    const html = matches[0].outerHTML;
    details = { selector, html: html.slice(0, 24000), truncated: html.length > 24000 };
  }
  const bodyText = document.body.innerText.slice(0, 50000);
  const restriction = bodyText.match(/access\s+(?:restricted|denied)|your browser did something unexpected|captcha|verify (?:that )?you are (?:a )?human/i);
  return { url: location.href, title: document.title, containers, controls, dataSources, details,
    access: { blocked: Boolean(restriction), ...(restriction ? { evidence: restriction[0] } : {}) } };
}

export function extractGallery({ selector, maxCandidates }) {
  const roots = [...document.querySelectorAll(selector)];
  if (roots.length !== 1) throw new Error(`Gallery selector must match exactly one element; matched ${roots.length}`);
  const root = roots[0];
  const unrelated = 'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';
  if (root === document.body || root === document.documentElement || root.closest(unrelated)) {
    throw new Error('Choose a specific gallery container outside navigation, header and footer');
  }
  const results = [];
  let truncated = false;
  const absolute = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const srcset = (value = '') => {
    const entries = [];
    // URLs can contain commas (common on image CDNs); split on descriptors instead.
    for (const match of value.matchAll(/(\S+)\s+(\d+(?:\.\d+)?)(w|x)\s*(?:,|$)/g)) {
      entries.push({ url: match[1], widthHint: match[3] === 'w' ? Number(match[2]) : 0,
        priority: match[3] === 'x' ? Number(match[2]) * 10 : 10, source: 'srcset' });
    }
    // A single descriptorless source is valid, including CDN URLs with commas.
    if (!entries.length && value.trim() && !/\s/.test(value.trim())) {
      entries.push({ url: value.trim(), widthHint: 0, priority: 10, source: 'srcset' });
    }
    return entries;
  };
  const add = (el, variants, alt = '') => {
    if (el.closest(unrelated) || /\b(logo|icon|avatar|flag|badge)\b/i.test(alt)) return;
    variants = variants.map((item) => ({ ...item, url: absolute(item.url) }))
      .filter((item) => item.url && !/\.(svg|ico|gif)(?:[?#]|$)/i.test(item.url));
    if (!variants.length) return;
    if (results.length >= maxCandidates) { truncated = true; return; }
    const preferred = [...variants].sort((a, b) => b.priority - a.priority || b.widthHint - a.widthHint)[0];
    results.push({ identityUrl: preferred.url, alt, variants });
  };
  const nodes = [root, ...root.querySelectorAll('*')];
  for (const el of nodes) {
    if (el.closest(unrelated)) continue;
    const variants = [];
    for (const attr of ['data-full', 'data-full-src', 'data-original', 'data-zoom-image', 'data-gallery-src']) {
      if (el.getAttribute(attr)) variants.push({ url: el.getAttribute(attr), widthHint: 0, priority: 30, source: attr });
    }
    if (el.localName === 'img') {
      for (const attr of ['data-src', 'data-lazy-src', 'src']) {
        if (el.getAttribute(attr)) variants.push({ url: el.getAttribute(attr),
          widthHint: el.getAttribute(attr) === el.currentSrc ? el.naturalWidth : 0, priority: 0, source: attr });
      }
      if (el.currentSrc) variants.push({ url: el.currentSrc, widthHint: el.naturalWidth, priority: 5, source: 'currentSrc' });
      variants.push(...srcset(el.srcset), ...srcset(el.getAttribute('data-srcset') || ''));
      for (const source of el.closest('picture')?.querySelectorAll('source') || []) {
        variants.push(...srcset(source.srcset), ...srcset(source.getAttribute('data-srcset') || ''));
      }
      const link = el.closest('a[href]');
      if (link && /\.(jpe?g|png|webp|avif)(?:[?#]|$)/i.test(link.href)) {
        variants.push({ url: link.href, widthHint: 0, priority: 25, source: 'image-link' });
      }
    }
    const background = getComputedStyle(el).backgroundImage;
    for (const match of background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) {
      variants.push({ url: match[1] || match[2] || match[3], widthHint: 0, priority: 0, source: 'background' });
    }
    for (const attr of ['data-bg', 'data-background']) {
      if (el.getAttribute(attr)) variants.push({ url: el.getAttribute(attr), widthHint: 0, priority: 0, source: attr });
    }
    add(el, variants, el.getAttribute('alt') || el.getAttribute('aria-label') || '');
  }
  return { items: results, truncated };
}

export function imageIdentity(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) image URL without credentials');
  // Used for grouping only. Always request the unmodified, observed URL.
  for (const key of ['w', 'width', 'h', 'height', 'q', 'quality', 'dpr']) url.searchParams.delete(key);
  url.hash = '';
  url.searchParams.sort();
  return url.href;
}

export function mergeCandidates(groups, items, evidence, maxCandidates) {
  let added = 0;
  let truncated = false;
  for (const item of items) {
    const identities = new Set([imageIdentity(item.identityUrl), ...item.variants.map(({ url }) => imageIdentity(url))]);
    const matches = [...groups.values()].filter((group) => identities.has(group.key)
      || group.variants.some(({ url }) => identities.has(imageIdentity(url))));
    const key = matches[0]?.key || imageIdentity(item.identityUrl);
    if (!groups.has(key)) {
      if (groups.size >= maxCandidates) { truncated = true; continue; }
      groups.set(key, { key, alt: String(item.alt || '').slice(0, 300), evidence: [], variants: [] });
      added++;
    }
    const group = groups.get(key);
    // Shared observed variants link the grid and viewer without guessing CDN paths.
    for (const other of matches.slice(1)) {
      group.variants.push(...other.variants);
      group.evidence.push(...other.evidence);
      groups.delete(other.key);
    }
    if (!group.evidence.some((entry) => entry.selector === evidence.selector && entry.reason === evidence.reason)) {
      group.evidence.push(evidence);
    }
    for (const variant of item.variants) {
      imageIdentity(variant.url);
      if (!group.variants.some((entry) => entry.url === variant.url)) group.variants.push(variant);
    }
    group.variants = [...new Map(group.variants.map((variant) => [variant.url, variant])).values()];
    group.variants.sort((a, b) => b.priority - a.priority || b.widthHint - a.widthHint);
    if (group.variants.length > 8) truncated = true;
    group.variants = group.variants.slice(0, 8);
  }
  return { added, truncated };
}
