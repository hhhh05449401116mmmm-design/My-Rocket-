const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const root = process.cwd();
const assets = path.join(root, 'assets');
const videos = [
  ['ADJtCAFOdpAFHHbg.MP4', 'ADJtCAFOdpAFHHbg.silent.mp4'],
  ['WddYFBEPUHJZYMlo.MP4', 'WddYFBEPUHJZYMlo.silent.mp4'],
  ['IlLXxhvJRWznUUZY.MP4', 'IlLXxhvJRWznUUZY.silent.mp4']
];

for (const [inputName, outputName] of videos) {
  const input = path.join(assets, inputName);
  const output = path.join(assets, outputName);
  if (!fs.existsSync(input)) continue;
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(input).mtimeMs) continue;

  const args = [
    '-y', '-i', input,
    '-vf', 'scale=1280:-2:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '24',
    '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart', output
  ];

  const result = spawnSync(ffmpeg, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
