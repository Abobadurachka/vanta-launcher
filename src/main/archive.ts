import yauzl from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { safeJoin } from './net';

export async function extractZip(zipPath: string, destination: string, filter?: (entryName: string) => boolean) {
  await mkdir(destination, { recursive: true });
  return new Promise<number>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError || new Error('Не удалось открыть ZIP'));
      let count = 0;
      let entries = 0;
      let totalUncompressed = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(count);
      });
      zip.on('entry', (entry) => {
        entries += 1;
        totalUncompressed += entry.uncompressedSize;
        if (entries > 60_000 || totalUncompressed > 5 * 1024 ** 3 || entry.uncompressedSize > 1024 ** 3) {
          fail(new Error('Архив слишком большой или содержит слишком много файлов'));
          return;
        }
        const name = entry.fileName.replace(/\\/g, '/');
        if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
          zip.readEntry();
          return;
        }
        const outputPath = safeJoin(destination, name);
        const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixMode === 0o120000) {
          zip.readEntry();
          return;
        }
        if (name.endsWith('/')) {
          mkdir(outputPath, { recursive: true }).then(() => zip.readEntry()).catch(fail);
          return;
        }
        if (filter && !filter(name)) {
          zip.readEntry();
          return;
        }
        mkdir(path.dirname(outputPath), { recursive: true }).then(() => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail(streamError || new Error('Не удалось прочитать запись архива'));
            const target = createWriteStream(outputPath, { flags: 'wx' });
            pipeline(stream, target).then(() => {
              count += 1;
              zip.readEntry();
            }).catch(fail);
          });
        }).catch(fail);
      });
      zip.readEntry();
    });
  });
}
