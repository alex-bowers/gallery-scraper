import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lookupRecipe, readJson, reviewedRun, saveRecipe, checkBrowserRecipe, validateRecipe } from './recipes.mjs';

export function workflowStatus(manifest) {
  const browser = ['browser', 'mixed'].includes(manifest.transport);
  const saved = manifest.photos?.length || 0;
  const requested = manifest.limits?.maxImages || 0;
  const counters = { requested, candidates: manifest.candidateGroups || 0, saved,
    remaining: Math.max(0, requested - saved),
    rejected: (manifest.attempts || []).filter(({ status }) => status === 'rejected').length,
    duplicates: (manifest.attempts || []).filter(({ status }) => status === 'duplicate-content').length };
  let nextAction;
  if (manifest.finalisation) nextAction = 'report';
  else if (manifest.access?.blocked && !browser) nextAction = !manifest.fallback ? 'use-browser'
    : manifest.fallback.available ? 'continue-browser' : 'browser-unavailable';
  else if (browser && manifest.status === 'exploring') nextAction = 'collect-browser';
  else if (manifest.status === 'exploring') nextAction = !manifest.scopes?.length ? 'identify-gallery'
    : !counters.candidates ? 'collect' : 'download';
  else if (manifest.status === 'downloaded' && saved < requested && manifest.exploration?.status === 'limit'
    && manifest.stopReason === 'candidates-exhausted') nextAction = browser ? 'collect-more-browser' : 'collect-more';
  else if (saved && !manifest.review) nextAction = 'review';
  else if (manifest.recipeSave?.eligible && manifest.recipeSave.action !== 'reuse') nextAction = 'save-recipe';
  else nextAction = 'finish';
  const instructions = {
    'use-browser': 'Inspect available browser tools and the user’s existing target tab now. Helper restrictions do not establish browser restrictions. Record the browser attempt; never bypass an access control.',
    'continue-browser': 'Close the helper if still running, then run browser.mjs start --manifest <this-run/manifest.json>. Continue the accessible user browser and verify its saved files in this same run.',
    'browser-unavailable': 'Explain the actual browser/tool checks and ask the user to open or share the page. Finalise an incomplete result only if collection cannot continue; do not return to the blocked helper.',
    'collect-browser': 'Use the accessible user browser to confirm/open the gallery, save its photos and record observed positions in browser-collection.json. Then run browser.mjs verify; helper scope/collect commands are not needed.',
    'collect-more-browser': 'Save more photos from this same browser gallery, update browser-collection.json and run browser.mjs verify again. Keep existing files and the agreed cap.',
    'identify-gallery': 'Confirm page identity, open one image if necessary, and select the specific gallery or larger-image viewer. Exclude navigation, promotions, reviews and video posters.',
    collect: 'Collect from the confirmed scope. Prefer bulk gallery/viewer data before navigating individual slides.',
    download: 'Download the collected candidates. The saved count, not the candidate count, determines progress.',
    'collect-more': 'Some candidates did not fill the cap. Continue within the same gallery and session, collect new candidates, then download again; retain the existing limits.',
    review: 'Read the manifest, reconcile the files and visually inspect saved samples. Record a factual review.',
    'save-recipe': 'Prepare a reusable draft from the proven method, then run recipes.mjs finish with --manifest and --draft. Recipe saving is automatic under this workflow.',
    finish: 'Run recipes.mjs finish with --manifest. Supply --draft for a new or corrected method. Report incomplete work honestly.',
    report: 'Report the saved count, output folder, verified dimensions, stopping evidence and explicit recipe outcome from finalisation.',
  };
  return { counters, nextAction, instruction: instructions[nextAction],
    pending: manifest.finalisation ? [] : [nextAction, ...(nextAction === 'finish' ? [] : ['finish'])] };
}

export async function reviewManifest(manifest, { verified, evidence }, directory) {
  if (manifest.status !== 'downloaded') throw new Error('Download or verify browser files before reviewing this run');
  if (typeof verified !== 'boolean' || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 1000) {
    throw new Error('Supply verified (boolean) and review evidence up to 1000 characters');
  }
  manifest.review = { verified, evidence: evidence.trim(), at: new Date().toISOString() };
  delete manifest.finalisation;
  let eligible = false;
  let reason;
  try { reviewedRun(manifest); eligible = true; } catch (error) { reason = error.message; }
  const lookup = await lookupRecipe(manifest.pageUrl || manifest.sourceUrl, directory);
  const reusable = lookup.status === 'found' && manifest.recipe?.status === 'matched'
    && manifest.recipe.hash === lookup.hash && manifest.recipe.methods?.length > 0;
  manifest.recipeSave = { eligible, reason, hostname: lookup.hostname, domainStatus: lookup.status,
    action: !eligible ? 'ineligible' : lookup.status === 'missing' ? 'create'
      : lookup.status === 'invalid' ? 'repair' : reusable ? 'reuse' : 'update',
    offer: false, file: lookup.file };
  return { review: manifest.review, recipeSave: manifest.recipeSave, workflow: workflowStatus(manifest) };
}

