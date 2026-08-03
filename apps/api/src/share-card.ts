import { deflateSync } from "node:zlib";

import type { ForecastSnapshot } from "@tibo-radar/contracts";

const WIDTH = 1200;
const HEIGHT = 630;

export function renderShareCard(snapshot: ForecastSnapshot): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  fill(pixels, 0, 0, WIDTH, HEIGHT, [247, 249, 248, 255]);
  fill(pixels, 0, 0, WIDTH, 18, [26, 184, 166, 255]);
  fill(pixels, 72, 78, 14, 116, [249, 91, 82, 255]);
  drawText(pixels, "TIBO RESET RADAR", 116, 86, 10, [18, 30, 35, 255]);
  drawText(pixels, "7 DAY SIGNAL", 118, 174, 5, [77, 91, 96, 255]);

  const values = [
    ["24H", snapshot.cumulative.within24h],
    ["48H", snapshot.cumulative.within48h],
    ["72H", snapshot.cumulative.within72h],
    ["7D", snapshot.cumulative.within168h],
  ] as const;
  values.forEach(([label, value], index) => {
    const x = 78 + index * 277;
    fill(pixels, x, 272, 240, 210, [255, 255, 255, 255]);
    fill(pixels, x, 272, 240, 5, probabilityColor(value));
    drawText(pixels, label, x + 22, 306, 5, [77, 91, 96, 255]);
    drawText(pixels, `${Math.round(value * 100)}%`, x + 22, 374, 9, probabilityColor(value));
  });

  for (let day = 0; day < 7; day += 1) {
    const probability = snapshot.days[day]?.intervalProbability ?? 0;
    fill(
      pixels,
      82 + day * 157,
      540 - Math.round(probability * 125),
      118,
      Math.max(8, Math.round(probability * 125)),
      probabilityColor(probability),
    );
  }
  return encodePng(pixels, WIDTH, HEIGHT);
}

type Color = readonly [number, number, number, number];

function probabilityColor(value: number): Color {
  if (value >= 0.7) return [249, 91, 82, 255];
  if (value >= 0.4) return [243, 172, 55, 255];
  return [26, 184, 166, 255];
}

function fill(buffer: Buffer, x: number, y: number, width: number, height: number, color: Color) {
  for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(WIDTH, x + width); column += 1) {
      const offset = (row * WIDTH + column) * 4;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = color[3];
    }
  }
}

const FONT: Record<string, string[]> = {
  " ": ["000", "000", "000", "000", "000", "000", "000"],
  "%": ["10001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
};

function drawText(buffer: Buffer, text: string, x: number, y: number, scale: number, color: Color) {
  let cursor = x;
  for (const character of text) {
    const glyph = FONT[character] ?? FONT[" "];
    if (!glyph) continue;
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((bit, columnIndex) => {
        if (bit === "1")
          fill(buffer, cursor + columnIndex * scale, y + rowIndex * scale, scale, scale, color);
      });
    });
    cursor += (glyph[0]?.length ?? 3) * scale + scale;
  }
}

function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (width * 4 + 1);
    scanlines[targetOffset] = 0;
    pixels.copy(scanlines, targetOffset + 1, row * width * 4, (row + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
