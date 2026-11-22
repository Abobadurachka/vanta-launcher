import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createProfile, deleteProfile, getCurseForgeApiKey, hasCurseForgeApiKey, readConfig, selectProfile, setCurseForgeApiKey, setShowSnapshots, updateProfile } from './store';
import { getMinecraftVersions, getLoaderVersions, getRuntimeInfo, installJavaRuntime, installProfile, repairProfile, diagnoseProfile, launchProfile, listInstalledMods, importModFiles, toggleMod, deleteMod } from './minecraft';
import { searchModrinth, getModrinthCategories, installModrinthMod, installModrinthPack, type ModrinthBrowseOptions } from './modrinth';
import { importModpackArchive } from './modpacks';
import { checkForUpdates, configureUpdateFeed, downloadUpdate, getUpdateState, initUpdater, installDownloadedUpdate, disposeUpdater, testUpdateFeed } from './updater';
import type { LauncherProfile, LauncherProgress, UpdateFeedConfig } from './types';
import { getAdminStatus, loginAdmin, logoutAdmin, requireAdmin, setupAdmin } from './admin';
import { getUpdateFeedConfig } from './update-config';
import { addFriendContact, getFriendSettings, normalizeFriendCode, removeFriendContact } from './store';
import { getFriendsState, getPeerForJoin, setManualLanPort, startLanFriendService, stopLanFriendService } from './friends';

// Keep the established Nebula data folder during the Vanta rebrand so existing profiles,
// worlds, mods and configuration remain visible after installing the new product name.
if (process.platform === 'win32') {
  const legacyUserData = path.join(app.getPath('appData'), 'nebula-launcher', 'Nebula Launcher');
  app.setPath('userData', legacyUserData);
}
app.setName('Vanta Launcher');
if (process.platform === 'win32') app.setAppUserModelId('com.nebula.launcher');

let mainWindow: BrowserWindow | null = null;

