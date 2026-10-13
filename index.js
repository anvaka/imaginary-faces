import { MODELS, PEOPLE, FACE_SIZES, isAvailable } from './sources.js';
import { createClipQueue } from './clipQueue.js';
// Where the face is in each full image, so it can be placed on land
import faceBoxes from './faceBoxes.json';

// Images are decoded, clipped and encoded in workers so the main thread stays responsive
const WORKER_COUNT = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
// How the old set looks while a new one loads, so it can't pass for the new one
const STALE_PAINT = { 'raster-opacity': 0.25, 'raster-saturation': -1 };
// Matches maplibre's default paint transition, used to fade faces in
const FADE_MS = 300;

const countries = new Map();
// The whole map always shows one model, and one person for models that were asked about a man and a woman
const view = getInitialView();
// The set being loaded, if any: { pending: countries still loading, total }
let loading = null;
let sidebarCountry = null;
// The model the sidebar shows. It opens on the map's model, and the thumbnails at
// its top switch it, to compare models for one country without reloading the map.
let sidebarModel = null;
// The model whose faces download ahead while the user points at it, and the
// timer that waits to see the pointer stay there
let prefetching = null;
let prefetchTimer = 0;

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
// Callbacks for image sources maplibre hasn't loaded yet, by source id
const sourceWaiters = new Map();
map.on('sourcedata', (e) => {
  if (e.isSourceLoaded) sourceWaiters.get(e.sourceId)?.();
});

