import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { getUpdateFeedConfig, normalizeUpdateFeedConfig, saveUpdateFeedConfig } from './update-config';
import type { UpdateFeedConfig, UpdateFeedTestResult } from './types';

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
export interface LauncherUpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  percent: number;
  message: string;
  notes: string[];
  feedConfigured: boolean;
  feedProvider: 'github' | 'generic' | null;
  feedName: string | null;
}

let activeFeed: UpdateFeedConfig | null = null;
let initialized = false;
let listenersAttached = false;
let sendState: ((value: LauncherUpdateState) => void) | null = null;
let interval: NodeJS.Timeout | null = null;
let checkInFlight = false;

let state: LauncherUpdateState = {
  status: 'disabled',
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: 0,
  message: 'Канал обновлений ещё не подключён. Настрой GitHub Releases или HTTPS-каталог в панели разработчика.',
  notes: [],
  feedConfigured: false,
  feedProvider: null,
  feedName: null
};

type UpdateInfoLike = { version?: string; releaseNotes?: string | Array<{ note?: string | null }> | null };
function notesFrom(info?: UpdateInfoLike): string[] {
  const value = info?.releaseNotes;
  if (!value) return [];
  const blocks = typeof value === 'string' ? [value] : value.map((entry) => entry?.note ?? '');
  const normalized = blocks
    .flatMap((block) => block.split(/\r?\n/))
    .map((line) => line.trim().replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line) && !/^Дата:/i.test(line) && !/^[-_=]{3,}$/.test(line));
  return [...new Set(normalized)].slice(0, 12);
}
function publish(patch: Partial<LauncherUpdateState>) {
  // package.json is the single source of truth for the installed launcher version.
  state = { ...state, ...patch, currentVersion: app.getVersion() };
  sendState?.({ ...state, notes: [...state.notes] });
}

function feedName(config: UpdateFeedConfig | null): string | null {
  if (!config) return null;
  return config.provider === 'github' ? `${config.owner}/${config.repo}` : new URL(config.url).host;
}

function setUpdaterFeed(config: UpdateFeedConfig) {
  if (config.provider === 'github') {
    autoUpdater.setFeedURL({ provider: 'github', owner: config.owner, repo: config.repo });
  } else {
    autoUpdater.setFeedURL({ provider: 'generic', url: config.url });
  }
}

function attachUpdaterListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = true;
  autoUpdater.channel = 'beta';
  // Setting channel may turn downgrade support on; explicitly keep it off.
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking', message: 'Проверяем наличие новой Pre-Release версии…', percent: 0 }));
  autoUpdater.on('update-available', (info) => {
    const availableVersion = info.version;
    const notes = notesFrom({ version: info.version, releaseNotes: info.releaseNotes });
    publish({
      status: 'available',
      availableVersion,
      percent: 0,
      message: `Доступна новая версия VANTA Launcher ${availableVersion}.`,
      notes
    });
  });
  autoUpdater.on('update-not-available', () => publish({ status: 'not-available', availableVersion: null, message: 'Установлена последняя версия VANTA Launcher.', percent: 0, notes: [] }));
  autoUpdater.on('download-progress', (progress) => publish({ status: 'downloading', percent: Math.round(progress.percent), message: `Загрузка обновления · ${Math.round(progress.percent)}%` }));
  autoUpdater.on('update-downloaded', (info) => {
    const availableVersion = info.version;
    const notes = notesFrom({ version: info.version, releaseNotes: info.releaseNotes });
    publish({ status: 'downloaded', availableVersion, percent: 100, message: `Версия VANTA ${availableVersion} готова к установке.`, notes });
  });
  autoUpdater.on('error', (error) => publish({ status: 'error', message: `Не удалось проверить или загрузить обновление: ${error.message}` }));
}

function applyFeed(config: UpdateFeedConfig | null) {
  activeFeed = config;
  if (config) setUpdaterFeed(config);
  publish({
    feedConfigured: Boolean(config),
    feedProvider: config?.provider ?? null,
    feedName: feedName(config),
    status: config && app.isPackaged ? 'idle' : 'disabled',
    availableVersion: null,
    percent: 0,
    notes: [],
    message: !config
      ? 'Канал обновлений не настроен. Открой панель разработчика и подключи публичный GitHub Releases или HTTPS-каталог.'
      : !app.isPackaged
        ? 'Канал сохранён. Проверка обновлений доступна в установленной Windows-версии.'
        : config.provider === 'github'
          ? `GitHub Releases подключён: ${config.owner}/${config.repo}. Можно проверить Pre-Release.`
          : `HTTPS-канал подключён: ${new URL(config.url).host}. Можно проверить Pre-Release.`
  });
}

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    return await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validate a release source before saving it. GitHub mode expects a public repository;
 * generic mode expects a reachable beta.yml generated by electron-builder.
 */
