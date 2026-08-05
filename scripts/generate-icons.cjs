const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SVG_PATH = path.join(__dirname, 'logo-square.svg');
const OUT_DIR = path.join(__dirname, '..', 'src', 'extension');

const sizes = [256, 128, 48, 32, 16];

function stripDisplayP3(svg) {
  // librsvg doesn't support color(display-p3 ...), which causes the style
  // attribute to override the fill attribute with an unparseable value.
  // Remove the style attributes so the hex fill is used directly.
  return svg.replace(/\s*style="[^"]*"/g, '');
}

async function main() {
  const svgRaw = fs.readFileSync(SVG_PATH, 'utf-8');
  const svgFull = stripDisplayP3(svgRaw);

  for (const size of sizes) {
    const outPath = path.join(OUT_DIR, `icon${size}.png`);
    // High density for crisp rasterization before downscale
    await sharp(Buffer.from(svgFull), { density: 600 })
      .resize(size, size, { kernel: 'lanczos3' })
      .png()
      .toFile(outPath);
    console.log(`Generated ${outPath} (${size}x${size})`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
