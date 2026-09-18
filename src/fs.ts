import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const ensureDir = async (path: string) => {
  await mkdir(path, { recursive: true });
};

export const writeText = async (path: string, content: string) => {
  await ensureDir(dirname(path));
  await writeFile(path, content, 'utf8');
};

export const writeJson = async (path: string, value: unknown) => {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const readJson = async <T>(path: string): Promise<T> => {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
};

export const resolveFromCwd = (path: string) => resolve(process.cwd(), path);
