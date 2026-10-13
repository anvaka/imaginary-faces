import { MODELS, PEOPLE, isAvailable } from './sources.js';

// Images are decoded, clipped and encoded in workers so the main thread stays responsive
const WORKER_COUNT = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

const loadedImages = new Map();
// The whole map always shows one model, and one person for models that were asked about a man and a woman
const view = getInitialView();
let sidebarCountry = null;

const map = new maplibregl.Map({
  container: 'map',
  zoom: 1,
  minZoom: 1,
  pitchWithRotate: false,
  layers: []
});
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();

const clipQueue = createClipQueue(WORKER_COUNT);
// Blob URLs of image sources that maplibre hasn't loaded yet, by source id
const pendingBlobUrls = new Map();
map.on('sourcedata', (e) => {
  const url = pendingBlobUrls.get(e.sourceId);
  if (url && e.isSourceLoaded) {
    URL.revokeObjectURL(url);
    pendingBlobUrls.delete(e.sourceId);
  }
});

renderPicker();
bindPicker();
loadBorders().then(initMap);

function loadBorders() {
  const bounds = 'ne_110m_admin_0_countries.geojson';
  return fetch(bounds).then(res => res.json());
}

function initMap(borders) {
  map.addSource("borders", {
    "type": "geojson",
    "data": borders
  });
  map.addLayer({
    "id": "country-backgrounds",
    "type": "fill",
    "source": "borders",
    "paint": { "fill-opacity": 0.0 },
  });
  map.addLayer({
    "id": "borders",
    "type": "line",
    "source": "borders",
    "paint": { "line-color": "#ffffff", "line-width": 1 },
  });

  for (const countryPolygon of borders.features) {
    const countryInfo = {
      country: countryPolygon.properties.admin,
      countryPolygon,
      // Which of Midjourney's four candidates is shown, picked per country in the sidebar
      quadrant: 0,
      loadedKeys: [],
      version: 0
    };
    loadedImages.set(countryInfo.country, countryInfo);
    renderCountry(countryInfo);
  }

  map.on('click', function (e) {
    let features = map.queryRenderedFeatures(e.point, {layers: ['country-backgrounds']});
    if (!features.length) return;
    renderSideBar(features[0].properties.admin);
  });
}

function getInitialView() {
  const params = new URLSearchParams(location.search);
  const model = MODELS.find(m => m.id === params.get('model')) || MODELS[0];
  const person = PEOPLE.includes(params.get('person')) ? params.get('person') : PEOPLE[0];
  return { model, person };
}

function setView(changes) {
  const next = { ...view, ...changes };
  if (next.model === view.model && next.person === view.person) return;
  const modelChanged = next.model !== view.model;
  const imagesChanged = modelChanged || next.model.people;
  Object.assign(view, next);

  const params = new URLSearchParams(location.search);
  if (view.model === MODELS[0]) params.delete('model');
  else params.set('model', view.model.id);
  if (view.model.people) params.set('person', view.person);
  else params.delete('person');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);

  renderPicker();
  if (imagesChanged) loadedImages.forEach(renderCountry);
  if (sidebarCountry) renderSideBar(sidebarCountry);
}

// The picker is a model menu, which stays compact however many models there are,
// plus a woman/man toggle for models that were asked about each separately.
function renderPicker() {
  const picker = document.querySelector('#face-picker');
  picker.innerHTML = `
    <button type="button" class="model-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="model-list">
      <span class="model-name">${view.model.name}</span>
      <span class="model-year">${view.model.year}</span>
      <svg class="chevron" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 5l4-4 4 4" /></svg>
    </button>
    <ul id="model-list" role="listbox" aria-label="Model" tabindex="-1" hidden>${MODELS.map(m => `
      <li role="option" id="model-option-${m.id}" data-model="${m.id}" aria-selected="${m === view.model}">
        <span class="model-name">${m.name}</span>
        <span class="model-year">${m.year}</span>
        <span class="model-prompt">${promptTemplateHtml(m)}</span>
      </li>`).join('')}
    </ul>
    ${view.model.people ? `<div class="person-toggle" role="radiogroup" aria-label="Person">${view.model.people.map(person =>
      `<button type="button" role="radio" aria-checked="${person === view.person}" data-person="${person}">${person}</button>`
    ).join('')}</div>` : ''}`;
}

// What each model was asked, with the country left as a placeholder
function promptTemplateHtml(model) {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const prompt = escape(model.prompt('\u0000', model.people?.join(' / ')));
  return prompt.replace('\u0000', '<i>country</i>');
}

