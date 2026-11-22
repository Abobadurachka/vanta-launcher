import { app } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

export type ProgressCallback = (percent: number, message: string) => void;

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
  }
  throw new Error(`Не удалось подключиться к серверу после ${attempts} попыток: ${url}. ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': `VantaLauncher/${app.getVersion()} (desktop launcher)` },
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json() as Promise<T>;
}

export async function downloadFile(url: string, destination: string, onProgress?: ProgressCallback, expectedHash?: string, hashAlgorithm: 'sha1' | 'sha512' = 'sha1', extraHeaders: Record<string, string> = {}) {
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  await rm(partial, { force: true });
  const response = await fetchWithRetry(url, {
    headers: { 'User-Agent': `VantaLauncher/${app.getVersion()} (desktop launcher)`, ...extraHeaders },
    signal: AbortSignal.timeout(180_000),
    redirect: 'follow'
  });
  if (!response.ok || !response.body) throw new Error(`Не удалось скачать файл (${response.status}): ${url}`);
  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;
  const hash = expectedHash ? crypto.createHash(hashAlgorithm) : null;
  const output = createWriteStream(partial);
  try {
    for await (const chunkValue of Readable.fromWeb(response.body as never)) {
      const chunk = Buffer.from(chunkValue as Uint8Array);
      received += chunk.length;
      if (hash) hash.update(chunk);
      if (!output.write(chunk)) await new Promise<void>((resolve, reject) => {
        output.once('drain', resolve);
        output.once('error', reject);
      });
      if (onProgress) onProgress(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0, `${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`);
    }
    await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => error ? reject(error) : resolve()));
    if (hash && expectedHash) {
      const actual = hash.digest('hex').toLowerCase();
      if (actual !== expectedHash.toLowerCase()) throw new Error(`Контрольная сумма не совпала для ${path.basename(destination)}`);
    }
    await rename(partial, destination);
    onProgress?.(100, 'Готово');
  } catch (error) {
    output.destroy();
    await rm(partial, { force: true });
    throw error;
  }
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
  return `${(value / 1024 ** 3).toFixed(2)} ГБ`;
}

export async function mapLimit<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  const count = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }));
}

export function safeJoin(root: string, relative: string) {
  const clean = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, clean);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Недопустимый путь в архиве: ${relative}`);
  }
  return resolved;
}
