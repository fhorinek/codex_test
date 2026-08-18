/**
 * Module: Generates PNG PWA icons from simple task-board artwork without external dependencies.
 */

import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(FRONTEND_DIR, "assets");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function setPixel(pixels, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= width) {
    return;
  }
  const offset = ((y * width) + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function fillRoundedRect(pixels, width, x, y, rectWidth, rectHeight, radius, color) {
  const x2 = x + rectWidth;
  const y2 = y + rectHeight;
  for (let py = Math.floor(y); py < Math.ceil(y2); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(x2); px += 1) {
      const nearestX = Math.max(x + radius, Math.min(px, x2 - radius));
      const nearestY = Math.max(y + radius, Math.min(py, y2 - radius));
      const dx = px - nearestX;
      const dy = py - nearestY;
      if ((dx * dx) + (dy * dy) <= radius * radius) {
        setPixel(pixels, width, px, py, color);
      }
    }
  }
}

function drawLine(pixels, width, x1, y1, x2, y2, lineWidth, color) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2;
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = x1 + ((x2 - x1) * t);
    const y = y1 + ((y2 - y1) * t);
    fillRoundedRect(
      pixels,
      width,
      x - (lineWidth / 2),
      y - (lineWidth / 2),
      lineWidth,
      lineWidth,
      lineWidth / 2,
      color
    );
  }
}

function createIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const blue = [47, 84, 235, 255];
  const lightBlue = [143, 164, 255, 255];
  const card = [16, 20, 32, 255];
  const border = [199, 204, 240, 255];

  fillRoundedRect(pixels, size, 0, 0, size, size, size * 0.22, blue);
  fillRoundedRect(pixels, size, size * 0.09, size * 0.09, size * 0.82, size * 0.82, size * 0.18, [245, 247, 255, 255]);
  drawLine(pixels, size, size * 0.31, size * 0.33, size * 0.69, size * 0.45, size * 0.035, lightBlue);
  drawLine(pixels, size, size * 0.27, size * 0.68, size * 0.65, size * 0.56, size * 0.035, border);
  fillRoundedRect(pixels, size, size * 0.18, size * 0.18, size * 0.32, size * 0.22, size * 0.045, card);
  fillRoundedRect(pixels, size, size * 0.5, size * 0.39, size * 0.32, size * 0.22, size * 0.045, card);
  fillRoundedRect(pixels, size, size * 0.18, size * 0.61, size * 0.32, size * 0.22, size * 0.045, card);
  fillRoundedRect(pixels, size, size * 0.2, size * 0.21, size * 0.28, size * 0.035, size * 0.01, lightBlue);
  fillRoundedRect(pixels, size, size * 0.52, size * 0.42, size * 0.28, size * 0.035, size * 0.01, border);
  fillRoundedRect(pixels, size, size * 0.2, size * 0.64, size * 0.28, size * 0.035, size * 0.01, lightBlue);

  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const sourceStart = y * size * 4;
    const targetStart = y * (size * 4 + 1);
    scanlines[targetStart] = 0;
    pixels.copy(scanlines, targetStart + 1, sourceStart, sourceStart + size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

async function main() {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await Promise.all(
    [192, 512].map((size) => fs.writeFile(
      path.join(ASSETS_DIR, `icon-${size}.png`),
      createIcon(size)
    ))
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