renderPicker();
bindPicker();
bindSideBar();
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
    const rings = getOuterRings(countryPolygon);
    countries.set(countryPolygon.properties.admin, {
      country: countryPolygon.properties.admin,
      rings,
      ringBounds: rings.map(getRingBounds),
      // Which of Midjourney's four candidates is shown, picked per country in the sidebar
      quadrant: 0,
      // Layers on the map and the face size they show
      shown: { keys: [], size: 0 },
      // Replaced layers still under the new ones while those fade in
      retiring: [],
      // Layers added but not yet loaded by maplibre
      unsettled: [],
      // Size of a sharper face being loaded, if any
      sharpening: 0,
      // Bumped whenever the country's face changes, to drop results of older requests
      generation: 0
    });
  }
  loadSet();

  map.on('moveend', () => {
    // While a set loads, the countries now on screen go first
    if (loading) loading.pending.forEach(country => clipQueue.setPriority(country, loadPriority(countries.get(country))));
    else sharpenVisible();
  });
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
  // The faces a model would show depend on the view, so pointing at it downloads afresh
  prefetching = null;
  clearTimeout(prefetchTimer);

  const params = new URLSearchParams(location.search);
  if (view.model === MODELS[0]) params.delete('model');
  else params.set('model', view.model.id);
  if (view.model.people) params.set('person', view.person);
  else params.delete('person');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);

  renderPicker();
  if (imagesChanged && countries.size) loadSet();
  // The sidebar follows the map to a new model, and keeps the one it shows otherwise
  if (sidebarCountry) showInSideBar(modelChanged ? view.model : sidebarModel);
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
    <div class="load-progress" role="progressbar" aria-label="Loading faces" aria-valuemin="0" aria-valuemax="100" hidden></div>
    ${view.model.people ? `<div class="person-toggle" role="radiogroup" aria-label="Person">${view.model.people.map(person =>
      `<button type="button" role="radio" aria-checked="${person === view.person}" data-person="${person}">${person}</button>`
    ).join('')}</div>` : ''}`;
  updateProgress();
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
    prefetchSet(MODELS.find(m => m.id === option.dataset.model));
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

// Loads the current set: the smallest face of every country, the ones on screen
// first. The faces of the set it replaces are greyed out right away, and each
// country's new face replaces its grey one as soon as it arrives.
function loadSet() {
  const set = loading = { pending: new Set(countries.keys()), total: countries.size };
  for (const info of countries.values()) {
    info.generation++;
    info.sharpening = 0;
    removeLayers(info.unsettled);
    removeLayers(info.retiring);
    info.retiring = [];
    info.shown.keys.forEach(dimLayer);
  }
  updateProgress();
  for (const info of countries.values()) loadIntoSet(info, set);
}

function loadIntoSet(info, set) {
  const generation = ++info.generation;
  loadFace(info, FACE_SIZES[0], loadPriority(info)).then(keys => {
    if (keys === null || generation !== info.generation) return;
    swapIn(info, keys, FACE_SIZES[0]);
    set.pending.delete(info.country);
    updateProgress();
    if (!set.pending.size) finishSet(set);
  });
}

// The countries on screen load first, the biggest of them first, so the new
// set shows where the user is looking
function loadPriority(info) {
  const { visible, facePixels } = getScreenSize(info);
  return visible ? 1 / (1 + facePixels) : 1;
}

function finishSet(set) {
  if (loading !== set) return;
  loading = null;
  updateProgress();
  sharpenVisible();
}

// Downloads a model's faces while the user points at it to switch, so choosing
// it doesn't wait for the network. They're the faces loadSet starts with.
function prefetchSet(model) {
  if (model === prefetching) return;
  prefetching = model;
  clearTimeout(prefetchTimer);
  // After a moment, so a pointer on its way past other models doesn't download them
  prefetchTimer = setTimeout(() => {
    if (model === view.model) return;
    const urls = [];
    for (const info of countries.values()) {
      const variant = faceVariant(model, info);
      if (isAvailable(model, info.country, variant)) urls.push(model.face(info.country, variant, FACE_SIZES[0]).url);
    }
    clipQueue.prefetch(urls);
  }, 150);
}

// Swaps in sharper faces for countries that are on screen and drawn bigger than
// their current face, the biggest first
function sharpenVisible() {
  if (loading) return;
  const pixelRatio = window.devicePixelRatio || 1;
  for (const info of countries.values()) {
    const { visible, facePixels } = getScreenSize(info);
    if (!visible) continue;
    // Allow some upscaling before fetching the next size
    const size = FACE_SIZES.find(s => s >= facePixels * pixelRatio * 0.8) || FACE_SIZES[FACE_SIZES.length - 1];
    if (size <= Math.max(info.shown.size, info.sharpening)) continue;
    showFace(info, size, 2 + 1 / facePixels);
  }
}

// Replaces one country's face, keeping the old one until the new one is loaded
function showFace(info, size, priority) {
  const generation = ++info.generation;
  info.sharpening = size;
  loadFace(info, size, priority).then(keys => {
    if (keys === null || generation !== info.generation) return;
    swapIn(info, keys, size);
    info.sharpening = 0;
  });
}

// Fades the country's new layers in over its current ones, then removes those,
// so the country never shows the background in between
function swapIn(info, keys, size) {
  const old = info.shown.keys;
  keys.forEach(key => map.setPaintProperty(key, 'raster-opacity', 1));
  info.shown = { keys, size };
  if (!old.length) return;
  info.retiring.push(...old);
  // A little past the fade, since it starts on the next frame
  setTimeout(() => {
    removeLayers(old);
    info.retiring = info.retiring.filter(key => !old.includes(key));
  }, FADE_MS + 100);
}

// Clips the country's face at the given size and adds it to the map, hidden.
// Resolves to the new layer ids once maplibre has loaded them, or to null if a
// newer request for the country came in meanwhile.
async function loadFace(info, size, priority) {
  const generation = info.generation;
  const { model } = view;
  const variant = faceVariant(model, info);
  if (!isAvailable(model, info.country, variant)) {
    clipQueue.cancel(info.country);
    return [];
  }
  const { url, crop, region } = model.face(info.country, variant, size);
  // Face boxes are fractions of the full image; the worker wants them in the fetched file's
  const faces = (faceBoxes[model.imageUrl(info.country, variant)] || []).map(([x, y, w, h]) =>
    [(x - region.x) / region.width, (y - region.y) / region.height, w / region.width, h / region.height]);
  let results;
  try {
    // Keyed by country, so this cancels any earlier request for it that hasn't finished
    results = await clipQueue.clip(info.country, { url, crop, rings: info.rings, faces }, priority);
  } catch (err) {
    console.error(`Failed to load ${info.country}`, err);
    results = [];
  }
  if (!results || generation !== info.generation) return null;

  const keys = results.map(({ blob, coordinates }, polyIndex) =>
    addImageLayer(`face-${info.country}-${model.id}-${variant}-${size}-${polyIndex}-${generation}`, blob, coordinates));
  info.unsettled.push(...keys);
  await Promise.all(keys.map(whenSourceLoaded));
  info.unsettled = info.unsettled.filter(key => !keys.includes(key));
  if (generation !== info.generation) {
    removeLayers(keys);
    return null;
  }
  return keys;
}

// Which of the model's images the map shows for the country: the person's, or
// for Midjourney, the only model with several candidates in one image, the picked one
function faceVariant(model, info) {
  return model.people ? view.person : info.quadrant;
}

// Layers start hidden, and swapIn fades them in. Maplibre's own fade-in of new
// raster images is off: it starts from transparent, which made a replaced
// face flash the background.
function addImageLayer(key, blob, coordinates) {
  const url = URL.createObjectURL(blob);
  map.addSource(key, { "type": "image", "url": url, "coordinates": coordinates });
  map.addLayer({
    "id": key,
    "type": "raster",
    "source": key,
    "paint": { "raster-opacity": 0, "raster-fade-duration": 0 }
  }, 'borders');
  const loaded = new Promise(resolve => sourceWaiters.set(key, resolve));
  loaded.then(() => {
    sourceWaiters.delete(key);
    URL.revokeObjectURL(url);
  });
  return key;
}

function whenSourceLoaded(key) {
  return new Promise(resolve => {
    const done = sourceWaiters.get(key);
    if (!done) return resolve();
    sourceWaiters.set(key, () => { done(); resolve(); });
  });
}

function removeLayers(keys) {
  for (const key of keys) {
    if (!map.getLayer(key)) continue;
    map.removeLayer(key);
    map.removeSource(key);
    // Lets anything waiting on this source move on
    sourceWaiters.get(key)?.();
  }
}

function dimLayer(key) {
  for (const [property, value] of Object.entries(STALE_PAINT)) map.setPaintProperty(key, property, value);
}

function updateProgress() {
  const progress = document.querySelector('#face-picker .load-progress');
  const done = loading ? loading.total - loading.pending.size : 0;
  // Also shown before the countries are known, while the page starts up
  progress.hidden = !loading && countries.size > 0;
  progress.style.setProperty('--progress', loading ? done / loading.total : 0);
  progress.setAttribute('aria-valuenow', Math.round(loading ? 100 * done / loading.total : 100));
}

// Where the country is on screen: whether any part of it is visible, and how
// many CSS pixels its biggest visible face spans
function getScreenSize(info) {
  const { clientWidth: width, clientHeight: height } = map.getCanvas();
  let visible = false;
  let facePixels = 0;
  for (const [[minLon, minLat], [maxLon, maxLat]] of info.ringBounds) {
    const topLeft = map.project([minLon, maxLat]);
    const bottomRight = map.project([maxLon, minLat]);
    if (bottomRight.x < 0 || topLeft.x > width || bottomRight.y < 0 || topLeft.y > height) continue;
    visible = true;
    facePixels = Math.max(facePixels, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  }
  return { visible, facePixels };
}

function getRingBounds(ring) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [[minLon, minLat], [maxLon, maxLat]];
}

function getOuterRings(countryPolygon) {
  const { type, coordinates } = countryPolygon.geometry;
  if (type === "MultiPolygon") return coordinates.map(polygon => polygon[0]);
  if (type === "Polygon") return [coordinates[0]];
  return [];
}

function renderSideBar(countryName) {
  if (!countryName) return;
  const countryInfo = countries.get(countryName);
  if (!countryInfo) return;
  sidebarCountry = countryName;

  const sidebar = document.querySelector('#sidebar');
  sidebar.innerHTML = `
    <h3 class='query-title'></h3>
    <div class="model-strip" role="radiogroup" aria-label="Model shown in the sidebar"></div>
    <div class="sidebar-body"></div>
    <hr />
    <iframe src="https://en.m.wikipedia.org/wiki/${countryName}" width="100%" height="100%" frameborder="0"></iframe>
  `;
  sidebar.style.display = 'block';
  sidebar.scrollTop = 0;
  showInSideBar(view.model);
  // So the arrow keys step through models rather than pan the map
  sidebar.querySelector('.model-strip [aria-checked="true"]').focus({ preventScroll: true });
}

// Shows a model's images in the open sidebar. Only the title, the thumbnails and
// the images are redrawn: the map and the Wikipedia page stay as they are.
function showInSideBar(model) {
  sidebarModel = model;
  const countryInfo = countries.get(sidebarCountry);
  const sidebar = document.querySelector('#sidebar');
  sidebar.querySelector('.query-title').innerHTML = `Query sent to <a href="${model.link}">${model.name}</a>
    <a href='#' class='close'>[x]</a>`;
  const strip = sidebar.querySelector('.model-strip');
  // Redrawing would scroll a row of many models back to its start
  const stripScroll = strip.scrollLeft;
  strip.innerHTML = modelStripHtml(countryInfo);
  strip.scrollLeft = stripScroll;
  sidebar.querySelector('.sidebar-body').innerHTML = model.people
    ? peopleHtml(model, sidebarCountry)
    : quadrantPickerHtml(model, sidebarCountry);
  if (!model.people) bindQuadrantPicker(sidebar, countryInfo);
}

// A small face per model, of the map's person (for Midjourney, the candidate
// picked for the map), so models that answered alike are easy to spot
function modelStripHtml(countryInfo) {
  const { country } = countryInfo;
  return MODELS.map(model => {
    const variant = faceVariant(model, countryInfo);
    const checked = model === sidebarModel;
    const thumb = isAvailable(model, country, variant)
      ? `<span class="thumb"><img src="${model.face(country, variant, FACE_SIZES[0]).url}" alt="" /></span>`
      : `<span class="thumb refused">refused</span>`;
    return `<button type="button" role="radio" aria-checked="${checked}" tabindex="${checked ? 0 : -1}" data-model="${model.id}" title="${model.name}, ${model.year}">
      ${thumb}
      <span class="model-name">${model.shortName}</span>
      ${model === view.model ? '<span class="on-map">on map</span>' : `<span class="model-year">${model.year}</span>`}
    </button>`;
  }).join('');
}

// The bottom picker owns the map; this is a shortcut to it for the model in the sidebar
function showOnMapHtml(model) {
  if (model === view.model) return '';
  return `<button type="button" class="show-on-map">Show ${model.shortName} on the map</button>`;
}

function bindSideBar() {
  const sidebar = document.querySelector('#sidebar');
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('.close')) {
      e.preventDefault();
      return closeSideBar();
    }
    const model = e.target.closest('button[data-model]');
    if (model) return pickSideBarModel(MODELS.find(m => m.id === model.dataset.model));
    if (e.target.closest('.show-on-map')) {
      setView({ model: sidebarModel });
      // The sidebar covers the map on phones
      if (window.innerWidth < 600) closeSideBar();
      else sidebar.querySelector('.model-strip [aria-checked="true"]').focus();
    }
  });
  // Pointing at "Show on the map" downloads the faces it would show
  const prefetchShown = (e) => {
    if (e.target.closest('.show-on-map')) prefetchSet(sidebarModel);
  };
  sidebar.addEventListener('pointerover', prefetchShown);
  sidebar.addEventListener('focusin', prefetchShown);
  // Left and right step through the models; up and down still scroll the sidebar
  sidebar.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step || !e.target.closest('.model-strip')) return;
    e.preventDefault();
    const index = MODELS.indexOf(sidebarModel) + step;
    pickSideBarModel(MODELS[(index + MODELS.length) % MODELS.length]);
  });
}

// Keeps focus on the model's thumbnail, which redrawing replaces
function pickSideBarModel(model) {
  showInSideBar(model);
  document.querySelector(`#sidebar button[data-model="${model.id}"]`).focus();
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
  // Picked while another model is on the map, it waits for Midjourney to be shown
  if (!view.model.people) {
    if (loading?.pending.has(countryInfo.country)) loadIntoSet(countryInfo, loading);
    else showFace(countryInfo, Math.max(countryInfo.shown.size, FACE_SIZES[0]), 0);
    if (window.innerWidth < 600) return closeSideBar();
  }
  // Midjourney's thumbnail shows the picked candidate
  showInSideBar(sidebarModel);
}

