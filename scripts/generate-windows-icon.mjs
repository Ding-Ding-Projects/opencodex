/**
 * Generate the Windows app icon from the committed original mark.
 *
 * This is intentionally self-contained: the build machine does not need an
 * image toolkit, a network fetch, or a framework default.  The source is a
 * real RGBA PNG, each ICO entry is a real PNG with its own dimensions, and the
 * `--check` mode proves the committed copies are deterministic and identical.
 */

import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "assets", "logo-dark.png");
export const ICON_DIGEST = "1823ce3c34bea1857fc42f0fafcaa8a93618a071a1c66acaee4e300d63f25b18";
const OUTPUTS = [
  join(ROOT, "assets", `opencodex-${ICON_DIGEST}.ico`),
  join(ROOT, "docs-site", "public", "assets", `opencodex-${ICON_DIGEST}.ico`),
];
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const payload = Buffer.concat([name, data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  payload.copy(out, 4);
  out.writeUInt32BE(crc32(payload), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("source is not a PNG");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error("only non-interlaced 8-bit RGBA PNGs are supported");
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  let cursor = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++];
    const row = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + up) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upperLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    }
    row.copy(pixels, y * stride);
    previous = row;
  }
  return { width, height, pixels };
}

function resize(source, size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * source.height / size);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * source.height / size));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * source.width / size);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * source.width / size));
      let alphaTotal = 0;
      let redTotal = 0;
      let greenTotal = 0;
      let blueTotal = 0;
      let samples = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * source.width + sx) * 4;
          const alpha = source.pixels[i + 3];
          alphaTotal += alpha;
          redTotal += source.pixels[i] * alpha;
          greenTotal += source.pixels[i + 1] * alpha;
          blueTotal += source.pixels[i + 2] * alpha;
          samples += 1;
        }
      }
      const out = (y * size + x) * 4;
      const alpha = Math.round(alphaTotal / samples);
      pixels[out] = alpha ? Math.round(redTotal / alphaTotal) : 0;
      pixels[out + 1] = alpha ? Math.round(greenTotal / alphaTotal) : 0;
      pixels[out + 2] = alpha ? Math.round(blueTotal / alphaTotal) : 0;
      pixels[out + 3] = alpha;
    }
  }
  return pixels;
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}

function encodeIco(source) {
  const images = SIZES.map(size => ({ size, png: encodePng(size, resize(source, size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  for (let i = 0; i < images.length; i += 1) {
    const { size, png } = images[i];
    const row = i * 16;
    directory[row] = size === 256 ? 0 : size;
    directory[row + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, row + 4);
    directory.writeUInt16LE(32, row + 6);
    directory.writeUInt32LE(png.length, row + 8);
    directory.writeUInt32LE(offset, row + 12);
    offset += png.length;
  }
  return Buffer.concat([header, directory, ...images.map(image => image.png)]);
}

function validateIco(bytes) {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) throw new Error("ICO header is invalid");
  const count = bytes.readUInt16LE(4);
  if (count !== SIZES.length) throw new Error(`ICO contains ${count} images, expected ${SIZES.length}`);
  for (let i = 0; i < count; i += 1) {
    const row = 6 + i * 16;
    const width = bytes[row] || 256;
    const height = bytes[row + 1] || 256;
    const size = bytes.readUInt32LE(row + 8);
    const offset = bytes.readUInt32LE(row + 12);
    if (width !== SIZES[i] || height !== SIZES[i]) throw new Error(`ICO entry ${i} has ${width}x${height}`);
    const decoded = decodePng(bytes.subarray(offset, offset + size));
    if (decoded.width !== width || decoded.height !== height) throw new Error(`ICO entry ${i} PNG dimensions do not round-trip`);
    if (![...decoded.pixels].some((value, index) => index % 4 === 3 && value < 255)) throw new Error(`ICO entry ${i} lost alpha`);
  }
}

export function generateWindowsIcon(sourceBytes = readFileSync(SOURCE)) {
  const source = decodePng(sourceBytes);
  const output = encodeIco(source);
  validateIco(output);
  const digest = createHash("sha256").update(output).digest("hex");
  if (digest !== ICON_DIGEST) throw new Error(`generated icon digest ${digest} does not match content-addressed filename ${ICON_DIGEST}`);
  return output;
}

function main() {
  const output = generateWindowsIcon();
  if (process.argv.includes("--check")) {
    for (const path of OUTPUTS) {
      const existing = readFileSync(path);
      if (!existing.equals(output)) throw new Error(`${path} is stale; run node scripts/generate-windows-icon.mjs`);
    }
    console.log(`Windows icon is current: ${OUTPUTS.join(", ")}`);
  } else {
    for (const path of OUTPUTS) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, output);
    }
    console.log(`Wrote deterministic Windows icon to ${OUTPUTS.join(", ")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
