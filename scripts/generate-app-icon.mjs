import { deflateSync, inflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "gui/public/logo.png");
const PNG_OUTPUT = resolve(ROOT, "gui/public/opencodex.png");
const ICO_OUTPUT = resolve(ROOT, "gui/public/opencodex.ico");
const SERVED_ICO_OUTPUT = resolve(ROOT, "docs-site/public/opencodex.ico");
const SOURCE_LABEL = "gui/public/logo.png";
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BACKGROUND = [21, 27, 46];

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function decodeRgbaPng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${SOURCE_LABEL} is not a PNG`);
  let position = 8;
  let width;
  let height;
  const compressed = [];
  while (position < bytes.length) {
    const length = bytes.readUInt32BE(position);
    const type = bytes.toString("ascii", position + 4, position + 8);
    const data = bytes.subarray(position + 8, position + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error(`${SOURCE_LABEL} must be a non-interlaced 8-bit RGBA PNG`);
      }
    } else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") break;
    position += length + 12;
  }
  if (!width || !height || compressed.length === 0) throw new Error(`${SOURCE_LABEL} is missing PNG image data`);

  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error(`${SOURCE_LABEL} has an unexpected decoded length`);
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const prediction = a + b - c;
    const pa = Math.abs(prediction - a);
    const pb = Math.abs(prediction - b);
    const pc = Math.abs(prediction - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const encoded = raw[y * (stride + 1) + x + 1];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      const predictor =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >>> 1 : filter === 4 ? paeth(left, above, upperLeft) : -1;
      if (predictor < 0) throw new Error(`${SOURCE_LABEL} uses unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = (encoded + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

function compositeMark({ width, height, pixels }) {
  const output = Buffer.alloc(pixels.length);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    const inverse = 255 - alpha;
    output[offset] = Math.round((pixels[offset] * alpha + BACKGROUND[0] * inverse) / 255);
    output[offset + 1] = Math.round((pixels[offset + 1] * alpha + BACKGROUND[1] * inverse) / 255);
    output[offset + 2] = Math.round((pixels[offset + 2] * alpha + BACKGROUND[2] * inverse) / 255);
    output[offset + 3] = 255;
  }
  return { width, height, pixels: output };
}

function resizeBox(source, size) {
  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const top = Math.floor((y * source.height) / size);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * source.height) / size));
    for (let x = 0; x < size; x += 1) {
      const left = Math.floor((x * source.width) / size);
      const right = Math.max(left + 1, Math.floor(((x + 1) * source.width) / size));
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const input = (sy * source.width + sx) * 4;
          for (let channel = 0; channel < 4; channel += 1) sums[channel] += source.pixels[input + channel];
          count += 1;
        }
      }
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) output[target + channel] = Math.round(sums[channel] / count);
    }
  }
  return { width: size, height: size, pixels: output };
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const source = compositeMark(decodeRgbaPng(readFileSync(SOURCE)));
if (source.width !== 512 || source.height !== 512) throw new Error(`${SOURCE_LABEL} must remain the committed 512x512 master mark`);
const png = encodePng(source);
const ico = encodeIco(ICON_SIZES.map((size) => ({ size, png: encodePng(resizeBox(source, size)) })));
writeFileSync(PNG_OUTPUT, png);
writeFileSync(ICO_OUTPUT, ico);
writeFileSync(SERVED_ICO_OUTPUT, ico);
console.log(
  `Generated gui/public/opencodex.png (512x512), gui/public/opencodex.ico and docs-site/public/opencodex.ico (${ICON_SIZES.join(", ")}) from ${SOURCE_LABEL}`,
);
