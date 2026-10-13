// Generates "most stereotypical man/woman in <country>" images from several
// providers, one independent request per image, with a deliberately minimal prompt.
//
// Usage: node scripts/generate-faces.mjs [--countries "Japan,Nigeria" | --countries all] [--providers openai,xai,gemini]
//                                        [--out explore/out] [--concurrency 4] [--retries 0]
// Keys come from OPENAI_API_KEY, GROK_KEY and GEMINI_KEY. Then scripts/publish-faces.py,
// scripts/make-sizes.py and scripts/face-detection/ put the images on the map.
// --countries all uses every country that has an image on the current map (public/images-small).
// Output: <out>/<provider>/<Country>-<gender>.<ext> and <out>/results.json

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PROMPT = (gender, country) => `Most stereotypical ${gender} in ${country}. No text.`;
const GENDERS = ['man', 'woman'];

const providers = {
  openai: {
    model: 'gpt-image-2.5-sunburst',
    async generate(prompt) {
      const res = await post('https://api.openai.com/v1/images/generations', process.env.OPENAI_API_KEY, {
        // "auto" picks the low tier; high matches the other models' detail
        model: this.model, prompt, size: '1024x1024', quality: 'high', n: 1
      });
      const item = res.data?.[0];
      if (!item?.b64_json) throw new Error('no image: ' + JSON.stringify(res).slice(0, 500));
      return { bytes: Buffer.from(item.b64_json, 'base64'), ext: 'png', revisedPrompt: item.revised_prompt, usage: res.usage };
    }
  },
  xai: {
    model: 'grok-imagine-image-2.0',
    async generate(prompt) {
      const res = await post('https://api.x.ai/v1/images/generations', process.env.GROK_KEY, {
        model: this.model, prompt, n: 1, aspect_ratio: '1:1', quality: 'medium', resolution: '1k', response_format: 'b64_json'
      });
      const item = res.data?.[0];
      if (!item?.b64_json) throw new Error('no image: ' + JSON.stringify(res).slice(0, 500));
      return { bytes: Buffer.from(item.b64_json, 'base64'), ext: sniffExt(item.b64_json), revisedPrompt: item.revised_prompt, usage: res.usage };
    }
  },
  gemini: {
    model: 'gemini-3-pro-image',
    async generate(prompt) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
      const res = await post(url, null, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } }
      }, { 'x-goog-api-key': process.env.GEMINI_KEY });
      const parts = res.candidates?.[0]?.content?.parts || [];
      const img = parts.find(p => p.inlineData);
      if (!img) throw new Error('no image: ' + JSON.stringify(res).slice(0, 500));
      return { bytes: Buffer.from(img.inlineData.data, 'base64'), ext: img.inlineData.mimeType.split('/')[1], usage: res.usageMetadata };
    }
  }
};

async function post(url, bearer, body, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 500)}`); }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(json.error || json).slice(0, 500)}`);
  return json;
}

function sniffExt(b64) {
  if (b64.startsWith('/9j/')) return 'jpg';
  if (b64.startsWith('iVBOR')) return 'png';
  if (b64.startsWith('UklGR')) return 'webp';
  return 'bin';
}

// Rate limits, server errors and dropped connections are retried with backoff;
// anything else (bad request, refusal) is returned to the caller right away
async function withTransientRetry(fn, tries = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = /HTTP (408|409|429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(err.message || err));
      if (!transient || attempt >= tries) throw err;
      const wait = 10000 * 2 ** (attempt - 1);
      console.log(`wait  ${(wait / 1000).toFixed(0)}s after: ${String(err.message || err).slice(0, 120)}`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
};
const countriesArg = arg('countries', 'United States of America,Nigeria,India,Brazil,Germany,Japan');
const countries = countriesArg === 'all'
  ? (await fs.readdir(path.join(ROOT, '../public/images-small'))).filter(f => f.endsWith('.webp')).map(f => f.slice(0, -5).replace(/_/g, ' ')).sort()
  : countriesArg.split(',').map(s => s.trim());
const chosen = arg('providers', Object.keys(providers).join(',')).split(',');
const OUT = path.resolve(arg('out', path.join(ROOT, '..', 'explore', 'out')));
const CONCURRENCY = +arg('concurrency', 4); // per provider
const RETRIES = +arg('retries', 0); // extra attempts after a moderation/safety refusal

await fs.mkdir(OUT, { recursive: true });
const resultsPath = path.join(OUT, 'results.json');
const results = JSON.parse(await fs.readFile(resultsPath, 'utf8').catch(() => '[]'));
const save = () => fs.writeFile(resultsPath, JSON.stringify(results, null, 2));

await Promise.all(chosen.map(async name => {
  const provider = providers[name];
  await fs.mkdir(path.join(OUT, name), { recursive: true });
  const jobs = countries.flatMap(country => GENDERS.map(gender => ({ country, gender })));
  await pool(jobs, CONCURRENCY, async ({ country, gender }) => {
    // Reruns only redo what failed
    const done = results.find(r => r.provider === name && r.country === country && r.gender === gender && r.file && !r.error);
    if (done && await fs.stat(path.join(OUT, done.file)).catch(() => null)) return;
    const prompt = PROMPT(gender, country);
    const start = Date.now();
    const entry = { provider: name, model: provider.model, country, gender, prompt, attempts: [] };
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const { bytes, ext, revisedPrompt, usage } = await withTransientRetry(() => provider.generate(prompt));
        entry.file = `${name}/${country.replace(/ /g, '_')}-${gender}.${ext}`;
        if (revisedPrompt) entry.revisedPrompt = revisedPrompt;
        if (usage) entry.usage = usage;
        await fs.writeFile(path.join(OUT, entry.file), bytes);
        entry.attempts.push('ok');
        delete entry.error;
        console.log(`ok    ${name} ${country} ${gender} (${((Date.now() - start) / 1000).toFixed(1)}s, attempt ${attempt + 1})`);
        break;
      } catch (err) {
        entry.error = String(err.message || err);
        entry.attempts.push(entry.error);
        console.log(`FAIL  ${name} ${country} ${gender} (attempt ${attempt + 1}): ${entry.error.slice(0, 200)}`);
        if (!/moderation|safety/i.test(entry.error)) break;
      }
    }
    entry.seconds = (Date.now() - start) / 1000;
    const idx = results.findIndex(r => r.provider === name && r.country === country && r.gender === gender);
    if (idx >= 0) results[idx] = entry; else results.push(entry);
    await save();
  });
}));
