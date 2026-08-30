// One-off generator for the trailhead wordmark used as the logo on the docs
// OG cards (#116). Renders "trail" (cream) + "head" (orange) with the same
// vendored Noto Sans Bold the cards use, via canvaskit (astro-og-canvas's own
// engine), so the mark is fully hermetic (no fontconfig / no network) and
// matches the card typography. Output: src/assets/trailhead-wordmark.png
// (transparent background). Re-run with `node scripts/gen-og-wordmark.mjs`
// only when the wordmark needs regenerating; the PNG is committed.
import CanvasKitInit from 'canvaskit-wasm';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.dirname(here);

const ck = await CanvasKitInit({
  locateFile: (f) => path.join(siteRoot, 'node_modules/canvaskit-wasm/bin', f),
});

const fontData = readFileSync(
  path.join(siteRoot, 'src/assets/fonts/noto-sans-latin-700-normal.ttf'),
);
const fontMgr = ck.FontMgr.FromData(fontData);

const SIZE = 96; // px, matches the landing wordmark proportions
const CREAM = ck.Color(242, 239, 232); // #f2efe8
const ORANGE = ck.Color(243, 132, 79); // #f3844f

const makeStyle = (color) =>
  new ck.TextStyle({
    color,
    fontFamilies: ['Noto Sans'],
    fontSize: SIZE,
    letterSpacing: -SIZE * 0.02, // -0.02em, contiguous wordmark
    fontStyle: { weight: ck.FontWeight.Bold },
  });

function buildParagraph() {
  const paraStyle = new ck.ParagraphStyle({
    textStyle: makeStyle(CREAM),
    textAlign: ck.TextAlign.Left,
  });
  const b = ck.ParagraphBuilder.Make(paraStyle, fontMgr);
  b.pushStyle(makeStyle(CREAM));
  b.addText('trail');
  b.pop();
  b.pushStyle(makeStyle(ORANGE));
  b.addText('head');
  b.pop();
  const p = b.build();
  p.layout(2000);
  return p;
}

// Measure, then render on a tightly-sized transparent surface.
const measured = buildParagraph();
const W = Math.ceil(measured.getMaxIntrinsicWidth()) + 6;
const H = Math.ceil(measured.getHeight()) + 6;

const surface = ck.MakeSurface(W, H);
const canvas = surface.getCanvas();
const para = buildParagraph();
para.layout(W);
canvas.drawParagraph(para, 3, 3);
surface.flush();

const img = surface.makeImageSnapshot();
const png = img.encodeToBytes(ck.ImageFormat.PNG, 100);
if (!png) throw new Error('wordmark PNG encode failed');

const out = path.join(siteRoot, 'src/assets/trailhead-wordmark.png');
writeFileSync(out, Buffer.from(png));
console.log(`wordmark written: ${out} (${W}x${H})`);
