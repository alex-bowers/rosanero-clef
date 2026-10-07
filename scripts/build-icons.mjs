// Renders every app icon and splash screen from design/eagle.svg, each straight from the vector at
// its final pixel size, so nothing is ever scaled up or down after rasterising.
// Run with `pnpm run icons` after changing the eagle, then commit the files in public/icons.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const PAPER = "#fff6f9"; // the app's page background
const OUT = new URL("../public/icons/", import.meta.url);

// The eagle's artwork, without the outer <svg> or the comment. Its viewBox is its bounding box.
const source = readFileSync(new URL("../design/eagle.svg", import.meta.url), "utf8");
const artwork = source.replace(/<!--[\s\S]*?-->/, "").replace(/<\/?svg[^>]*>/g, "").trim();
const [bx, by, bw, bh] = source.match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);

// The eagle scaled so it is `span` px wide, centred on cx, cy.
function eagle({ cx, cy, span }) {
  const k = span / bw;
  return `<g transform="translate(${cx} ${cy}) scale(${k}) translate(${-(bx + bw / 2)} ${-(by + bh / 2)})">${artwork}</g>`;
}

function svg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function png(name, markup) {
  const { width } = markup.match(/width="(?<width>\d+)"/).groups;
  const image = new Resvg(markup, { fitTo: { mode: "width", value: Number(width) } }).render();
  writeFileSync(new URL(name, OUT), image.asPng());
}

// The eagle on a rounded square. Used for the favicon and the "any" manifest icons.
function rounded(size) {
  return svg(size, size, `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${PAPER}"/>` +
    eagle({ cx: size / 2, cy: size / 2, span: size * 0.86 }));
}

// Full-bleed square. The phone crops it to its own shape, so `span` keeps the eagle inside the
// central safe circle (80% of the width) for maskable icons.
function fullBleed(size, span) {
  return svg(size, size, `<rect width="${size}" height="${size}" fill="${PAPER}"/>` +
    eagle({ cx: size / 2, cy: size / 2, span: size * span }));
}

// The eagle across the middle of the screen, a little above centre.
function splash(width, height) {
  return svg(width, height, `<rect width="${width}" height="${height}" fill="${PAPER}"/>` +
    eagle({ cx: width / 2, cy: height * 0.45, span: width * 0.7 }));
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
  png("maskable-192.png", fullBleed(192, 0.72));
  png("maskable-512.png", fullBleed(512, 0.72));
  png("apple-touch-icon.png", fullBleed(180, 0.84));
  for (const [w, h, dpr] of SCREENS) png(splashName(w, h, dpr), splash(w * dpr, h * dpr));

  console.log(`Wrote icons and ${SCREENS.length} splash screens to public/icons`);
}