function quadrantPickerHtml(model, countryName) {
  const url = model.imageUrl(countryName);
  return `
    <code>/imagine prompt:"Most stereotypical person in <b>${countryName}</b>"</code>
    <div style="width:100%; position: relative;" class="imgContainer">
      <img class="result-image" src="${url}" alt="imagine most stereotypical person in ${countryName}" />
      <div class="quadrant-border"></div>
    </div>
    <div class="result-actions">
      <a href="${url}" target="_blank" class="result-open">Open image in new tab</a>
      ${showOnMapHtml(model)}
    </div>`;
}

// Both people side by side, the one on the map first, so the other is one glance away.
// Each image is drawn over its small copy from the thumbnails while it loads.
function peopleHtml(model, countryName) {
  const people = [view.person, ...model.people.filter(p => p !== view.person)];
  return people.map((person, index) => {
    const prompt = `Most stereotypical <b>${person}</b> in <b>${countryName}</b>. No text.`;
    const showOnMap = index === 0 ? showOnMapHtml(model) : '';
    if (!isAvailable(model, countryName, person)) {
      return `<code>${prompt}</code>
        <p class="person-missing">${model.name} refused to generate this image: its moderation rejected every attempt.</p>
        ${showOnMap ? `<div class="result-actions">${showOnMap}</div>` : ''}`;
    }
    const url = model.imageUrl(countryName, person);
    const preview = model.face(countryName, person, FACE_SIZES[0]).url;
    return `<code>${prompt}</code>
      <img class="result-image" src="${url}" style="background-image: url('${preview}')" alt="${model.prompt(countryName, person)}" />
      <div class="result-actions">
        <a href="${url}" target="_blank" class="result-open">Open image in new tab</a>
        ${showOnMap}
      </div>`;
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
