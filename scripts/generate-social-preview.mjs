import { readFile, writeFile } from "node:fs/promises";

const WIDTH = 1280;
const HEIGHT = 640;
const LOGO = new URL("../gui/public/logo.png", import.meta.url);
const ROOT_OUTPUT = new URL("../social-preview.png", import.meta.url);
const SERVED_OUTPUT = new URL("../docs-site/public/social-preview.png", import.meta.url);

let sharp;
try {
  ({ default: sharp } = await import("../docs-site/node_modules/sharp/dist/index.mjs"));
} catch (error) {
  throw new Error(
    "The social-preview generator needs the docs-site dependencies. Run `bun install --frozen-lockfile` in docs-site first.",
    { cause: error },
  );
}

const logo = await readFile(LOGO);
const backdrop = Buffer.from(`
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="surface" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#111318"/>
        <stop offset="0.55" stop-color="#1a1d25"/>
        <stop offset="1" stop-color="#202630"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="45%" r="56%">
        <stop offset="0" stop-color="#a8c7fa" stop-opacity="0.25"/>
        <stop offset="1" stop-color="#a8c7fa" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1280" height="640" fill="url(#surface)"/>
    <rect width="1280" height="640" fill="url(#glow)"/>
    <path d="M0 500 C220 420 340 620 600 520 S980 400 1280 520 V640 H0Z" fill="#a8c7fa" fill-opacity="0.06"/>
    <path d="M0 96 H1280 M0 544 H1280" stroke="#d9e2f2" stroke-opacity="0.10"/>
    <circle cx="640" cy="320" r="224" fill="#0d1117" fill-opacity="0.42" stroke="#a8c7fa" stroke-opacity="0.24" stroke-width="2"/>
  </svg>
`);

const output = await sharp(backdrop)
  .composite([
    {
      input: await sharp(logo).resize(352, 352, { fit: "contain" }).png().toBuffer(),
      left: 464,
      top: 144,
    },
  ])
  .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
  .toBuffer();

await Promise.all([
  writeFile(ROOT_OUTPUT, output),
  writeFile(SERVED_OUTPUT, output),
]);

console.log(`Wrote byte-identical ${WIDTH}x${HEIGHT} social previews (${output.length} bytes).`);