function bindPicker() {
  const picker = document.querySelector('#face-picker');
  const button = () => picker.querySelector('.model-button');
  const list = () => picker.querySelector('#model-list');
  const options = () => [...list().querySelectorAll('[role="option"]')];

  function open() {
    list().hidden = false;
    button().setAttribute('aria-expanded', 'true');
    setActive(options().find(o => o.getAttribute('aria-selected') === 'true'));
    list().focus();
  }
  function close(focusButton) {
    if (list().hidden) return;
    list().hidden = true;
    button().setAttribute('aria-expanded', 'false');
    if (focusButton) button().focus();
  }
  function setActive(option) {
    options().forEach(o => o.classList.toggle('active', o === option));
    list().setAttribute('aria-activedescendant', option.id);
  }
  function choose(option) {
    close(false);
    setView({ model: MODELS.find(m => m.id === option.dataset.model) });
    button().focus();
  }

  picker.addEventListener('click', (e) => {
    const option = e.target.closest('[role="option"]');
    if (option) return choose(option);
    if (e.target.closest('.model-button')) return list().hidden ? open() : close(true);
    const person = e.target.closest('button[data-person]');
    if (person) setView({ person: person.dataset.person });
  });
  picker.addEventListener('mousemove', (e) => {
    const option = e.target.closest('[role="option"]');
    if (option) setActive(option);
  });
  picker.addEventListener('keydown', (e) => {
    if (e.target.closest('.model-button') && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      return open();
    }
    if (e.target !== list()) return;
    const all = options();
    const index = all.findIndex(o => o.classList.contains('active'));
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: all.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      setActive(all[Math.max(0, Math.min(all.length - 1, moves[e.key]))]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(all[index]);
    } else if (e.key === 'Escape') {
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!picker.contains(e.target)) close(false);
  });
}

// Clips the country's image in a worker, then swaps its layers in one go,
// so the previous image stays visible until the new one is ready.
function renderCountry(countryInfo) {
  const { country, countryPolygon } = countryInfo;
  const { model } = view;
  // Midjourney is the only model with several candidates in one image
  const variant = model.people ? view.person : countryInfo.quadrant;
  const version = ++countryInfo.version;
  if (!isAvailable(model, country, variant)) {
    clipQueue.cancel(country);
    replaceLayers(countryInfo, []);
    return;
  }
  // Keyed by country, so this replaces any earlier request for it that hasn't finished
  clipQueue.clip(country, model.imageUrl(country, variant), model.crop(variant), getOuterRings(countryPolygon)).then(results => {
    if (!results || version !== countryInfo.version) return;
    replaceLayers(countryInfo, results.map(({ blob, coordinates }, polyIndex) => {
      const imgKey = `image-${country}-${model.id}-${variant}-${polyIndex}-${version}`;
      const url = URL.createObjectURL(blob);
      pendingBlobUrls.set(imgKey, url);
      map.addSource(imgKey, { "type": "image", "url": url, "coordinates": coordinates });
      map.addLayer({
        "id": imgKey,
        "type": "raster",
        "source": imgKey,
        "paint": { "raster-opacity": 1 }
      }, 'borders');
      return imgKey;
    }));
  }).catch(err => {
    if (version === countryInfo.version) replaceLayers(countryInfo, []);
    console.error(`Failed to render ${country}`, err);
  });
}

function replaceLayers(countryInfo, newKeys) {
  countryInfo.loadedKeys.forEach(key => {
    map.removeLayer(key);
    map.removeSource(key);
  });
  countryInfo.loadedKeys = newKeys;
}

function getOuterRings(countryPolygon) {
  const { type, coordinates } = countryPolygon.geometry;
  if (type === "MultiPolygon") return coordinates.map(polygon => polygon[0]);
  if (type === "Polygon") return [coordinates[0]];
  return [];
}

// Runs clip jobs on a pool of workers, one job per worker at a time. A job is
// keyed by country: a new job for the same key cancels the old one, whether it
// is still waiting or already downloading, and the old promise resolves to null.
// Without this, switching sets mid-load would wait for every stale image first.
function createClipQueue(workerCount) {
  const pending = [];
  const jobs = new Map(); // key -> job, for jobs that are waiting or running
  const running = new Map(); // job id -> job
  const idle = [];
  let nextId = 0;

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(new URL('./clipWorker.js', import.meta.url));
    worker.onmessage = (e) => {
      const { id, results, error } = e.data;
      const job = running.get(id);
      running.delete(id);
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      if (job.cancelled) job.resolve(null);
      else if (error) job.reject(new Error(error));
      else job.resolve(results);
      idle.push(worker);
      dispatch();
    };
    idle.push(worker);
  }

  function dispatch() {
    while (idle.length && pending.length) {
      const job = pending.shift();
      job.worker = idle.pop();
      running.set(job.message.id, job);
      job.worker.postMessage(job.message);
    }
  }

  function cancel(key) {
    const job = jobs.get(key);
    if (!job) return;
    jobs.delete(key);
    job.cancelled = true;
    if (job.worker) {
      // The worker answers the cancel like any job, which frees it for the next one
      job.worker.postMessage({ cancel: job.message.id });
    } else {
      pending.splice(pending.indexOf(job), 1);
      job.resolve(null);
    }
  }

  return {
    cancel,
    clip(key, url, crop, rings) {
      cancel(key);
      return new Promise((resolve, reject) => {
        // Absolute, since relative URLs in a worker resolve against the worker's own location
        const absoluteUrl = new URL(url, document.baseURI).href;
        const job = { key, resolve, reject, message: { id: nextId++, url: absoluteUrl, crop, rings } };
        jobs.set(key, job);
        pending.push(job);
        dispatch();
      });
    }
  };
}

