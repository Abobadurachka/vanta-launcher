import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CreateProfileInput, FriendContact, LauncherProfile } from './types';

export interface LauncherConfig {
  profiles: LauncherProfile[];
  selectedProfileId: string | null;
  showSnapshots: boolean;
  curseForgeApiKeyEncrypted?: string;
  friendCode?: string;
  friends?: FriendContact[];
}

export const dataRoot = () => path.join(app.getPath('userData'), 'NebulaLauncher');
export const instancesRoot = () => path.join(dataRoot(), 'instances');
export const configPath = () => path.join(dataRoot(), 'launcher.json');

const defaultConfig = (): LauncherConfig => ({ profiles: [], selectedProfileId: null, showSnapshots: false });

export async function ensureDirectories() {
  await mkdir(dataRoot(), { recursive: true });
  await mkdir(instancesRoot(), { recursive: true });
}

export async function readConfig(): Promise<LauncherConfig> {
  await ensureDirectories();
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<LauncherConfig>;
    return {
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      selectedProfileId: parsed.selectedProfileId ?? null,
      showSnapshots: Boolean(parsed.showSnapshots),
      curseForgeApiKeyEncrypted: typeof parsed.curseForgeApiKeyEncrypted === 'string' ? parsed.curseForgeApiKeyEncrypted : undefined,
      friendCode: typeof parsed.friendCode === 'string' ? parsed.friendCode : undefined,
      friends: Array.isArray(parsed.friends) ? parsed.friends.filter((item: any) => item && typeof item.code === 'string' && typeof item.name === 'string') : []
    };
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(config: LauncherConfig) {
  await ensureDirectories();
  await writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

export async function createProfile(input: CreateProfileInput): Promise<LauncherProfile> {
  const config = await readConfig();
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const gameDir = path.join(instancesRoot(), id);
  await mkdir(gameDir, { recursive: true });
  const profile: LauncherProfile = {
    id,
    name: input.name.trim() || `Профиль ${input.minecraftVersion}`,
    minecraftVersion: input.minecraftVersion,
    loader: input.loader,
    loaderVersion: input.loaderVersion || '',
    gameDir,
    memoryMb: 4096,
    javaPath: '',
    jvmArgs: '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M',
    createdAt: Date.now(),
    installed: false
  };
  config.profiles.push(profile);
  config.selectedProfileId = id;
  await writeConfig(config);
  return profile;
}

export async function updateProfile(id: string, patch: Partial<LauncherProfile>) {
  const config = await readConfig();
  const index = config.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error('Профиль не найден');
  const current = config.profiles[index];
  const allowed: Partial<LauncherProfile> = {};
  for (const key of ['name', 'minecraftVersion', 'loader', 'loaderVersion', 'installedVersionId', 'memoryMb', 'javaPath', 'jvmArgs', 'installed', 'lastPlayed'] as const) {
    if (patch[key] !== undefined) (allowed as Record<string, unknown>)[key] = patch[key];
  }
  config.profiles[index] = { ...current, ...allowed };
  await writeConfig(config);
  return config.profiles[index];
}

export async function selectProfile(id: string) {
  const config = await readConfig();
  if (!config.profiles.some((profile) => profile.id === id)) throw new Error('Профиль не найден');
  config.selectedProfileId = id;
  await writeConfig(config);
  return config;
}

export async function deleteProfile(id: string) {
  const config = await readConfig();
  const profile = config.profiles.find((entry) => entry.id === id);
  if (!profile) return config;
  const { rm } = await import('node:fs/promises');
  await rm(profile.gameDir, { recursive: true, force: true });
  config.profiles = config.profiles.filter((entry) => entry.id !== id);
  if (config.selectedProfileId === id) config.selectedProfileId = config.profiles[0]?.id ?? null;
  await writeConfig(config);
  return config;
}

export async function setShowSnapshots(value: boolean) {
  const config = await readConfig();
  config.showSnapshots = value;
  await writeConfig(config);
  return config;
}

export async function getCurseForgeApiKey() {
  const config = await readConfig();
  if (!config.curseForgeApiKeyEncrypted || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(config.curseForgeApiKeyEncrypted, 'base64')); }
  catch { return ''; }
}

export async function setCurseForgeApiKey(value: string) {
  const config = await readConfig();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище Windows недоступно. Ключ не сохранён.');
  config.curseForgeApiKeyEncrypted = value.trim() ? safeStorage.encryptString(value.trim()).toString('base64') : undefined;
  await writeConfig(config);
  return Boolean(config.curseForgeApiKeyEncrypted);
}

export async function hasCurseForgeApiKey() {
  const config = await readConfig();
  return Boolean(config.curseForgeApiKeyEncrypted && safeStorage.isEncryptionAvailable());
}


const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function createFriendCodeRaw() {
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (byte) => FRIEND_CODE_ALPHABET[byte & 31]).join('');
}
export function normalizeFriendCode(value: string) {
  let normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.startsWith('VANTA')) normalized = normalized.slice(5);
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalized)) throw new Error('Код друга должен содержать 12 символов. Проверь формат VANTA-XXXX-XXXX-XXXX.');
  return normalized;
}
export function formatFriendCode(value: string) {
  const code = normalizeFriendCode(value);
  return `VANTA-${code.slice(0,4)}-${code.slice(4,8)}-${code.slice(8,12)}`;
}
export async function getFriendSettings() {
  const config = await readConfig();
  if (!config.friendCode || !/^[A-HJ-NP-Z2-9]{12}$/.test(config.friendCode)) {
    config.friendCode = createFriendCodeRaw();
    await writeConfig(config);
  }
  return { myCode: formatFriendCode(config.friendCode), myCodeRaw: config.friendCode, friends: config.friends || [] };
}
export async function addFriendContact(rawCode: string, displayName: string) {
  const code = normalizeFriendCode(rawCode);
  const settings = await getFriendSettings();
  if (code === settings.myCodeRaw) throw new Error('Нельзя добавить собственный код в друзья.');
  const config = await readConfig();
  const list = config.friends || [];
  if (list.some((entry) => entry.code === code)) throw new Error('Этот друг уже есть в списке.');
  const name = String(displayName || '').trim().replace(/[\u0000-\u001f]/g, '').slice(0, 32);
  if (!name) throw new Error('Укажи имя друга.');
  list.push({ code, name, addedAt: Date.now() });
  config.friends = list;
  await writeConfig(config);
  return { code, name, addedAt: Date.now() };
}
export async function removeFriendContact(rawCode: string) {
  const code = normalizeFriendCode(rawCode);
  const config = await readConfig();
  config.friends = (config.friends || []).filter((entry) => entry.code !== code);
  await writeConfig(config);
  return true;
}
