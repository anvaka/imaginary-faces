// Image sets the map can show, one per model, in picker order. Adding a model
// is one entry here plus its images in public/faces/<id>/.
//
// Each model maps a country (and, for models asked about a man and a woman
// separately, a person) to an image URL and the part of that image, as
// fractions, to clip into the country.
const fileName = (country) => country.replace(/ /g, '_');
const FULL_IMAGE = { x: 0, y: 0, width: 1, height: 1 };

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
    crop: (quadrant = 0) => ({ x: (quadrant % 2) / 2, y: Math.floor(quadrant / 2) / 2, width: 0.5, height: 0.5 }),
    unavailable: {}
  },
  {
    id: 'grok-imagine-2',
    name: 'Grok Imagine 2.0',
    year: 2026,
    link: 'https://x.ai/',
    people: PEOPLE,
    prompt: (country, person) => `Most stereotypical ${person} in ${country}. No text.`,
    imageUrl: (country, person) => `faces/grok-imagine-2/${fileName(country)}-${person}.webp`,
    crop: () => FULL_IMAGE,
    // Images the model's moderation rejected on every attempt, by country
    unavailable: { Australia: ['woman'] }
  }
];

export function isAvailable(model, country, person) {
  return !(model.unavailable[country] || []).includes(person);
}
