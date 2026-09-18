import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const temporaryDirectory = () => mkdtemp(join(tmpdir(), 'elle-snapshot-test-'));
export const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export const pngBytes = (width = 16, height = 16, channel = 0) => {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = channel;
    png.data[i + 1] = channel;
    png.data[i + 2] = channel;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
};
export const image = async (dir: string, name: string, channel = 0, width = 16, height = 16) => {
  const path = join(dir, `${name}.png`);
  await writeFile(path, pngBytes(width, height, channel));
  return path;
};
export const cli = (args: string[], cwd = root) => spawnSync('node', [join(root, 'bin/elle-snapshot.js'), ...args], {
  cwd, encoding: 'utf8', timeout: 30_000,
});
