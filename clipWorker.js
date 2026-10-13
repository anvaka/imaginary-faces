// Fetches a country image, decodes it, and clips the cropped part of it to each
// of the country's polygons. Runs entirely off the main thread.
// A { cancel: id } message aborts that job, including its download.
const controllers = new Map();

self.onmessage = async (e) => {
  if ('cancel' in e.data) {
    controllers.get(e.data.cancel)?.abort();
    return;
  }
  const { id, url, crop, rings } = e.data;
  const controller = new AbortController();
  const { signal } = controller;
  controllers.set(id, controller);
  try {
    const response = await fetchWithRetry(url, signal);
    const bitmap = await createImageBitmap(await response.blob());
    const width = Math.round(bitmap.width * crop.width);
    const height = Math.round(bitmap.height * crop.height);
    const sx = Math.round(bitmap.width * crop.x);
    const sy = Math.round(bitmap.height * crop.y);

    const results = [];
    try {
      for (const ring of rings) {
        signal.throwIfAborted();
        const { bounds, coordinates } = getBounds(ring);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        clipToRing(ctx, ring, bounds, width, height);
        ctx.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);
        results.push({ blob: await canvas.convertToBlob(), coordinates });
      }
    } finally {
      bitmap.close();
    }
    self.postMessage({ id, results });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  } finally {
    controllers.delete(id);
  }
};

// Retries server errors and dropped connections, which static hosts' CDNs
// return now and then, a couple of times with a short pause
async function fetchWithRetry(url, signal, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { signal });
    } catch (err) {
      if (signal.aborted || attempt >= retries) throw err;
    }
    if (response?.ok) return response;
    if (response && (response.status < 500 || attempt >= retries)) throw new Error(`HTTP ${response.status} for ${url}`);
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    signal.throwIfAborted();
  }
}

const MAX_LATITUDE = 85.0511;

function getBounds(ring) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  minLat = Math.max(minLat, -MAX_LATITUDE);
  maxLat = Math.min(maxLat, MAX_LATITUDE);
  return {
    bounds: { topLeft: mercator(minLon, maxLat), bottomRight: mercator(maxLon, minLat) },
    coordinates: [[minLon, maxLat], [maxLon, maxLat], [maxLon, minLat], [minLon, minLat]]
  };
}

function clipToRing(ctx, ring, { topLeft, bottomRight }, width, height) {
  ctx.beginPath();
  ring.forEach(([lon, lat], i) => {
    const p = mercator(lon, lat);
    const x = (p.x - topLeft.x) / (bottomRight.x - topLeft.x) * width;
    const y = (p.y - topLeft.y) / (bottomRight.y - topLeft.y) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip();
}

function mercator(lon, lat) {
  const R = 6378137;
  const DEG = Math.PI / 180;
  const sin = Math.sin(lat * DEG);
  return { x: R * lon * DEG, y: R * Math.log((1 + sin) / (1 - sin)) / 2 };
}