function renderSideBar(countryName) {
  if (!countryName) return;
  const countryInfo = loadedImages.get(countryName);
  if (!countryInfo) return;
  const { model } = view;
  sidebarCountry = countryName;

  const sidebar = document.querySelector('#sidebar');
  sidebar.innerHTML = `
    <h3 class='query-title'>Query sent to <a href="${model.link}">${model.name}</a>
    <a href='#' class='close'>[x]</a>
    </h3>
    ${model.people ? peopleHtml(model, countryName) : quadrantPickerHtml(model, countryName)}
    <hr />
    <iframe src="https://en.m.wikipedia.org/wiki/${countryName}" width="100%" height="100%" frameborder="0"></iframe>
  `;
  sidebar.style.display = 'block';
  sidebar.scrollTop = 0;
  sidebar.querySelector('.close').addEventListener('click', (e) => {
    e.preventDefault();
    closeSideBar();
  });

  if (!model.people) bindQuadrantPicker(sidebar, countryInfo);
}

function closeSideBar() {
  const sidebar = document.querySelector('#sidebar');
  sidebar.innerHTML = '';
  sidebar.style.display = 'none';
  sidebarCountry = null;
}

function selectQuadrant(countryInfo, quadrant) {
  if (countryInfo.quadrant === quadrant) return;
  countryInfo.quadrant = quadrant;
  renderCountry(countryInfo);
  if (window.innerWidth < 600) closeSideBar();
}

function quadrantPickerHtml(model, countryName) {
  const url = model.imageUrl(countryName);
  return `
    <code>/imagine prompt:"Most stereotypical person in <b>${countryName}</b>"</code>
    <div style="width:100%; position: relative;" class="imgContainer">
      <img src="${url}" alt="imagine most stereotypical person in ${countryName}" />
      <div class="quadrant-border"></div>
    </div>
    <a href="${url}" target="_blank" class="result-open">Open image in new tab</a>`;
}

// Both people side by side, the one on the map first, so the other is one glance away
function peopleHtml(model, countryName) {
  const people = [view.person, ...model.people.filter(p => p !== view.person)];
  return people.map(person => {
    const prompt = `Most stereotypical <b>${person}</b> in <b>${countryName}</b>. No text.`;
    if (!isAvailable(model, countryName, person)) {
      return `<code>${prompt}</code>
        <p class="person-missing">${model.name} refused to generate this image: its moderation rejected every attempt.</p>`;
    }
    const url = model.imageUrl(countryName, person);
    return `<code>${prompt}</code>
      <img src="${url}" alt="${model.prompt(countryName, person)}" />
      <a href="${url}" target="_blank" class="result-open">Open image in new tab</a>`;
  }).join('');
}

function bindQuadrantPicker(sidebar, countryInfo) {
  const mainImage = sidebar.querySelector('.imgContainer');
  const quadrantBorder = sidebar.querySelector('.quadrant-border');
  // mainImage has four quadrants, we want to highlight each one as mouse enters over it
  mainImage.addEventListener('mousemove', (e) => {
    const { quadrant, width, height } = getQuadrant(e, mainImage);
    quadrantBorder.style.left = (quadrant % 2 === 0 ? 0 : width/2) + 'px';
    quadrantBorder.style.top = (quadrant < 2 ? 0 : height/2) + 'px';
    quadrantBorder.style.width = width/2 + 'px';
    quadrantBorder.style.height = height/2 + 'px';
    quadrantBorder.style.border = '2px solid #fff';
    quadrantBorder.style.position = 'absolute';
  });
  mainImage.addEventListener('mouseleave', (e) => {
    quadrantBorder.style.border = 'none';
  });
  mainImage.addEventListener('click', (e) => {
    const { quadrant } = getQuadrant(e, mainImage);
    if (quadrant < 0 || quadrant > 3) throw new Error('Invalid quadrant');
    selectQuadrant(countryInfo, quadrant);
  });

  function getQuadrant(e, mainImage) {
    const clientRect = mainImage.getBoundingClientRect();
    const x = e.clientX - clientRect.left;
    const y = e.clientY - clientRect.top;
    const width = clientRect.width;
    const height = clientRect.height;
    return {quadrant: (x < width/2 ? 0 : 1) + (y < height/2 ? 0 : 2), width, height};
  }
}
