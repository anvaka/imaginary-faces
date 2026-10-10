import { SOURCES, CHOICES, isAvailable } from './sources.js';

// Images are decoded, clipped and encoded in workers so the main thread stays responsive
const WORKER_COUNT = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

const loadedImages = new Map();
let choice = getInitialChoice();
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
      variant: choice.variant,
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

function getInitialChoice() {
  const id = new URLSearchParams(location.search).get('faces');
  return CHOICES.find(c => c.id === id) || CHOICES[0];
}

function setChoice(nextChoice) {
  if (nextChoice === choice) return;
  choice = nextChoice;
  const params = new URLSearchParams(location.search);
  if (choice === CHOICES[0]) params.delete('faces');
  else params.set('faces', choice.id);
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);

  renderPicker();
  for (const countryInfo of loadedImages.values()) {
    countryInfo.variant = choice.variant;
    renderCountry(countryInfo);
  }
  if (sidebarCountry) renderSideBar(sidebarCountry);
}

function renderPicker() {
  const picker = document.querySelector('#face-picker');
  picker.innerHTML = CHOICES.map(c =>
    `<button type="button" role="radio" aria-checked="${c === choice}" data-choice="${c.id}">${c.label}</button>`
  ).join('');
  picker.onclick = (e) => {
    const button = e.target.closest('button[data-choice]');
    if (button) setChoice(CHOICES.find(c => c.id === button.dataset.choice));
  };
}

// Clips the country's image in a worker, then swaps its layers in one go,
// so the previous image stays visible until the new one is ready.
function renderCountry(countryInfo) {
  const { country, countryPolygon, variant } = countryInfo;
  const sourceId = choice.source;
  const source = SOURCES[sourceId];
  const version = ++countryInfo.version;
  if (!isAvailable(sourceId, country, variant)) {
    replaceLayers(countryInfo, []);
    return;
  }
  clipQueue.clip(source.imageUrl(country, variant), source.crop(variant), getOuterRings(countryPolygon)).then(results => {
    if (version !== countryInfo.version) return;
    replaceLayers(countryInfo, results.map(({ blob, coordinates }, polyIndex) => {
      const imgKey = `image-${country}-${sourceId}-${variant}-${polyIndex}-${version}`;
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

function createClipQueue(workerCount) {
  const pending = [];
  const callbacks = new Map();
  const idle = [];
  let nextId = 0;

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(new URL('./clipWorker.js', import.meta.url));
    worker.onmessage = (e) => {
      const { id, results, error } = e.data;
      const { resolve, reject } = callbacks.get(id);
      callbacks.delete(id);
      if (error) reject(new Error(error));
      else resolve(results);
      idle.push(worker);
      dispatch();
    };
    idle.push(worker);
  }

  function dispatch() {
    while (idle.length && pending.length) {
      const { message, resolve, reject } = pending.shift();
      callbacks.set(message.id, { resolve, reject });
      idle.pop().postMessage(message);
    }
  }

  return {
    clip(url, crop, rings) {
      return new Promise((resolve, reject) => {
        // Absolute, since relative URLs in a worker resolve against the worker's own location
        const absoluteUrl = new URL(url, document.baseURI).href;
        pending.push({ message: { id: nextId++, url: absoluteUrl, crop, rings }, resolve, reject });
        dispatch();
      });
    }
  };
}

function renderSideBar(countryName) {
  if (!countryName) return;
  const countryInfo = loadedImages.get(countryName);
  if (!countryInfo) return;
  const source = SOURCES[choice.source];
  sidebarCountry = countryName;

  const sidebar = document.querySelector('#sidebar');
  sidebar.innerHTML = `
    <h3 class='query-title'>Query sent to <a href="${source.link}">${source.name}</a>
    <a href='#' class='close'>[x]</a>
    </h3>
    <code>${choice.source === 'midjourney'
      ? `/imagine prompt:"Most stereotypical person in <b>${countryName}</b>"`
      : `Most stereotypical <b>${countryInfo.variant}</b> in <b>${countryName}</b>. No text.`}</code>
    ${choice.source === 'midjourney' ? quadrantPickerHtml(countryName) : variantPickerHtml(choice.source, countryInfo)}
    <hr />
    <iframe src="https://en.m.wikipedia.org/wiki/${countryName}" width="100%" height="100%" frameborder="0"></iframe>
  `;
  sidebar.style.display = 'block';
  sidebar.scrollTop = 0;
  sidebar.querySelector('.close').addEventListener('click', (e) => {
    e.preventDefault();
    closeSideBar();
  });

  if (choice.source === 'midjourney') bindQuadrantPicker(sidebar, countryInfo);
  else bindVariantPicker(sidebar, countryInfo);
}

function closeSideBar() {
  const sidebar = document.querySelector('#sidebar');
  sidebar.innerHTML = '';
  sidebar.style.display = 'none';
  sidebarCountry = null;
}

function selectVariant(countryInfo, variant) {
  if (countryInfo.variant === variant) return;
  countryInfo.variant = variant;
  renderCountry(countryInfo);
  if (window.innerWidth < 600) closeSideBar();
  else renderSideBar(countryInfo.country);
}

function quadrantPickerHtml(countryName) {
  const url = SOURCES.midjourney.imageUrl(countryName);
  return `
    <div style="width:100%; position: relative;" class="imgContainer">
      <img src="${url}" alt="imagine most stereotypical person in ${countryName}" />
      <div class="quadrant-border"></div>
    </div>
    <a href="${url}" target="_blank" class="result-open">Open image in new tab</a>`;
}

function variantPickerHtml(sourceId, countryInfo) {
  const source = SOURCES[sourceId];
  return `<div class="variant-grid">${source.variants.map(variant => {
    if (!isAvailable(sourceId, countryInfo.country, variant)) {
      return `<div class="variant unavailable"><div class="variant-missing">${source.name} refused to generate this image: its moderation rejected every attempt.</div><span>${variant}</span></div>`;
    }
    const url = source.imageUrl(countryInfo.country, variant);
    return `<button type="button" class="variant" data-variant="${variant}" aria-pressed="${variant === countryInfo.variant}">
      <img src="${url}" alt="${source.prompt(countryInfo.country, variant)}" />
      <span>${variant}</span>
    </button>`;
  }).join('')}</div>
  <p class="variant-hint">Each image is a separate request. Click one to show it on the map.</p>`;
}

function bindVariantPicker(sidebar, countryInfo) {
  sidebar.querySelector('.variant-grid').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-variant]');
    if (button) selectVariant(countryInfo, button.dataset.variant);
  });
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
    selectVariant(countryInfo, quadrant);
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