export async function testUpdateFeed(input: unknown): Promise<UpdateFeedTestResult> {
  const config = normalizeUpdateFeedConfig(input);
  if (config.provider === 'github') {
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases?per_page=20`;
    const response = await fetchWithTimeout(endpoint, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Vanta-Launcher-Updater'
    });
    if (response.status === 404) throw new Error('Репозиторий GitHub не найден или он закрытый. Для обычного лаунчера нужен публичный репозиторий.');
    if (response.status === 403) throw new Error('GitHub ограничил запросы API. Подожди немного и повтори проверку.');
    if (!response.ok) throw new Error(`GitHub API ответил HTTP ${response.status}.`);
    const releases = await response.json() as Array<{ tag_name?: string; prerelease?: boolean; draft?: boolean; assets?: Array<{ name?: string }> }>;
    const release = releases.find((item) => !item.draft && item.prerelease) || releases.find((item) => !item.draft);
    if (!release) {
      return { ok: true, ready: false, message: `Репозиторий ${config.owner}/${config.repo} доступен. Пока нет опубликованных релизов: создай первый Pre-Release через PUBLISH-GITHUB.bat.` };
    }
    const names = (release.assets || []).map((asset) => (asset.name || '').toLowerCase());
    const hasManifest = names.includes('beta.yml') || names.includes('latest.yml');
    const hasInstaller = names.some((name) => name.endsWith('.exe') && name.includes('vanta-launcher-setup'));
    if (!hasManifest || !hasInstaller) {
      const missing = [!hasManifest ? 'beta.yml' : '', !hasInstaller ? 'Vanta-Launcher-Setup-*.exe' : ''].filter(Boolean).join(' и ');
      return { ok: true, ready: false, latestVersion: release.tag_name, message: `Репозиторий найден, последний релиз ${release.tag_name || 'без тега'}, но в его Assets отсутствует ${missing}. Опубликуй сборку через PUBLISH-GITHUB.bat.` };
    }
    return { ok: true, ready: true, latestVersion: release.tag_name, message: `GitHub подключён. Найден релиз ${release.tag_name} с манифестом обновлений и установщиком.` };
  }

  const manifestUrl = new URL('beta.yml', config.url).toString();
  const response = await fetchWithTimeout(manifestUrl, { Accept: 'text/yaml, text/plain, */*', 'User-Agent': 'Vanta-Launcher-Updater' });
  if (!response.ok) throw new Error(`Не удалось получить ${manifestUrl} (HTTP ${response.status}). На сервере должен лежать beta.yml.`);
  const manifest = await response.text();
  if (manifest.length > 1024 * 1024) throw new Error('Файл beta.yml слишком большой или повреждён.');
  const version = manifest.match(/^version:\s*["']?([^\r\n"'#]+)["']?\s*$/m)?.[1]?.trim();
  const hash = manifest.match(/^sha512:\s*["']?([^\r\n"'#]+)["']?\s*$/m)?.[1]?.trim();
  const filePath = manifest.match(/^path:\s*["']?([^\r\n"'#]+)["']?\s*$/m)?.[1]?.trim() || manifest.match(/^\s+-\s+url:\s*["']?([^\r\n"'#]+)["']?\s*$/m)?.[1]?.trim();
  if (!version || !hash || !filePath) throw new Error('beta.yml найден, но в нём нет version, path/url или sha512. Собери релиз командой electron-builder --publish always.');
  return { ok: true, ready: true, latestVersion: version, message: `HTTPS-канал доступен. Найден beta.yml версии ${version}; манифест содержит имя файла и SHA-512.` };
}

export function getUpdateState(): LauncherUpdateState {
  // Never return a stale version cached before a package/build update.
  return { ...state, currentVersion: app.getVersion(), notes: [...state.notes] };
}

export async function initUpdater(onState: (value: LauncherUpdateState) => void) {
  sendState = onState;
  attachUpdaterListeners();
  activeFeed = await getUpdateFeedConfig();
  applyFeed(activeFeed);
  initialized = true;

  if (!app.isPackaged || !activeFeed) return;
  void checkForUpdates();
  interval = setInterval(() => {
    if (!['available', 'downloading', 'downloaded'].includes(state.status)) void checkForUpdates();
  }, 10 * 60 * 1000);
}

/** Save a release source from the authenticated local Developer Console. */
export async function configureUpdateFeed(input: unknown) {
  const saved = await saveUpdateFeedConfig(input);
  applyFeed(saved);
  if (initialized && app.isPackaged) void checkForUpdates();
  return state;
}

export async function checkForUpdates() {
  if (!activeFeed) {
    publish({ status: 'disabled', feedConfigured: false, feedProvider: null, feedName: null, message: 'Автообновление не настроено. Открой панель разработчика и подключи GitHub Releases или HTTPS-каталог.' });
    return state;
  }
  if (!app.isPackaged) {
    publish({ status: 'disabled', feedConfigured: true, feedProvider: activeFeed.provider, feedName: feedName(activeFeed), message: 'Канал настроен. Для фактической проверки запусти установленную Windows-сборку.' });
    return state;
  }
  if (checkInFlight) return state;
  checkInFlight = true;
  publish({ status: 'checking', feedConfigured: true, feedProvider: activeFeed.provider, feedName: feedName(activeFeed), message: 'Связываемся с каналом обновлений…', percent: 0 });
  try {
    setUpdaterFeed(activeFeed);
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publish({ status: 'error', feedConfigured: true, message: `Не удалось проверить канал ${feedName(activeFeed)}: ${error instanceof Error ? error.message : String(error)}` });
  } finally { checkInFlight = false; }
  return state;
}

export async function downloadUpdate() {
  if (state.status !== 'available') throw new Error('Сначала проверь наличие новой версии.');
  await autoUpdater.downloadUpdate();
}

export function installDownloadedUpdate() {
  if (state.status !== 'downloaded') throw new Error('Обновление ещё не скачано.');
  autoUpdater.quitAndInstall(false, true);
}

export function disposeUpdater() {
  if (interval) clearInterval(interval);
  interval = null;
}
