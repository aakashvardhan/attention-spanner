/**
 * Stitches the raw scene clips recorded by demo/record.mjs into the final
 * LinkedIn-ready MP4 (1920x1080, 30fps, H.264 + silent AAC).
 *
 * Reads demo/out/manifest.json; each scene lists [in, out] sub-segments of
 * its webm to keep. Popup clips (scene.popup) are cropped to their content
 * and zoomed for legibility. Optional per-scene `crop: [w, h, x, y]`.
 *
 *   node demo/stitch.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';

const DEMO = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DEMO, 'out');
const RAW = path.join(OUT, 'raw');
const PARTS = path.join(OUT, 'parts');
const FINAL = path.join(OUT, 'reader-demo-90s.mp4');
const BG = '0x0b0d12';

const run = (args) => execFileSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

function probe(file) {
  // ffmpeg-static has no ffprobe; parse stream line from ffmpeg stderr
  try {
    execFileSync(ffmpeg, ['-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const m = String(e.stderr).match(/Video:.* (\d{2,5})x(\d{2,5})/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  throw new Error(`cannot probe ${file}`);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  fs.rmSync(PARTS, { recursive: true, force: true });
  fs.mkdirSync(PARTS, { recursive: true });

  const partFiles = [];
  let index = 0;

  for (const scene of manifest.scenes) {
    const src = path.join(RAW, scene.file);
    const { width, height } = probe(src);

    for (const [start, end] of scene.segments) {
      const part = path.join(PARTS, `part-${String(index).padStart(2, '0')}-${scene.name}.mp4`);
      const filters = [];

      if (scene.crop) {
        const [w, h, x, y] = scene.crop;
        filters.push(`crop=${w}:${h}:${x}:${y}`);
      } else if (scene.popup) {
        // Popup clips are small; if letterboxed inside a big frame, crop the
        // centered content region first (content size stored by record.mjs
        // or assumed equal to the popup viewport).
        const [w, h] = scene.contentSize ?? [440, 180];
        if (width > w) filters.push(`crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2`);
        // Zoom small clips up to ~3x for legibility, then pad onto the frame
        filters.push(`scale=${Math.min(1920, w * 3)}:-2:flags=lanczos`);
      }

      filters.push(
        'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos',
        `pad=1920:1080:-1:-1:color=${BG}`,
        'fps=30',
        'format=yuv420p',
      );

      run([
        '-y',
        '-i', src,
        '-ss', String(start),
        '-to', String(end),
        '-vf', filters.join(','),
        '-an',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
        part,
      ]);
      partFiles.push(part);
      console.log(`[stitch] ${path.basename(part)}  (${start.toFixed(2)}–${end.toFixed(2)}s of ${scene.file})`);
      index += 1;
    }
  }

  const listFile = path.join(PARTS, 'concat.txt');
  fs.writeFileSync(listFile, partFiles.map((f) => `file '${f}'`).join('\n'));

  // Concat + silent stereo track (some platforms mis-handle audio-less video)
  run([
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-shortest',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    FINAL,
  ]);

  console.log(`[stitch] final video → ${FINAL}`);
}

main();
