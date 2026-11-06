// Lager små JPEG-er til testen (med sharp fra app/node_modules).
import { createRequire } from 'node:module';
const [appDir, outDir] = process.argv.slice(2);
const sharp = createRequire(appDir + '/')('sharp');
const svg = (w, h, a, b, label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" font-size="${Math.round(h / 8)}" fill="white" text-anchor="middle" font-family="Helvetica">${label}</text></svg>`);
await sharp(svg(1200, 800, '#1d4e89', '#f2c14e', 'ROTERT')).jpeg({ quality: 80 }).withMetadata({ orientation: 6 }).toFile(`${outDir}/rotert-orientation6.jpg`);
await sharp(svg(800, 1200, '#5b1a2c', '#ff6b5e', 'Lite')).jpeg({ quality: 80 })
  .withExifMerge({ IFD0: { Make: 'NIKON CORPORATION', Model: 'NIKON Z 8' }, IFD2: { DateTimeOriginal: '2026:10:07 14:30:05' } })
  .toFile(`${outDir}/lite-med-exif.jpg`);

// En liten video (H.264 + AAC, 2 sekunder) – som Lightroom eksporterer den.
import { execFileSync } from 'node:child_process';
execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330',
  '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', `${outDir}/klipp.mp4`]);