// Both browser verification and helper downloads end here. The resource-owning
// browser can be closed first; this command cannot leave a browser running.
export async function finishRun({ manifestFile, draftFile, directory, recipeDeclined }) {
  const manifest = await readJson(manifestFile, 8 * 1024 * 1024);
  if (!['browser', 'mixed'].includes(manifest.transport) && !manifest.finishedAt) throw new Error('Close the helper before finishing its run');
  if (manifest.access?.blocked && !manifest.fallback) {
    throw new Error('Check the user’s browser and record the fallback attempt before finishing a blocked helper run');
  }
  if (manifest.photos?.length && !manifest.review) throw new Error('Review the saved files before finishing');
  if (manifest.photos?.length) {
    const { auditBrowserFiles, auditSavedFiles } = await import('./browser.mjs');
    if (['browser', 'mixed'].includes(manifest.transport)) await auditBrowserFiles(path.dirname(manifestFile), manifest);
    else await auditSavedFiles(path.dirname(manifestFile), manifest);
  }
  if (manifest.finalisation?.recipe.hash && !draftFile && recipeDeclined === undefined) {
    const lookup = await lookupRecipe(manifest.pageUrl || manifest.sourceUrl, directory);
    if (lookup.status === 'found' && lookup.hash === manifest.finalisation.recipe.hash && lookup.file === manifest.finalisation.recipe.file) {
      return { ready: true, ...manifest.finalisation, runDir: path.dirname(manifestFile), workflow: workflowStatus(manifest) };
    }
  }
  let eligible = false;
  let reason;
  try { reviewedRun(manifest); eligible = true; } catch (error) { reason = error.message; }
  let recipe;
  if (recipeDeclined !== undefined) {
    if (typeof recipeDeclined !== 'string' || !recipeDeclined.trim() || recipeDeclined.length > 1000) throw new Error('Record the user’s explicit recipe refusal');
    if (draftFile) throw new Error('A declined recipe cannot also supply a draft');
    recipe = { status: 'declined', reason: recipeDeclined };
  } else if (!eligible) {
    if (draftFile) throw new Error(`Cannot save an unproven recipe: ${reason}`);
    recipe = { status: 'ineligible', reason };
  } else {
    const lookup = await lookupRecipe(manifest.pageUrl || manifest.sourceUrl, directory);
    if (lookup.status === 'invalid') throw new Error(`Preserve and repair the invalid recipe explicitly: ${lookup.error}`);
    if (draftFile) {
      const draft = await readJson(draftFile);
      validateRecipe(draft, { draft: true });
      if (['browser', 'mixed'].includes(manifest.transport)) {
        const collection = await readJson(path.join(path.dirname(manifestFile), 'browser-collection.json'), 4 * 1024 * 1024);
        const checked = checkBrowserRecipe(collection.observation, { status: 'found', recipe: draft });
        if (checked.methods.length !== draft.methods.length) throw new Error('Browser recipe checks must match the recorded observation');
      }
      recipe = { status: lookup.status === 'found' ? 'updated' : 'saved',
        ...await saveRecipe({ draft, manifest, directory, approved: true, update: lookup.status === 'found' }) };
      recipe.hash = (await lookupRecipe(manifest.pageUrl || manifest.sourceUrl, directory)).hash;
    } else if (lookup.status === 'found' && manifest.recipe?.status === 'matched'
      && manifest.recipe.hash === lookup.hash && manifest.recipe.methods?.length
      && manifest.recipe.methods.every((id) => lookup.recipe.methods.some((method) => method.id === id))) {
      recipe = { status: 'reused', file: lookup.file, hash: lookup.hash, methods: manifest.recipe.methods };
    } else throw new Error('A proven new or changed method needs --draft before this run can finish');
  }
  const shortfall = manifest.exploration?.status === 'limit' && manifest.photos?.length < manifest.limits?.maxImages;
  manifest.finalisation = { at: new Date().toISOString(), complete: eligible && !shortfall, recipe };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ready: true, ...manifest.finalisation, runDir: path.dirname(manifestFile), workflow: workflowStatus(manifest) };
}