function emitProgress(progress: LauncherProgress) {
  mainWindow?.webContents.send('launcher:progress', progress);
}
const errorLogPath = () => path.join(app.getPath('userData'), 'NebulaLauncher', 'logs', 'launcher.log');
let logQueue: Promise<void> = Promise.resolve();
function writeLog(level: 'INFO' | 'ERROR', message: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${message.replace(/\r/g, '')}\n`;
  logQueue = logQueue.then(async () => {
    const file = errorLogPath();
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, line, 'utf8');
  }).catch(() => undefined);
}
function progress(task: string, percent: number, message: string, done = false, error = false) {
  writeLog(error ? 'ERROR' : 'INFO', `${task} ${percent}% ${message}`);
  emitProgress({ task, percent, message, done, error });
}
function reportError(error: unknown, context = 'Операция не выполнена'): never {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack || message : message;
  writeLog('ERROR', `${context}:\n${stack}`);
  const firstUsefulLine = message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'Подробности отсутствуют.';
  const shortDetail = firstUsefulLine.length > 320 ? `${firstUsefulLine.slice(0, 317)}…` : firstUsefulLine;
  const messageForUser = `${context}: ${shortDetail}\nПодробный журнал сохранён: ${errorLogPath()}`;
  progress('error', 0, messageForUser, true, true);
  throw new Error(messageForUser);
}

async function findProfile(id: string): Promise<LauncherProfile> {
  const config = await readConfig();
  const profile = config.profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error('Профиль не найден');
  return profile;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    center: true,
    show: false,
    resizable: true,
    maximizable: true,
    backgroundColor: '#080B12',
    title: `Vanta Launcher · ${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  // Electron/Chromium automatically uses the Windows device scale factor (100/125/150%).
  // Keep browser zoom at 100% so CSS layout uses device-independent pixels and vector SVGs
  // remain crisp instead of rasterizing the whole renderer at an artificial scale.
  mainWindow.webContents.setZoomFactor(1);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const loadTask = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  void loadTask.catch((error) => {
    writeLog('ERROR', `Не удалось загрузить окно VANTA: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    mainWindow?.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  createWindow();
  try { await initUpdater((state) => mainWindow?.webContents.send('launcher:update-status', state)); }
  catch (error) { writeLog('ERROR', `Не удалось инициализировать канал обновлений: ${error instanceof Error ? error.stack || error.message : String(error)}`); }
  try { await startLanFriendService((state) => mainWindow?.webContents.send('friends:state', state)); }
  catch (error) { writeLog('ERROR', `Не удалось запустить LAN-обнаружение друзей: ${error instanceof Error ? error.stack || error.message : String(error)}`); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('app:get-state', async () => {
  const config = await readConfig();
  return { profiles: config.profiles, selectedProfileId: config.selectedProfileId, showSnapshots: config.showSnapshots };
});
ipcMain.handle('versions:list', async (_event, snapshots: boolean) => getMinecraftVersions(Boolean(snapshots)));
ipcMain.handle('loaders:list', async (_event, version: string) => getLoaderVersions(version));
ipcMain.handle('runtime:info', async (_event, profileId?: string) => {
  const profile = profileId ? await findProfile(profileId) : undefined;
  return getRuntimeInfo(profile);
});
ipcMain.handle('profile:create', async (_event, input) => createProfile(input));
ipcMain.handle('profile:select', async (_event, id: string) => { const config = await selectProfile(id); return { profiles: config.profiles, selectedProfileId: config.selectedProfileId, showSnapshots: config.showSnapshots }; });
ipcMain.handle('profile:delete', async (_event, id: string) => { const config = await deleteProfile(id); return { profiles: config.profiles, selectedProfileId: config.selectedProfileId, showSnapshots: config.showSnapshots }; });
ipcMain.handle('profile:update', async (_event, id: string, patch) => updateProfile(id, patch));
ipcMain.handle('runtime:install', async (_event, id: string) => {
  try { return await installJavaRuntime(await findProfile(id), progress); } catch (error) { return reportError(error, 'Установка Java'); }
});
ipcMain.handle('profile:install', async (_event, id: string) => {
  try { return await installProfile(await findProfile(id), progress); } catch (error) { return reportError(error, 'Установка игрового профиля'); }
});
ipcMain.handle('profile:repair', async (_event, id: string) => {
  try { return await repairProfile(await findProfile(id), progress); } catch (error) { return reportError(error, 'Починка сборки'); }
});
ipcMain.handle('profile:diagnose', async (_event, id: string) => {
  try { return await diagnoseProfile(await findProfile(id)); } catch (error) { return reportError(error, 'Проверка сборки'); }
});
ipcMain.handle('profile:launch', async (_event, id: string, username: string) => {
  try { return await launchProfile(await findProfile(id), username, progress); } catch (error) { return reportError(error); }
});
ipcMain.handle('friends:get-state', async () => getFriendsState());
ipcMain.handle('friends:add', async (_event, code: string, name: string) => {
  try {
    const added = await addFriendContact(code, name);
    return { added, state: await getFriendsState() };
  } catch (error) { return reportError(error, 'Не удалось добавить друга'); }
});
ipcMain.handle('friends:remove', async (_event, code: string) => {
  try { await removeFriendContact(code); return getFriendsState(); }
  catch (error) { return reportError(error, 'Не удалось удалить друга'); }
});
ipcMain.handle('friends:set-manual-port', async (_event, port: number | null) => {
  try { setManualLanPort(port === null ? null : Number(port)); return getFriendsState(); }
  catch (error) { return reportError(error, 'Не удалось поделиться LAN-миром'); }
});
ipcMain.handle('friends:join', async (_event, profileId: string, friendCode: string, username: string) => {
  try {
    const normalized = normalizeFriendCode(friendCode);
    const settings = await getFriendSettings();
    if (!settings.friends.some((friend) => friend.code === normalized)) throw new Error('Этот код отсутствует в твоём списке друзей.');
    const target = getPeerForJoin(normalized);
    const profile = await findProfile(profileId);
    if (!profile.installed) throw new Error('Сначала установи совместимый профиль Minecraft.');
    if (profile.minecraftVersion !== target.minecraftVersion || profile.loader !== target.loader || (target.loaderVersion || '') !== (profile.loaderVersion || '')) {
      const loaderLabel = target.loader === 'vanilla' ? 'Vanilla' : `${(target.loader || 'unknown').toUpperCase()} ${target.loaderVersion || ''}`.trim();
      throw new Error(`Нужен профиль ${target.minecraftVersion || 'неизвестная версия'} · ${loaderLabel}. Создай или установи точно такую же сборку у себя.`);
    }
    return await launchProfile(profile, username, progress, { host: target.address, port: target.port });
  } catch (error) { return reportError(error, 'Не удалось подключиться к другу'); }
});
ipcMain.handle('mods:list', async (_event, id: string) => listInstalledMods(await findProfile(id)));
ipcMain.handle('mods:import', async (_event, id: string) => {
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: 'Импорт модов (.jar)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Minecraft mods', extensions: ['jar'] }]
  });
  if (selection.canceled || selection.filePaths.length === 0) return [];
  const imported = await importModFiles(await findProfile(id), selection.filePaths);
  progress('mods', 100, `Импортировано модов: ${imported.length}`, true);
  return imported;
});
ipcMain.handle('mods:toggle', async (_event, id: string, file: string, enabled: boolean) => toggleMod(await findProfile(id), file, enabled));
ipcMain.handle('mods:delete', async (_event, id: string, file: string) => deleteMod(await findProfile(id), file));
ipcMain.handle('modrinth:search', async (_event, query: string, type: 'mod' | 'modpack', profileId: string, options: ModrinthBrowseOptions) => searchModrinth(query, type, await findProfile(profileId), options));
ipcMain.handle('modrinth:categories', async (_event, type: 'mod' | 'modpack') => getModrinthCategories(type));
ipcMain.handle('modrinth:open-project', async (_event, type: 'mod' | 'modpack', slug: string) => {
  if (!/^[a-z0-9_-]+$/i.test(slug)) throw new Error('Некорректный идентификатор проекта Modrinth');
  await shell.openExternal(`https://modrinth.com/${type}/${encodeURIComponent(slug)}`);
});
ipcMain.handle('modrinth:install-mod', async (_event, projectId: string, profileId: string) => {
  try { return await installModrinthMod(projectId, await findProfile(profileId), progress); } catch (error) { return reportError(error); }
});
ipcMain.handle('modrinth:install-pack', async (_event, projectId: string, profileId: string) => {
  try { return await installModrinthPack(projectId, await findProfile(profileId), progress); } catch (error) { return reportError(error); }
});
ipcMain.handle('pack:import', async (_event, profileId: string) => {
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: 'Импорт сборки (.zip / .mrpack)',
    properties: ['openFile'],
    filters: [{ name: 'Modpacks', extensions: ['zip', 'mrpack'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return null;
  try { return await importModpackArchive(selection.filePaths[0], await findProfile(profileId), progress, await getCurseForgeApiKey()); }
  catch (error) { return reportError(error); }
});
ipcMain.handle('diagnostics:open-log', async () => {
  const file = errorLogPath();
  await logQueue;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, '', 'utf8');
  const error = await shell.openPath(file);
  if (error) throw new Error(`Не удалось открыть журнал: ${error}. Путь: ${file}`);
  return file;
});
ipcMain.handle('settings:snapshots', async (_event, value: boolean) => { await setShowSnapshots(value); return value; });
ipcMain.handle('settings:curseforge-has-key', async () => hasCurseForgeApiKey());
ipcMain.handle('settings:curseforge-save', async (_event, value: string) => setCurseForgeApiKey(value));
ipcMain.handle('dialog:java', async () => {
  const selection = await dialog.showOpenDialog(mainWindow!, {
    title: 'Выбери Java',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Java runtime', extensions: ['exe'] }] : [{ name: 'Java runtime', extensions: ['*'] }]
  });
  return selection.canceled ? null : selection.filePaths[0] || null;
});

ipcMain.handle('updates:get-state', async () => getUpdateState());
ipcMain.handle('updates:check', async () => checkForUpdates());
ipcMain.handle('updates:download', async () => { try { await downloadUpdate(); return true; } catch (error) { return reportError(error, 'Загрузка обновления'); } });
ipcMain.handle('updates:install', async () => installDownloadedUpdate());
app.on('will-quit', () => { disposeUpdater(); stopLanFriendService(); });


// Developer tools are protected by a local scrypt-hashed credential. The renderer never
// receives the credential file or a method that bypasses requireAdmin().
ipcMain.handle('admin:status', async () => getAdminStatus());
ipcMain.handle('admin:setup', async (_event, username: string, password: string) => setupAdmin(String(username || ''), String(password || '')));
ipcMain.handle('admin:login', async (_event, username: string, password: string) => loginAdmin(String(username || ''), String(password || '')));
ipcMain.handle('admin:logout', async () => { logoutAdmin(); return true; });
ipcMain.handle('admin:update-feed:get', async () => { requireAdmin(); return getUpdateFeedConfig(); });
ipcMain.handle('admin:update-feed:test', async (_event, config: UpdateFeedConfig) => {
  requireAdmin();
  try { return await testUpdateFeed(config); }
  catch (error) { return reportError(error, 'Проверка канала обновлений'); }
});
ipcMain.handle('admin:update-feed:set', async (_event, config: UpdateFeedConfig) => {
  requireAdmin();
  try { return await configureUpdateFeed(config); }
  catch (error) { return reportError(error, 'Настройка канала обновлений'); }
});
ipcMain.handle('admin:overview', async () => {
  requireAdmin();
  const config = await readConfig();
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron || 'unknown',
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    uptimeSeconds: Math.floor(process.uptime()),
    profileCount: config.profiles.length,
    installedProfileCount: config.profiles.filter((profile) => profile.installed).length,
    releaseFeedConfigured: getUpdateState().feedConfigured,
    logPath: errorLogPath()
  };
});
ipcMain.handle('admin:logs', async () => {
  requireAdmin();
  await logQueue;
  try {
    const contents = await readFile(errorLogPath(), 'utf8');
    return contents.split(/\r?\n/).filter(Boolean).slice(-100).join('\n');
  } catch {
    return 'Журнал пока пуст.';
  }
});
ipcMain.handle('admin:open-log', async () => {
  requireAdmin();
  const file = errorLogPath();
  await logQueue;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, '', 'utf8');
  const error = await shell.openPath(file);
  if (error) throw new Error(`Не удалось открыть журнал: ${error}`);
  return true;
});
