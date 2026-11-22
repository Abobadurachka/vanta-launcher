import { app } from 'electron';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractZip } from './archive';
import { downloadFile, fetchJson, mapLimit, safeJoin } from './net';
import { updateProfile } from './store';
import type { LauncherProfile } from './types';

type Progress = (task: string, percent: number, message: string, done?: boolean, error?: boolean) => void;
interface MrpackIndex {
  name?: string;
  versionId?: string;
  dependencies?: { minecraft?: string; 'fabric-loader'?: string; forge?: string; neoforge?: string };
  files?: Array<{ path: string; downloads: string[]; hashes?: { sha1?: string; sha512?: string }; env?: { client?: string; server?: string }; fileSize?: number }>;
}

async function findFiles(root: string, predicate: (name: string, fullPath: string) => boolean, maxDepth = 12) {
  const found: string[] = [];
  async function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && predicate(entry.name, full)) found.push(full);
      else if (entry.isDirectory()) await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

async function findDirs(root: string, dirName: string, maxDepth = 10) {
  const found: string[] = [];
  async function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.toLowerCase() === dirName.toLowerCase()) found.push(full);
      else await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => a.length - b.length);
}

async function copyDirectory(source: string, target: string) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

async function importMrpack(extractRoot: string, profile: LauncherProfile, progress: Progress) {
  const manifestPaths = await findFiles(extractRoot, (name) => name.toLowerCase() === 'modrinth.index.json');
  if (!manifestPaths.length) throw new Error('В архиве не найден modrinth.index.json');
  const manifestPath = manifestPaths.sort((a, b) => a.length - b.length)[0];
  const packRoot = path.dirname(manifestPath);
  const index = JSON.parse(await readFile(manifestPath, 'utf8')) as MrpackIndex;
  const profilePatch: Partial<LauncherProfile> = {};
  if (index.dependencies?.minecraft) profilePatch.minecraftVersion = index.dependencies.minecraft;
  if (index.dependencies?.['fabric-loader']) { profilePatch.loader = 'fabric'; profilePatch.loaderVersion = index.dependencies['fabric-loader']; }
  else if (index.dependencies?.forge) { profilePatch.loader = 'forge'; profilePatch.loaderVersion = index.dependencies.forge; }
  else if (index.dependencies?.neoforge) { profilePatch.loader = 'neoforge'; profilePatch.loaderVersion = index.dependencies.neoforge; }
  if (Object.keys(profilePatch).length) { profilePatch.installed = false; profilePatch.installedVersionId = ''; await updateProfile(profile.id, profilePatch); }

  let complete = 0;
  const clientFiles = (index.files || []).filter((file) => file.env?.client !== 'unsupported');
  await mapLimit(clientFiles, 8, async (file) => {
    if (!file.downloads?.length) return;
    const target = safeJoin(profile.gameDir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    let lastError: unknown;
    for (const url of file.downloads) {
      try {
        await downloadFile(url, target, undefined, file.hashes?.sha1 || file.hashes?.sha512, file.hashes?.sha512 ? 'sha512' : 'sha1');
        lastError = null;
        break;
      } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    complete += 1;
    if (complete % 5 === 0 || complete === clientFiles.length) {
      progress('pack-import', 15 + Math.round((complete / Math.max(1, clientFiles.length)) * 65), `Файлы сборки: ${complete}/${clientFiles.length}`);
    }
  });

  const overrideDirs = ['overrides', 'client-overrides'];
  for (const overrideName of overrideDirs) {
    const source = path.join(packRoot, overrideName);
    try {
      const info = await stat(source);
      if (info.isDirectory()) await copyDirectory(source, profile.gameDir);
    } catch { /* optional directory */ }
  }
  const modsDir = path.join(profile.gameDir, 'mods');
  await mkdir(modsDir, { recursive: true });
  const mods = await readdir(modsDir, { withFileTypes: true });
  const modsInstalled = mods.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).length;
  return { modsInstalled, filesInstalled: complete, packName: index.name || 'Modrinth pack' };
}


interface CurseForgeManifest {
  name?: string;
  minecraft?: { version?: string; modLoaders?: Array<{ id: string; primary?: boolean }> };
  files?: Array<{ projectID: number; fileID: number; required?: boolean }>;
  overrides?: string;
}

async function importCurseForge(extractRoot: string, manifestPath: string, profile: LauncherProfile, progress: Progress, apiKey: string) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CurseForgeManifest;
  const minecraftVersion = manifest.minecraft?.version;
  const selectedLoader = manifest.minecraft?.modLoaders?.find((item) => item.primary) || manifest.minecraft?.modLoaders?.[0];
  let patch: Partial<LauncherProfile> = {};
  if (minecraftVersion) patch.minecraftVersion = minecraftVersion;
  if (selectedLoader?.id) {
    const match = selectedLoader.id.match(/^(forge|fabric|neoforge)-(.+)$/i);
    if (match) {
      patch.loader = match[1].toLowerCase() as LauncherProfile['loader'];
      patch.loaderVersion = match[2];
    }
  }
  if (Object.keys(patch).length) { patch.installed = false; patch.installedVersionId = ''; await updateProfile(profile.id, patch); }

  const overrideName = manifest.overrides || 'overrides';
  const overridePath = path.join(path.dirname(manifestPath), overrideName);
  try {
    const info = await stat(overridePath);
    if (info.isDirectory()) await copyDirectory(overridePath, profile.gameDir);
  } catch { /* optional overrides folder */ }

  const files = (manifest.files || []).filter((file) => file.projectID && file.fileID);
  if (files.length && !apiKey.trim()) {
    throw new Error('Это CurseForge-сборка: для скачивания файлов модов нужен API-ключ CurseForge. Добавь его в Настройки → Интеграции, затем повтори импорт. Overrides уже скопированы в профиль.');
  }
  const modsDir = path.join(profile.gameDir, 'mods');
  await mkdir(modsDir, { recursive: true });
  let downloaded = 0;
  let skipped = 0;
  await mapLimit(files, 4, async (item) => {
    const response = await fetch(`https://api.curseforge.com/v1/mods/${item.projectID}/files/${item.fileID}`, {
      headers: { 'Accept': 'application/json', 'x-api-key': apiKey, 'User-Agent': 'VantaLauncher/1.1' },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`CurseForge API: HTTP ${response.status}. Проверь API-ключ и доступ приложения.`);
    const payload = await response.json() as { data?: { downloadUrl?: string | null; fileName?: string; hashes?: Array<{ algo: number; value: string }> } };
    const data = payload.data;
    if (!data?.downloadUrl || !data.fileName) {
      skipped += 1;
      if (item.required !== false) throw new Error(`CurseForge не вернул ссылку для обязательного файла ${item.fileID}.`);
      return;
    }
    const target = safeJoin(modsDir, path.basename(data.fileName));
    const sha1 = data.hashes?.find((hash) => hash.algo === 1)?.value;
    await downloadFile(data.downloadUrl, target, undefined, sha1, 'sha1', { 'x-api-key': apiKey });
    downloaded += 1;
    if (downloaded % 3 === 0 || downloaded + skipped === files.length) {
      progress('pack-import', 20 + Math.round(((downloaded + skipped) / Math.max(1, files.length)) * 65), `CurseForge моды: ${downloaded}/${files.length}`);
    }
  });
  return { modsInstalled: downloaded, filesInstalled: downloaded, packName: manifest.name || 'CurseForge pack', skippedFiles: skipped };
}

async function importStandardZip(extractRoot: string, profile: LauncherProfile, progress: Progress) {
  const modsDirs = await findDirs(extractRoot, 'mods');
  const gameRoot = modsDirs[0] ? path.dirname(modsDirs[0]) : extractRoot;
  const modsDir = path.join(profile.gameDir, 'mods');
  await mkdir(modsDir, { recursive: true });
  const jarFiles = await findFiles(modsDirs[0] || extractRoot, (name) => name.toLowerCase().endsWith('.jar'));
  if (modsDirs[0]) {
    const rootJars = await findFiles(gameRoot, (name, full) => name.toLowerCase().endsWith('.jar') && path.dirname(full) === gameRoot);
    for (const file of rootJars) if (!jarFiles.includes(file)) jarFiles.push(file);
  }
  if (!jarFiles.length) throw new Error('В архиве не найдено ни одного .jar файла');
  let copied = 0;
  for (const file of jarFiles) {
    const target = path.join(modsDir, path.basename(file));
    await copyFile(file, target);
    copied += 1;
    progress('pack-import', Math.round((copied / jarFiles.length) * 60), `Моды: ${copied}/${jarFiles.length}`);
  }
  for (const folder of ['config', 'shaderpacks', 'resourcepacks']) {
    const candidates = [path.join(gameRoot, folder), path.join(extractRoot, folder)];
    for (const source of candidates) {
      try {
        const info = await stat(source);
        if (info.isDirectory()) {
          await copyDirectory(source, path.join(profile.gameDir, folder));
          break;
        }
      } catch { /* optional folder */ }
    }
  }
  return { modsInstalled: copied, filesInstalled: copied, packName: path.basename(gameRoot) || 'Imported ZIP' };
}

export async function importModpackArchive(zipFile: string, profile: LauncherProfile, progress: Progress, curseForgeApiKey = '') {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nebula-pack-'));
  try {
    progress('pack-import', 1, 'Распаковка архива во временную папку');
    await extractZip(zipFile, tempRoot);
    const manifest = await findFiles(tempRoot, (name) => name.toLowerCase() === 'modrinth.index.json');
    const curseManifest = await findFiles(tempRoot, (name) => name.toLowerCase() === 'manifest.json');
    const result = manifest.length
      ? await importMrpack(tempRoot, profile, progress)
      : curseManifest.length
        ? await importCurseForge(tempRoot, curseManifest.sort((a, b) => a.length - b.length)[0], profile, progress, curseForgeApiKey)
        : await importStandardZip(tempRoot, profile, progress);
    progress('pack-import', 100, `Импорт завершён: ${result.modsInstalled} JAR-модов`, true);
    return result;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
