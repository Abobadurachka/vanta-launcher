export type LoaderType = 'vanilla' | 'fabric' | 'forge' | 'neoforge';
export type TabId = 'home' | 'mods' | 'packs' | 'settings' | 'friends' | 'updates' | 'admin';

export interface LauncherProfile {
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

export interface VersionItem {
  id: string;
  type: 'release' | 'snapshot' | string;
  releaseTime: string;
}

export interface LoaderVersionCatalog {
  fabric: string[];
  forge: string[];
  neoforge: string[];
  errors?: Partial<Record<'fabric' | 'forge' | 'neoforge', string>>;
}

export interface ModrinthProject {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url?: string;
  downloads: number;
  follows: number;
  categories?: string[];
  client_side?: string;
  server_side?: string;
  date_modified?: string;
}

export interface ModrinthCategory {
  name: string;
  project_type?: string | null;
  header?: string;
  icon?: string;
}

export interface InstalledMod {
  name: string;
  file: string;
  enabled: boolean;
  size: number;
}

export interface LauncherProgress {
  task: string;
  percent: number;
  message: string;
  done?: boolean;
  error?: boolean;
}

export interface RuntimeInfo {
  totalMemoryMb: number;
  javaFound: boolean;
  javaPath: string;
  javaMajor: number | null;
  javaVersion: string;
  os: string;
}

export interface CreateProfileInput {
  name: string;
  minecraftVersion: string;
  loader: LoaderType;
  loaderVersion?: string;
}

export interface DeveloperAdminStatus {
  configured: boolean;
  authenticated: boolean;
  lockedForMs: number;
}

export interface DeveloperAdminOverview {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  uptimeSeconds: number;
  profileCount: number;
  installedProfileCount: number;
  releaseFeedConfigured: boolean;
  logPath: string;
}


export type UpdateFeedConfig =
  | { provider: 'github'; owner: string; repo: string }
  | { provider: 'generic'; url: string };

export interface UpdateFeedTestResult {
  ok: boolean;
  ready: boolean;
  message: string;
  latestVersion?: string;
}


export interface FriendContact {
  code: string;
  name: string;
  addedAt: number;
}

export interface FriendPresence {
  code: string;
  name: string;
  online: boolean;
  hosting: boolean;
  minecraftVersion?: string;
  loader?: LoaderType;
  loaderVersion?: string;
  worldName?: string;
  address?: string;
  port?: number;
  lastSeen?: number;
}

export interface FriendsState {
  myCode: string;
  friends: FriendPresence[];
  lanDiscovery: boolean;
  discoveryMessage: string;
}
