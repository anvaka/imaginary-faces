// Image sets the map can show. Each source maps a country and a variant to an
// image URL and the part of that image (as fractions) to clip into the country.
const fileName = (country) => country.replace(/ /g, '_');
const FULL_IMAGE = { x: 0, y: 0, width: 1, height: 1 };

export const SOURCES = {
  midjourney: {
    name: 'Midjourney',
    link: 'https://www.midjourney.com/',
    // Each Midjourney result is a 2x2 grid of four candidates; the variant is the quadrant
    variants: [0, 1, 2, 3],
    prompt: (country) => `/imagine prompt:"Most stereotypical person in ${country}"`,
    imageUrl: (country) => `images-small/${fileName(country)}.webp`,
    crop: (quadrant) => ({ x: (quadrant % 2) / 2, y: Math.floor(quadrant / 2) / 2, width: 0.5, height: 0.5 }),
    unavailable: {}
  },
  grok: {
    name: 'Grok Imagine 2.0',
    link: 'https://x.ai/',
    variants: ['woman', 'man'],
    prompt: (country, gender) => `Most stereotypical ${gender} in ${country}. No text.`,
    imageUrl: (country, gender) => `faces/grok-imagine-2/${fileName(country)}-${gender}.webp`,
    crop: () => FULL_IMAGE,
    // Requests xAI's moderation rejected on every attempt, by country
    unavailable: { Australia: ['woman'] }
  }
};

// What the picker offers, in display order
export const CHOICES = [
  { id: 'midjourney', label: 'Midjourney 2023', source: 'midjourney', variant: 0 },
  { id: 'grok-woman', label: 'Grok 2026 · woman', source: 'grok', variant: 'woman' },
  { id: 'grok-man', label: 'Grok 2026 · man', source: 'grok', variant: 'man' }
];

export function isAvailable(sourceId, country, variant) {
  return !(SOURCES[sourceId].unavailable[country] || []).includes(variant);
}
