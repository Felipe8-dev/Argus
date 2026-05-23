/**
 * Inject GPS + timestamp EXIF into the "target" photo so the scraper can
 * extract them and reveal where/when the missing person was seen.
 *
 * Usage:
 *   npm run seed
 *
 * Requirements:
 *   - public/photos/<filename>.jpg already exists for each PHOTOS entry
 *   - run AFTER taking/placing the real photos in public/photos/
 */
import fs from 'fs';
import path from 'path';
// piexifjs has no types
// @ts-ignore
import piexif from 'piexifjs';
import { PHOTOS } from '../data/photos';

const PHOTOS_DIR = path.join(process.cwd(), 'public', 'photos');

function toDmsRational(deg: number): number[][] {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = Math.round((minFloat - m) * 60 * 100);
  return [[d, 1], [m, 1], [s, 100]];
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

for (const p of PHOTOS) {
  if (!p.exif || !p.filename) continue;
  const file = path.join(PHOTOS_DIR, p.filename);
  if (!fs.existsSync(file)) {
    console.warn(`[skip] missing file ${file}`);
    continue;
  }

  const jpegData = fs.readFileSync(file).toString('binary');

  const gps: any = {
    [piexif.GPSIFD.GPSLatitudeRef]: p.exif.lat >= 0 ? 'N' : 'S',
    [piexif.GPSIFD.GPSLatitude]: toDmsRational(p.exif.lat),
    [piexif.GPSIFD.GPSLongitudeRef]: p.exif.lon >= 0 ? 'E' : 'W',
    [piexif.GPSIFD.GPSLongitude]: toDmsRational(p.exif.lon),
  };
  const exif: any = {
    [piexif.ExifIFD.DateTimeOriginal]: fmtDate(p.exif.takenAt),
  };

  const exifObj = { '0th': {}, Exif: exif, GPS: gps, '1st': {}, thumbnail: null };
  const exifBytes = piexif.dump(exifObj);
  const newJpeg = piexif.insert(exifBytes, jpegData);

  fs.writeFileSync(file, Buffer.from(newJpeg, 'binary'));
  console.log(`[ok]  injected EXIF into ${p.filename}  (${p.exif.lat}, ${p.exif.lon})`);
}
