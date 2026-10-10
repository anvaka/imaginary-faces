// Images are decoded, clipped and encoded in workers so the main thread stays responsive
const WORKER_COUNT = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

const loadedImages = new Map();

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
      quadrant: 0,
      countryPolygon,
      image: getImageUrl(countryPolygon.properties.admin),
      loadedKeys: [],
      version: 0
    };
    loadedImages.set(countryPolygon.properties.admin, countryInfo);
    renderCountry(countryInfo);
  }

  map.on('click', function (e) {
    let features = map.queryRenderedFeatures(e.point, {layers: ['country-backgrounds']});
    if (!features.length) return;
    renderSideBar(features[0].properties.admin);
  });
}

// Clips the country's image in a worker, then swaps its layers in one go,
// so the old quadrant stays visible until the new one is ready.
function renderCountry(countryInfo) {
  const { countryPolygon, image, quadrant } = countryInfo;
  const version = ++countryInfo.version;
  clipQueue.clip(image, quadrant, getOuterRings(countryPolygon)).then(results => {
    if (version !== countryInfo.version) return;
    countryInfo.loadedKeys.forEach(key => {
      map.removeLayer(key);
      map.removeSource(key);
    });
    countryInfo.loadedKeys = results.map(({ blob, coordinates }, polyIndex) => {
      const imgKey = `image-${countryPolygon.properties.admin}-${quadrant}${polyIndex}-${version}`;
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
    });
  }).catch(err => console.error(`Failed to render ${countryPolygon.properties.admin}`, err));
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
    const worker = new Worker('clipWorker.js');
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
    clip(url, quadrant, rings) {
      return new Promise((resolve, reject) => {
        pending.push({ message: { id: nextId++, url, quadrant, rings }, resolve, reject });
        dispatch();
      });
    }
  };
}

function renderSideBar(countryName) {
  if (!countryName) return;
  let content = `
    <h3 class='query-title'>Query sent to <a href="https://www.midjourney.com/">Midjourney</a>
    <a href='#' class='close'>[x]</a>
    </h3>
    <code>/imagine prompt:"Most stereotypical person in <b>${countryName}</b>"</code>
    <div style="width:100%; position: relative;" class="imgContainer">
      <img src="${getImageUrl(countryName)}" alt="imagine most stereotypical person in ${countryName}" />
      <div class="quadrant-border"></div>
    </div>
    <a href="${getImageUrl(countryName)}" target="_blank" class="result-open">Open image in new tab</a>
    <hr />
    <iframe src="https://en.m.wikipedia.org/wiki/${countryName}" width="100%" height="100%" frameborder="0"></iframe>
  `;
  let sidebar = document.querySelector('#sidebar');
  sidebar.innerHTML = content;
  sidebar.style.display = 'block';
  sidebar.scrollTop = 0;
  sidebar.querySelector('.close').addEventListener('click', (e) => {
    e.preventDefault();
    sidebar.innerHTML = '';
    sidebar.style.display = 'none';
  });

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

    const countryInfo = loadedImages.get(countryName);
    if (!countryInfo || countryInfo.quadrant === quadrant) return;
    countryInfo.quadrant = quadrant;
    renderCountry(countryInfo);
    if (window.innerWidth < 600) {
      sidebar.innerHTML = '';
      sidebar.style.display = 'none';
    }
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
function getImageUrl(adminName) {
  return 'images-small/' + adminName.replace(/ /g, '_') + '.webp';
}