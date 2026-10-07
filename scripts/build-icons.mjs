// Renders every app icon and splash screen from design/eagle.svg, each straight from the vector at
// its final pixel size, so nothing is ever scaled up or down after rasterising.
// Run with `pnpm run icons` after changing the eagle, then commit the files in public/icons.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const INK = "#1a1a1e";
const PINK = "#f48fb1";
const OUT = new URL("../public/icons/", import.meta.url);

// The eagle's artwork, without the outer <svg> or the comment. Its bounding box in the 512 grid.
const source = readFileSync(new URL("../design/eagle.svg", import.meta.url), "utf8");
const artwork = source.replace(/<!--[\s\S]*?-->/, "").replace(/<\/?svg[^>]*>/g, "").trim();
const BOX = { x: 24, y: 40, width: 464, height: 390 };

// The eagle in the given colours, scaled so its wider side spans `span` px and centred on cx, cy.
function eagle({ body, eye, cx, cy, span }) {
  const k = span / Math.max(BOX.width, BOX.height);
  const ox = BOX.x + BOX.width / 2;
  const oy = BOX.y + BOX.height / 2;
  const art = artwork.replace(/fill="(#\w+)"/g, (_, fill) => `fill="${fill === INK ? body : eye}"`);
  return `<g transform="translate(${cx} ${cy}) scale(${k}) translate(${-ox} ${-oy})">${art}</g>`;
}

function svg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function png(name, markup) {
  const { width } = markup.match(/width="(?<width>\d+)"/).groups;
  const image = new Resvg(markup, { fitTo: { mode: "width", value: Number(width) } }).render();
  writeFileSync(new URL(name, OUT), image.asPng());
}

// Black eagle on a pink rounded square. Used for the favicon and the "any" manifest icons.
function rounded(size) {
  const r = size * 0.22;
  return svg(size, size, `<rect width="${size}" height="${size}" rx="${r}" fill="${PINK}"/>` +
    eagle({ body: INK, eye: PINK, cx: size / 2, cy: size / 2, span: size * 0.74 }));
}

// Full-bleed pink square. The launcher crops it to its own shape, so the eagle stays inside the
// central safe circle (80% of the width) that every mask keeps.
function fullBleed(size, span) {
  return svg(size, size, `<rect width="${size}" height="${size}" fill="${PINK}"/>` +
    eagle({ body: INK, eye: PINK, cx: size / 2, cy: size / 2, span: size * span }));
}

// Pink eagle on black, the same shade as the app header, a little above the middle.
function splash(width, height) {
  const span = Math.min(width * 0.56, height * 0.3);
  return svg(width, height, `<rect width="${width}" height="${height}" fill="${INK}"/>` +
    eagle({ body: PINK, eye: INK, cx: width / 2, cy: height * 0.44, span }));
}

// iPhone screens in CSS points and their pixel ratio. Safari only shows a startup image whose
// size matches the screen exactly, so each one needs its own file.
export const SCREENS = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [420, 912, 3], // Air
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [430, 932, 3], // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [428, 926, 3], // 12 Pro Max, 13 Pro Max, 14 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [390, 844, 3], // 12, 13, 14, 16e
  [375, 812, 3], // X, XS, 11 Pro, 12 mini, 13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [414, 736, 3], // 6s Plus, 7 Plus, 8 Plus
  [375, 667, 2], // SE (2nd and 3rd gen), 6s, 7, 8
  [320, 568, 2], // SE (1st gen)
];

export const splashName = (w, h, dpr) => `splash-${w * dpr}x${h * dpr}.png`;

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT, { recursive: true });

  const favicon = rounded(512).replace(/ width="512" height="512"/, "");
  writeFileSync(new URL("favicon.svg", OUT), favicon + "\n");
  png("favicon-32.png", rounded(32));
  png("icon-192.png", rounded(192));
  png("icon-512.png", rounded(512));
  png("maskable-192.png", fullBleed(192, 0.6));
  png("maskable-512.png", fullBleed(512, 0.6));
  png("apple-touch-icon.png", fullBleed(180, 0.72));
  for (const [w, h, dpr] of SCREENS) png(splashName(w, h, dpr), splash(w * dpr, h * dpr));

  console.log(`Wrote icons and ${SCREENS.length} splash screens to public/icons`);
}
