import { contextBridge, ipcRenderer } from 'electron';
import type { CreateProfileInput, DeveloperAdminOverview, DeveloperAdminStatus, FriendsState, LauncherProgress, LauncherProfile, LoaderType, ModrinthCategory, ModrinthProject, RuntimeInfo, UpdateFeedConfig, UpdateFeedTestResult, VersionItem } from './types';
import type { LauncherUpdateState } from './updater';
import type { ModrinthBrowseOptions } from './modrinth';

const api = {
  getState: () => ipcRenderer.invoke('app:get-state'),
  getVersions: (snapshots: boolean) => ipcRenderer.invoke('versions:list', snapshots) as Promise<VersionItem[]>,
  getLoaderVersions: (version: string) => ipcRenderer.invoke('loaders:list', version),
  getRuntimeInfo: (profileId?: string) => ipcRenderer.invoke('runtime:info', profileId),
  createProfile: (input: CreateProfileInput) => ipcRenderer.invoke('profile:create', input) as Promise<LauncherProfile>,
  selectProfile: (id: string) => ipcRenderer.invoke('profile:select', id),
  deleteProfile: (id: string) => ipcRenderer.invoke('profile:delete', id),
  updateProfile: (id: string, patch: Partial<LauncherProfile>) => ipcRenderer.invoke('profile:update', id, patch) as Promise<LauncherProfile>,
  installProfile: (id: string) => ipcRenderer.invoke('profile:install', id),
  repairProfile: (id: string) => ipcRenderer.invoke('profile:repair', id),
  diagnoseProfile: (id: string) => ipcRenderer.invoke('profile:diagnose', id),
  installJavaRuntime: (id: string) => ipcRenderer.invoke('runtime:install', id),
  launchProfile: (id: string, username: string) => ipcRenderer.invoke('profile:launch', id, username),
  getFriendsState: () => ipcRenderer.invoke('friends:get-state') as Promise<FriendsState>,
  addFriend: (code: string, name: string) => ipcRenderer.invoke('friends:add', code, name) as Promise<{ added: { code: string; name: string; addedAt: number }; state: FriendsState }>,
  removeFriend: (code: string) => ipcRenderer.invoke('friends:remove', code) as Promise<FriendsState>,
  setManualLanPort: (port: number | null) => ipcRenderer.invoke('friends:set-manual-port', port) as Promise<FriendsState>,
  joinFriend: (profileId: string, code: string, username: string) => ipcRenderer.invoke('friends:join', profileId, code, username),
  onFriendsState: (callback: (state: FriendsState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: FriendsState) => callback(state);
    ipcRenderer.on('friends:state', listener);
    return () => ipcRenderer.removeListener('friends:state', listener);
  },
  listMods: (id: string) => ipcRenderer.invoke('mods:list', id),
  importMods: (id: string) => ipcRenderer.invoke('mods:import', id),
  toggleMod: (id: string, file: string, enabled: boolean) => ipcRenderer.invoke('mods:toggle', id, file, enabled),
  deleteMod: (id: string, file: string) => ipcRenderer.invoke('mods:delete', id, file),
  searchModrinth: (query: string, type: 'mod' | 'modpack', profileId: string, options: ModrinthBrowseOptions) => ipcRenderer.invoke('modrinth:search', query, type, profileId, options) as Promise<{ hits: ModrinthProject[]; total_hits: number }>,
  getModrinthCategories: (type: 'mod' | 'modpack') => ipcRenderer.invoke('modrinth:categories', type) as Promise<ModrinthCategory[]>,
  openModrinthProject: (type: 'mod' | 'modpack', slug: string) => ipcRenderer.invoke('modrinth:open-project', type, slug),
  getUpdateState: () => ipcRenderer.invoke('updates:get-state') as Promise<LauncherUpdateState>,
  checkUpdates: () => ipcRenderer.invoke('updates:check') as Promise<LauncherUpdateState>,
  downloadUpdate: () => ipcRenderer.invoke('updates:download') as Promise<boolean>,
  installUpdate: () => ipcRenderer.invoke('updates:install') as Promise<void>,
  onUpdateStatus: (callback: (state: LauncherUpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: LauncherUpdateState) => callback(state);
    ipcRenderer.on('launcher:update-status', listener);
    return () => ipcRenderer.removeListener('launcher:update-status', listener);
  },
  installModrinthMod: (projectId: string, profileId: string) => ipcRenderer.invoke('modrinth:install-mod', projectId, profileId),
  installModrinthPack: (projectId: string, profileId: string) => ipcRenderer.invoke('modrinth:install-pack', projectId, profileId),
  importPack: (profileId: string) => ipcRenderer.invoke('pack:import', profileId),
  setShowSnapshots: (value: boolean) => ipcRenderer.invoke('settings:snapshots', value),
  hasCurseForgeApiKey: () => ipcRenderer.invoke('settings:curseforge-has-key') as Promise<boolean>,
  setCurseForgeApiKey: (value: string) => ipcRenderer.invoke('settings:curseforge-save', value),
  chooseJava: () => ipcRenderer.invoke('dialog:java'),
  openErrorLog: () => ipcRenderer.invoke('diagnostics:open-log') as Promise<string>,
  adminStatus: () => ipcRenderer.invoke('admin:status') as Promise<DeveloperAdminStatus>,
  adminSetup: (username: string, password: string) => ipcRenderer.invoke('admin:setup', username, password),
  adminLogin: (username: string, password: string) => ipcRenderer.invoke('admin:login', username, password),
  adminLogout: () => ipcRenderer.invoke('admin:logout') as Promise<boolean>,
  adminUpdateFeed: () => ipcRenderer.invoke('admin:update-feed:get') as Promise<UpdateFeedConfig | null>,
  adminTestUpdateFeed: (config: UpdateFeedConfig) => ipcRenderer.invoke('admin:update-feed:test', config) as Promise<UpdateFeedTestResult>,
  adminSetUpdateFeed: (config: UpdateFeedConfig) => ipcRenderer.invoke('admin:update-feed:set', config) as Promise<LauncherUpdateState>,
  adminOverview: () => ipcRenderer.invoke('admin:overview') as Promise<DeveloperAdminOverview>,
  adminLogs: () => ipcRenderer.invoke('admin:logs') as Promise<string>,
  adminOpenLog: () => ipcRenderer.invoke('admin:open-log') as Promise<boolean>,
  onProgress: (callback: (progress: LauncherProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: LauncherProgress) => callback(progress);
    ipcRenderer.on('launcher:progress', listener);
    return () => ipcRenderer.removeListener('launcher:progress', listener);
  }
};

contextBridge.exposeInMainWorld('nebula', api);
