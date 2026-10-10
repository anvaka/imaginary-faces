// Fetches a country image, decodes it, and clips the cropped part of it to each
// of the country's polygons. Runs entirely off the main thread.
self.onmessage = async (e) => {
  const { id, url, crop, rings } = e.data;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const bitmap = await createImageBitmap(await response.blob());
    const width = Math.round(bitmap.width * crop.width);
    const height = Math.round(bitmap.height * crop.height);
    const sx = Math.round(bitmap.width * crop.x);
    const sy = Math.round(bitmap.height * crop.y);

    const results = [];
    for (const ring of rings) {
      const { bounds, coordinates } = getBounds(ring);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      clipToRing(ctx, ring, bounds, width, height);
      ctx.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);
      results.push({ blob: await canvas.convertToBlob(), coordinates });
    }
    bitmap.close();
    self.postMessage({ id, results });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

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
