// Image sets the map can show, one per model, in picker order. Adding a model
// is one entry here plus its images in public/faces/<id>/.
//
// Each model maps a country (and, for models asked about a man and a woman
// separately, a person) to its full image for the sidebar, and to a face for
// the map at a given size: an image URL, the part of it to clip into the country
// (crop), and the part of the full image that file holds (region), all as
// fractions. Smaller sizes come from scripts/make-sizes.py.
const fileName = (country) => country.replace(/ /g, '_');
const FULL_IMAGE = { x: 0, y: 0, width: 1, height: 1 };

// Widths of one face on the map, in pixels; the last one is the original
export const FACE_SIZES = [256, 512, 1024];

export const PEOPLE = ['woman', 'man'];

export const MODELS = [
  {
    id: 'midjourney',
    name: 'Midjourney',
    year: 2023,
    link: 'https://www.midjourney.com/',
    // Asked about a "person"; each result is a 2x2 grid of four candidates
    people: null,
    prompt: (country) => `/imagine prompt:"Most stereotypical person in ${country}"`,
    imageUrl: (country) => `images-small/${fileName(country)}.webp`,
    // Smaller sizes have a file per quadrant; the original size is cut from the grid
    face: (country, quadrant, size) => {
      const quadrantCrop = { x: (quadrant % 2) / 2, y: Math.floor(quadrant / 2) / 2, width: 0.5, height: 0.5 };
      return size < 1024
        ? { url: `faces/midjourney/${size}/${fileName(country)}-${quadrant}.webp`, crop: FULL_IMAGE, region: quadrantCrop }
        : { url: `images-small/${fileName(country)}.webp`, crop: quadrantCrop, region: FULL_IMAGE };
    },
    unavailable: {}
  },
  generatedSet({
    id: 'grok-imagine-2',
    name: 'Grok Imagine 2.0',
    link: 'https://x.ai/',
    unavailable: { Australia: ['woman'] }
  }),
  generatedSet({
    id: 'gpt-image-2-5',
    name: 'GPT Image 2.5',
    link: 'https://openai.com/',
    unavailable: { Brazil: ['woman'], 'Dominican Republic': ['woman'], Namibia: ['woman'], 'Puerto Rico': ['woman'], 'South Korea': ['woman'] }
  }),
  generatedSet({
    id: 'gemini-3-pro-image',
    name: 'Gemini 3 Pro Image',
    link: 'https://gemini.google.com/',
    unavailable: {}
  })
];

// A set made by scripts/generate-faces.mjs: one image per person, asked with the same
// minimal prompt for every model, in public/faces/<id>/. unavailable lists the
// images the model's moderation rejected on every attempt, by country.
function generatedSet({ id, name, link, unavailable }) {
  return {
    id,
    name,
    year: 2026,
    link,
    people: PEOPLE,
    prompt: (country, person) => `Most stereotypical ${person} in ${country}. No text.`,
    imageUrl: (country, person) => `faces/${id}/${fileName(country)}-${person}.webp`,
    face: (country, person, size) => ({
      url: `faces/${id}/${size < 1024 ? size + '/' : ''}${fileName(country)}-${person}.webp`,
      crop: FULL_IMAGE,
      region: FULL_IMAGE
    }),
    unavailable
  };
}

export function isAvailable(model, country, person) {
  return !(model.unavailable[country] || []).includes(person);
}
