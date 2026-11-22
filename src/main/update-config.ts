import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateFeedConfig } from './types';

export const UPDATE_CHANNEL = 'latest' as const;

const configFile = () => path.join(app.getPath('userData'), 'NebulaLauncher', 'update-feed.json');

function normalizeGenericUrl(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Укажи HTTPS-адрес каталога обновлений.');
  if (raw.length > 2048) throw new Error('Адрес канала обновлений слишком длинный.');
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error('Укажи полный HTTPS-адрес, например https://updates.example.net/vanta/windows/x64/.'); }
  if (parsed.protocol !== 'https:') throw new Error('Канал обновлений должен использовать HTTPS.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Адрес канала не должен содержать логин, пароль, query-параметры или fragment.');
  if (!parsed.hostname || parsed.hostname === 'example.com' || parsed.hostname.endsWith('.example.com') || parsed.hostname === 'example.org' || parsed.hostname.endsWith('.example.org')) {
    throw new Error('Замени демонстрационный домен на собственный HTTPS-сервер релизов.');
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function normalizeGitHub(owner: string, repo: string): UpdateFeedConfig {
  const cleanOwner = String(owner ?? '').trim();
  const cleanRepo = String(repo ?? '').trim().replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(cleanOwner)) throw new Error('Некорректный GitHub owner.');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(cleanRepo)) throw new Error('Некорректное имя GitHub-репозитория.');
  return { provider: 'github', owner: cleanOwner, repo: cleanRepo };
}

export function normalizeUpdateFeedConfig(input: unknown): UpdateFeedConfig {
  if (!input || typeof input !== 'object') throw new Error('Укажи тип и адрес канала обновлений.');
  const value = input as Record<string, unknown>;
  if (value.provider === 'generic') return { provider: 'generic', url: normalizeGenericUrl(String(value.url ?? '')) };
  if (value.provider === 'github') {
    let owner = String(value.owner ?? '').trim();
    let repo = String(value.repo ?? '').trim();
    const repositoryUrl = String(value.repository ?? '').trim();
    if (repositoryUrl) {
      const match = repositoryUrl.match(/^(?:https:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?$/i);
      if (!match) throw new Error('Введи ссылку вида https://github.com/owner/repository или owner/repository.');
      owner = match[1]; repo = match[2];
    } else if (!repo && owner.includes('/')) {
      const parts = owner.split('/');
      if (parts.length === 2) { owner = parts[0]; repo = parts[1]; }
    }
    return normalizeGitHub(owner, repo);
  }
  throw new Error('Неизвестный тип канала обновлений.');
}

function fromEnvironment(): UpdateFeedConfig | null {
  const githubRepo = (process.env.VANTA_GITHUB_REPOSITORY || '').trim();
  if (githubRepo) {
    const parts = githubRepo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').split('/');
    if (parts.length === 2) return normalizeGitHub(parts[0], parts[1]);
  }
  const genericUrl = (process.env.VANTA_UPDATE_FEED_URL || '').trim();
  if (genericUrl) return { provider: 'generic', url: normalizeGenericUrl(genericUrl) };
  return null;
}

async function fromPackagedUpdateConfig(): Promise<UpdateFeedConfig | null> {
  if (!app.isPackaged) return null;
  const manifestPath = path.join(process.resourcesPath, 'app-update.yml');
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  // electron-builder writes a flat app-update.yml for its GitHub / generic provider.
  // Read only the scalar keys needed by VANTA; updater itself verifies the manifest.
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }

  if (values.channel && values.channel !== UPDATE_CHANNEL) return null;

  if (values.provider === 'github' && values.owner && values.repo) {
    return normalizeUpdateFeedConfig({ provider: 'github', owner: values.owner, repo: values.repo });
  }
  if (values.provider === 'generic' && values.url) {
    return normalizeUpdateFeedConfig({ provider: 'generic', url: values.url });
  }
  return null;
}

export async function getUpdateFeedConfig(): Promise<UpdateFeedConfig | null> {
  try {
    const saved = JSON.parse(await readFile(configFile(), 'utf8')) as Record<string, unknown>;
    // Migrate a previously saved { url } configuration without losing it; the endpoint now serves latest.yml.
    const candidate = saved.config ?? (typeof saved.url === 'string' && saved.url ? { provider: 'generic', url: saved.url } : null);
    if (candidate) return normalizeUpdateFeedConfig(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return fromEnvironment() ?? await fromPackagedUpdateConfig();
}

export async function saveUpdateFeedConfig(input: unknown): Promise<UpdateFeedConfig> {
  const normalized = normalizeUpdateFeedConfig(input);
  const file = configFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ config: normalized, updatedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
  return normalized;
}
