export type LoaderType = 'vanilla' | 'fabric' | 'forge' | 'neoforge';
export interface Profile {
  id: string;
  name: string;
  minecraftVersion: string;
  loader: LoaderType;
  loaderVersion: string;
  installedVersionId?: string;
  gameDir: string;
  memoryMb: number;
  javaPath: string;
  jvmArgs: string;
  createdAt: number;
  lastPlayed?: number;
  installed?: boolean;
}
export interface VersionItem { id: string; type: string; releaseTime: string; }
export interface ModItem { name: string; file: string; enabled: boolean; size: number; }
export interface Project { project_id: string; slug: string; title: string; description: string; icon_url?: string; downloads: number; follows: number; categories?: string[]; client_side?: string; server_side?: string; date_modified?: string; }
export interface Progress { task: string; percent: number; message: string; done?: boolean; error?: boolean; }
export interface Runtime { totalMemoryMb: number; javaFound: boolean; javaPath: string; javaMajor: number | null; javaVersion: string; recommendedJava: number; os: string; }
export interface ProfileCheckItem { id: string; label: string; status: 'ok' | 'warning' | 'error'; detail: string; }
export interface ProfileCheckReport { ready: boolean; checkedAt: number; checks: ProfileCheckItem[]; }
export interface LoaderVersions { fabric: string[]; forge: string[]; neoforge: string[]; errors?: Partial<Record<'fabric' | 'forge' | 'neoforge', string>>; }
export interface FriendPresence { code: string; name: string; online: boolean; hosting: boolean; minecraftVersion?: string; loader?: LoaderType; loaderVersion?: string; worldName?: string; address?: string; port?: number; lastSeen?: number; }
export interface FriendsState { myCode: string; friends: FriendPresence[]; lanDiscovery: boolean; discoveryMessage: string; }
export interface DeveloperAdminStatus { configured: boolean; authenticated: boolean; lockedForMs: number; }
export interface DeveloperAdminOverview { appVersion: string; electronVersion: string; nodeVersion: string; platform: string; architecture: string; uptimeSeconds: number; profileCount: number; installedProfileCount: number; releaseFeedConfigured: boolean; logPath: string; }
export type UpdateFeedConfig = { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string };
export interface UpdateFeedTestResult { ok: boolean; ready: boolean; message: string; latestVersion?: string; }
export interface ModrinthCategory { name: string; project_type?: string | null; header?: string; icon?: string; }
export interface ModrinthBrowseOptions { offset?: number; sort?: 'relevance' | 'downloads' | 'follows' | 'updated' | 'newest'; category?: string; limit?: number; }
export interface LauncherUpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion: string | null;
  percent: number;
  message: string;
  notes: string[];
  feedConfigured: boolean;
  feedProvider: 'github' | 'generic' | null;
  feedName: string | null;
}
export interface NebulaApi {
  getState(): Promise<{ profiles: Profile[]; selectedProfileId: string | null; showSnapshots: boolean }>;
  getVersions(snapshots: boolean): Promise<VersionItem[]>;
  getLoaderVersions(version: string): Promise<LoaderVersions>;
  getRuntimeInfo(profileId?: string): Promise<Runtime>;
  createProfile(input: { name: string; minecraftVersion: string; loader: LoaderType; loaderVersion?: string }): Promise<Profile>;
  selectProfile(id: string): Promise<unknown>;
  deleteProfile(id: string): Promise<{ profiles: Profile[]; selectedProfileId: string | null }>;
  updateProfile(id: string, patch: Partial<Profile>): Promise<Profile>;
  installProfile(id: string): Promise<unknown>;
  repairProfile(id: string): Promise<ProfileCheckReport>;
  diagnoseProfile(id: string): Promise<ProfileCheckReport>;
  installJavaRuntime(id: string): Promise<string>;
  launchProfile(id: string, username: string): Promise<unknown>;
  getFriendsState(): Promise<FriendsState>;
  addFriend(code: string, name: string): Promise<{ added: { code: string; name: string; addedAt: number }; state: FriendsState }>;
  removeFriend(code: string): Promise<FriendsState>;
  setManualLanPort(port: number | null): Promise<FriendsState>;
  joinFriend(profileId: string, code: string, username: string): Promise<unknown>;
  onFriendsState(callback: (state: FriendsState) => void): () => void;
  listMods(id: string): Promise<ModItem[]>;
  importMods(id: string): Promise<string[]>;
  toggleMod(id: string, file: string, enabled: boolean): Promise<string>;
  deleteMod(id: string, file: string): Promise<void>;
  searchModrinth(query: string, type: 'mod' | 'modpack', profileId: string, options: ModrinthBrowseOptions): Promise<{ hits: Project[]; total_hits: number }>;
  getModrinthCategories(type: 'mod' | 'modpack'): Promise<ModrinthCategory[]>;
  openModrinthProject(type: 'mod' | 'modpack', slug: string): Promise<void>;
  getUpdateState(): Promise<LauncherUpdateState>;
  checkUpdates(): Promise<LauncherUpdateState>;
  downloadUpdate(): Promise<boolean>;
  installUpdate(): Promise<void>;
  onUpdateStatus(callback: (state: LauncherUpdateState) => void): () => void;
  installModrinthMod(projectId: string, profileId: string): Promise<number>;
  installModrinthPack(projectId: string, profileId: string): Promise<{ modsInstalled: number; packName: string }>;
  importPack(profileId: string): Promise<{ modsInstalled: number; packName: string } | null>;
  setShowSnapshots(value: boolean): Promise<unknown>;
  hasCurseForgeApiKey(): Promise<boolean>;
  setCurseForgeApiKey(value: string): Promise<unknown>;
  chooseJava(): Promise<string | null>;
  openErrorLog(): Promise<string>;
  adminStatus(): Promise<DeveloperAdminStatus>;
  adminSetup(username: string, password: string): Promise<{ username: string; sessionMinutes: number }>;
  adminLogin(username: string, password: string): Promise<{ username: string; sessionMinutes: number }>;
  adminLogout(): Promise<boolean>;
  adminUpdateFeed(): Promise<UpdateFeedConfig | null>;
  adminTestUpdateFeed(config: UpdateFeedConfig): Promise<UpdateFeedTestResult>;
  adminSetUpdateFeed(config: UpdateFeedConfig): Promise<LauncherUpdateState>;
  adminOverview(): Promise<DeveloperAdminOverview>;
  adminLogs(): Promise<string>;
  adminOpenLog(): Promise<boolean>;
  onProgress(callback: (progress: Progress) => void): () => void;
}
