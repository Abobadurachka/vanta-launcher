import { app } from 'electron';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, fetchJson, mapLimit } from './net';
import { importModpackArchive } from './modpacks';
import type { LauncherProfile, ModrinthProject, ModrinthCategory } from './types';

type Progress = (task: string, percent: number, message: string, done?: boolean, error?: boolean) => void;
interface SearchResponse { hits: ModrinthProject[]; total_hits: number; }
export interface ModrinthBrowseOptions { offset?: number; sort?: 'relevance' | 'downloads' | 'follows' | 'updated' | 'newest'; category?: string; limit?: number; }
let categoryCache: { expiresAt: number; value: ModrinthCategory[] } | null = null;
interface ModrinthFile { url: string; filename: string; primary?: boolean; hashes?: { sha1?: string; sha512?: string }; }
interface ModrinthVersion { id: string; version_number: string; files: ModrinthFile[]; dependencies?: Array<{ project_id?: string; version_id?: string; dependency_type: string }>; }

const API = 'https://api.modrinth.com/v2';

export async function searchModrinth(
  query: string,
  type: 'mod' | 'modpack',
  profile: LauncherProfile,
  options: ModrinthBrowseOptions = {}
) {
  const facets: string[][] = [[`project_type:${type}`]];
  if (profile.minecraftVersion) facets.push([`versions:${profile.minecraftVersion}`]);
  if (type === 'mod' && profile.loader !== 'vanilla') facets.push([`categories:${profile.loader}`]);
  if (options.category) facets.push([`categories:${options.category}`]);
  const params = new URLSearchParams({
    query: query.trim(),
    facets: JSON.stringify(facets),
    limit: String(Math.min(100, Math.max(1, options.limit || 24))),
    offset: String(Math.max(0, options.offset || 0)),
    index: options.sort || (query.trim() ? 'relevance' : 'downloads')
  });
  return fetchJson<SearchResponse>(`${API}/search?${params.toString()}`);
}

export async function getModrinthCategories(type: 'mod' | 'modpack') {
  if (!categoryCache || categoryCache.expiresAt < Date.now()) {
    const categories = await fetchJson<ModrinthCategory[]>(`${API}/tag/category`);
    categoryCache = { expiresAt: Date.now() + 60 * 60 * 1000, value: categories };
  }
  return categoryCache.value
    .filter((item) => !item.project_type || item.project_type === type)
    .filter((item) => Boolean(item.name))
    .sort((a, b) => (a.header || '').localeCompare(b.header || '') || a.name.localeCompare(b.name))
    .map(({ name, header, icon }) => ({ name, header, icon }));
}

async function getProjectVersions(projectId: string, profile: LauncherProfile) {
  const params = new URLSearchParams();
  params.set('game_versions', JSON.stringify([profile.minecraftVersion]));
  if (profile.loader !== 'vanilla') params.set('loaders', JSON.stringify([profile.loader]));
  return fetchJson<ModrinthVersion[]>(`${API}/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);
}

async function installModVersion(projectId: string, profile: LauncherProfile, progress: Progress, visited = new Set<string>()) {
  if (visited.has(projectId)) return 0;
  visited.add(projectId);
  const versions = await getProjectVersions(projectId, profile);
  const version = versions[0];
  if (!version) throw new Error(`Нет совместимой версии мода ${projectId} для ${profile.minecraftVersion}`);
  let installed = 0;
  for (const dependency of version.dependencies || []) {
    if (dependency.dependency_type !== 'required' || !dependency.project_id) continue;
    installed += await installModVersion(dependency.project_id, profile, progress, visited);
  }
  const file = version.files.find((entry) => entry.primary) || version.files[0];
  if (!file || !file.filename.toLowerCase().endsWith('.jar')) throw new Error('У выбранной версии нет JAR-файла для установки');
  const modsDir = path.join(profile.gameDir, 'mods');
  await mkdir(modsDir, { recursive: true });
  const target = path.join(modsDir, path.basename(file.filename));
  progress('modrinth', 15, `Скачивание ${file.filename}`);
  await downloadFile(file.url, target, (pct, msg) => progress('modrinth', pct, `${file.filename}: ${msg}`), file.hashes?.sha1);
  return installed + 1;
}

export async function installModrinthMod(projectId: string, profile: LauncherProfile, progress: Progress) {
  const count = await installModVersion(projectId, profile, progress);
  progress('modrinth', 100, `Установлено модов: ${count}`, true);
  return count;
}

export async function installModrinthPack(projectId: string, profile: LauncherProfile, progress: Progress) {
  const versions = await getProjectVersions(projectId, profile);
  const version = versions[0];
  if (!version) throw new Error('Для этой сборки нет совместимой версии');
  const file = version.files.find((entry) => entry.primary) || version.files[0];
  if (!file || !/\.(mrpack|zip)$/i.test(file.filename)) throw new Error('Modrinth не вернул файл .mrpack/.zip');
  const tempFile = path.join(app.getPath('temp'), `nebula-modpack-${Date.now()}-${path.basename(file.filename)}`);
  await mkdir(path.dirname(tempFile), { recursive: true });
  try {
    await downloadFile(file.url, tempFile, (pct, msg) => progress('pack', Math.round(pct * 0.2), `Загрузка сборки: ${msg}`), file.hashes?.sha1);
    const result = await importModpackArchive(tempFile, profile, progress);
    progress('pack', 100, `Сборка установлена · ${result.modsInstalled} модов`, true);
    return result;
  } finally {
    await rm(tempFile, { force: true });
  }
}
