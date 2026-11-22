import { app } from 'electron';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractZip } from './archive';
import { downloadFile, fetchJson, mapLimit, safeJoin, type ProgressCallback } from './net';
import { dataRoot, updateProfile } from './store';
import type { LauncherProfile, RuntimeInfo, VersionItem } from './types';
import { clearActiveGameContext, isPrivateLanAddress, setActiveGameContext } from './friends';

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN_META = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEO_META = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const DEFAULT_JVM = '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M';
const LIBRARY_DOWNLOAD_WORKERS = Math.max(8, Math.min(16, os.cpus().length * 2));
const ASSET_DOWNLOAD_WORKERS = Math.max(12, Math.min(24, os.cpus().length * 3));

type Progress = (task: string, percent: number, message: string, done?: boolean, error?: boolean) => void;
interface MojangVersion { id: string; type: string; url: string; releaseTime: string; }
interface VersionManifest { latest: { release: string; snapshot: string }; versions: MojangVersion[]; }
interface VersionJson {
  id: string;
  type?: string;
  mainClass: string;
  inheritsFrom?: string;
  assets?: string;
  assetIndex?: { id: string; url: string; sha1?: string; size?: number };
  downloads?: { client?: { url: string; sha1?: string; size?: number } };
  libraries?: any[];
  arguments?: { game?: any[]; jvm?: any[] };
  minecraftArguments?: string;
  javaVersion?: { component?: string; majorVersion?: number };
}

export async function getMinecraftVersions(showSnapshots: boolean): Promise<VersionItem[]> {
  const manifest = await fetchJson<VersionManifest>(MANIFEST_URL);
  return manifest.versions
    .filter((entry) => showSnapshots || entry.type === 'release')
    .map(({ id, type, releaseTime }) => ({ id, type, releaseTime }));
}

export async function getVersionManifestEntry(versionId: string) {
  const manifest = await fetchJson<VersionManifest>(MANIFEST_URL);
  const entry = manifest.versions.find((version) => version.id === versionId);
  if (!entry) throw new Error(`Minecraft ${versionId} отсутствует в официальном manifest`);
  return entry;
}

function platformName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function ruleAllowed(rules?: any[]) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    const osRule = rule.os;
    let matches = true;
    if (osRule?.name && osRule.name !== platformName()) matches = false;
    if (osRule?.arch) {
      const is64 = process.arch === 'x64' || process.arch === 'arm64';
      if (osRule.arch === 'x86' && is64) matches = false;
      if (osRule.arch === 'x86_64' && !is64) matches = false;
    }
    if (rule.features) {
      const features: Record<string, boolean> = {
        is_demo_user: false,
        has_custom_resolution: false,
        has_quick_plays_support: false,
        is_quick_play_singleplayer: false,
        is_quick_play_multiplayer: false,
        is_quick_play_realms: false
      };
      for (const [key, expected] of Object.entries(rule.features)) {
        if ((features[key] ?? false) !== expected) matches = false;
      }
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

function parseMavenCoordinate(name: string) {
  const [coordinate, extension = 'jar'] = name.split('@');
  const parts = coordinate.split(':');
  const group = parts[0].replace(/\./g, '/');
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts[3];
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${extension}`;
  return `${group}/${artifact}/${version}/${file}`;
}

function libraryArtifact(library: any) {
  if (library.downloads?.artifact?.path) return library.downloads.artifact;
  if (library.name) {
    const artifactPath = parseMavenCoordinate(library.name);
    const base = (library.url || 'https://libraries.minecraft.net/').replace(/\/$/, '');
    return { path: artifactPath, url: `${base}/${artifactPath}` };
  }
  return null;
}

async function sha1File(filePath: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function ensureDownloadedFile(
  url: string,
  filePath: string,
  expectedSha1?: string,
  progress?: (percent: number, message: string) => void,
  forceVerify = false
) {
  if (existsSync(filePath)) {
    if (!forceVerify || !expectedSha1) return;
    try {
      if ((await sha1File(filePath)).toLowerCase() === expectedSha1.toLowerCase()) return;
    } catch { /* invalid or unreadable cache entry; download a fresh copy */ }
  }
  await rm(filePath, { force: true });
  await downloadFile(url, filePath, progress, expectedSha1);
}

async function readVersionMetadata(profile: LauncherProfile, versionId: string): Promise<VersionJson> {
  const versionsDir = path.join(profile.gameDir, 'versions', versionId);
  const jsonPath = path.join(versionsDir, `${versionId}.json`);
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as VersionJson;
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.libraries)) return parsed;
    } catch { /* replace truncated metadata below */ }
  }
  const entry = await getVersionManifestEntry(versionId);
  const version = await fetchJson<VersionJson>(entry.url);
  if (!version.id || !version.mainClass) throw new Error(`Сервер Mojang вернул неполные метаданные Minecraft ${versionId}`);
  await mkdir(versionsDir, { recursive: true });
  const temporary = `${jsonPath}.part`;
  await writeFile(temporary, JSON.stringify(version, null, 2), 'utf8');
  await rename(temporary, jsonPath);
  return version;
}

async function ensureBaseVersion(profile: LauncherProfile, versionId: string, progress: Progress, forceVerify = false) {
  const versionsDir = path.join(profile.gameDir, 'versions', versionId);
  const jsonPath = path.join(versionsDir, `${versionId}.json`);
  const jarPath = path.join(versionsDir, `${versionId}.jar`);
  progress('install', 2, `Подготовка базовой версии Minecraft ${versionId}`);
  const version = await readVersionMetadata(profile, versionId);
  if (version.downloads?.client?.url) {
    progress('install', 6, `Проверка клиента Minecraft ${versionId}`);
    await ensureDownloadedFile(
      version.downloads.client.url,
      jarPath,
      version.downloads.client.sha1,
      (pct, msg) => progress('install', 6 + Math.round(pct * 0.12), `Клиент Minecraft: ${msg}`),
      forceVerify
    );
  } else if (!existsSync(jarPath)) {
    throw new Error(`В официальных метаданных Minecraft ${versionId} нет ссылки на клиентский JAR.`);
  }
  await installLibrariesAndAssets(profile.gameDir, version, progress, forceVerify);
  return version;
}

async function installLibrariesAndAssets(gameDir: string, version: VersionJson, progress: Progress, forceVerify = false) {
  const libs = (version.libraries || []).filter((library) => ruleAllowed(library.rules));
  const libraryTasks: Array<{ url: string; file: string; sha1?: string; native?: boolean }> = [];
  for (const library of libs) {
    const artifact = libraryArtifact(library);
    if (artifact?.url && artifact.path) {
      libraryTasks.push({ url: artifact.url, file: path.join(gameDir, 'libraries', artifact.path), sha1: artifact.sha1 });
    }
    const nativeKey = library.natives?.[platformName()];
    if (nativeKey && library.downloads?.classifiers) {
      const classifier = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const nativeArtifact = library.downloads.classifiers[classifier];
      if (nativeArtifact?.url && nativeArtifact?.path) {
        libraryTasks.push({ url: nativeArtifact.url, file: path.join(gameDir, 'libraries', nativeArtifact.path), sha1: nativeArtifact.sha1, native: true });
      }
    }
  }

  const nativeDir = path.join(gameDir, 'natives', version.id.replace(/[^\w.-]/g, '_'));
  await rm(nativeDir, { recursive: true, force: true });
  await mkdir(nativeDir, { recursive: true });
  let completed = 0;
  const total = Math.max(1, libraryTasks.length + (version.assetIndex ? 1 : 0));
  await mapLimit(libraryTasks, LIBRARY_DOWNLOAD_WORKERS, async (task) => {
    await ensureDownloadedFile(task.url, task.file, task.sha1, undefined, forceVerify);
    completed += 1;
    progress('install', Math.min(68, 18 + Math.round((completed / total) * 48)), `Библиотеки: ${completed}/${libraryTasks.length}`);
  });
  // Extract native archives sequentially so archives that contain shared file
  // names cannot overwrite each other while multiple downloads finish together.
  for (const task of libraryTasks.filter((item) => item.native)) {
    await extractZip(task.file, nativeDir, (name) => !name.startsWith('META-INF/') && !name.endsWith('/'));
  }

  if (version.assetIndex) {
    const assetsDir = path.join(gameDir, 'assets');
    const indexPath = path.join(assetsDir, 'indexes', `${version.assetIndex.id}.json`);
    await ensureDownloadedFile(version.assetIndex.url, indexPath, version.assetIndex.sha1, undefined, forceVerify);
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as { objects: Record<string, { hash: string; size: number }> };
    const objects = Object.values(index.objects || {});
    let assetDone = 0;
    await mapLimit(objects, ASSET_DOWNLOAD_WORKERS, async (object) => {
      const target = path.join(assetsDir, 'objects', object.hash.slice(0, 2), object.hash);
      await ensureDownloadedFile(
        `https://resources.download.minecraft.net/${object.hash.slice(0, 2)}/${object.hash}`,
        target,
        object.hash,
        undefined,
        forceVerify
      );
      assetDone += 1;
      if (assetDone % 25 === 0 || assetDone === objects.length) {
        progress('install', 68 + Math.round((assetDone / Math.max(1, objects.length)) * 27), `Ресурсы: ${assetDone}/${objects.length}`);
      }
    });
  }
}

/** Forge's client installer checks for this file before it installs. Each Vanta
 * instance has its own game directory, so create a minimal launcher profile there
 * instead of requiring the user to install/run the official launcher first. */
async function ensureLauncherProfiles(gameDir: string, profile: LauncherProfile) {
  const filePath = path.join(gameDir, 'launcher_profiles.json');
  let data: Record<string, any> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      else throw new Error('launcher_profiles.json is not an object');
    } catch {
      const backupPath = `${filePath}.corrupt-${Date.now()}.bak`;
      await copyFile(filePath, backupPath).catch(() => undefined);
      data = {};
    }
  }
  const profiles = data.profiles && typeof data.profiles === 'object' && !Array.isArray(data.profiles) ? data.profiles : {};
  const profileKey = `nebula-${profile.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const current = profiles[profileKey] && typeof profiles[profileKey] === 'object' ? profiles[profileKey] : {};
  const now = new Date().toISOString();
  profiles[profileKey] = {
    ...current,
    name: `Vanta · ${profile.name}`,
    type: 'custom',
    created: current.created || now,
    lastUsed: now,
    lastVersionId: profile.minecraftVersion,
    gameDir,
    javaDir: profile.javaPath || '',
    javaArgs: profile.jvmArgs || ''
  };
  data.profiles = profiles;
  data.settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  data.version = typeof data.version === 'number' ? data.version : 4;
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  await rename(temporary, filePath);
}

function compareNaturalVersionsDescending(left: string, right: string) {
  // Stable releases should appear before pre-releases where the numeric core matches.
  const leftStable = !/(?:alpha|beta|rc|pre|snapshot)/i.test(left);
  const rightStable = !/(?:alpha|beta|rc|pre|snapshot)/i.test(right);
  if (leftStable !== rightStable) return leftStable ? -1 : 1;
  return right.localeCompare(left, undefined, { numeric: true, sensitivity: 'base' });
}

function neoForgePrefixForMinecraft(gameVersion: string): string | null {
  // NeoForged changed its version scheme to follow Minecraft's release train:
  // 1.20.4 -> 20.4.x, 1.21.1 -> 21.1.x, 26.1 -> 26.1.x.
  // Snapshots/pre-releases are intentionally not guessed: only published game versions
  // that have a matching Maven line are offered.
  const match = gameVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const first = Number(match[1]);
  const major = first === 1 ? match[2] : match[1];
  const minor = first === 1 ? (match[3] || '0') : match[2];
  return `${major}.${minor}.`;
}

function xmlVersions(xml: string): string[] {
  return [...xml.matchAll(/<version>\s*([^<]+?)\s*<\/version>/g)].map((match) => match[1].trim()).filter(Boolean);
}

const LOADER_METADATA_CACHE_MS = 10 * 60 * 1000;
let forgeMetadataCache: { expiresAt: number; versions: string[] } | null = null;
let forgeMetadataPending: Promise<string[]> | null = null;
let forgePromotionsCache: { expiresAt: number; promos: Record<string, string> } | null = null;
let forgePromotionsPending: Promise<Record<string, string>> | null = null;
let neoForgeMetadataCache: { expiresAt: number; versions: string[] } | null = null;
let neoForgeMetadataPending: Promise<string[]> | null = null;

async function getForgeMavenVersions(): Promise<string[]> {
  if (forgeMetadataCache && forgeMetadataCache.expiresAt > Date.now()) return forgeMetadataCache.versions;
  if (forgeMetadataPending) return forgeMetadataPending;
  forgeMetadataPending = (async () => {
    const response = await fetch(FORGE_MAVEN_META, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Forge Maven metadata: HTTP ${response.status}`);
    const versions = xmlVersions(await response.text());
    forgeMetadataCache = { expiresAt: Date.now() + LOADER_METADATA_CACHE_MS, versions };
    return versions;
  })();
  try { return await forgeMetadataPending; }
  finally { forgeMetadataPending = null; }
}

async function getForgePromotions(): Promise<Record<string, string>> {
  if (forgePromotionsCache && forgePromotionsCache.expiresAt > Date.now()) return forgePromotionsCache.promos;
  if (forgePromotionsPending) return forgePromotionsPending;
  forgePromotionsPending = (async () => {
    const data = await fetchJson<{ promos: Record<string, string> }>(FORGE_PROMOTIONS);
    const promos = data?.promos && typeof data.promos === 'object' ? data.promos : {};
    forgePromotionsCache = { expiresAt: Date.now() + LOADER_METADATA_CACHE_MS, promos };
    return promos;
  })();
  try { return await forgePromotionsPending; }
  finally { forgePromotionsPending = null; }
}

async function getNeoForgeMavenVersions(): Promise<string[]> {
  if (neoForgeMetadataCache && neoForgeMetadataCache.expiresAt > Date.now()) return neoForgeMetadataCache.versions;
  if (neoForgeMetadataPending) return neoForgeMetadataPending;
  neoForgeMetadataPending = (async () => {
    const response = await fetch(NEO_META, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`NeoForge Maven metadata: HTTP ${response.status}`);
    const versions = xmlVersions(await response.text());
    neoForgeMetadataCache = { expiresAt: Date.now() + LOADER_METADATA_CACHE_MS, versions };
    return versions;
  })();
  try { return await neoForgeMetadataPending; }
  finally { neoForgeMetadataPending = null; }
}

function shortLoaderError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, 'сервер метаданных').slice(0, 180);
}

export async function getLoaderVersions(minecraftVersion: string) {
  const result: { fabric: string[]; forge: string[]; neoforge: string[]; errors: Partial<Record<'fabric' | 'forge' | 'neoforge', string>> } = {
    fabric: [], forge: [], neoforge: [], errors: {}
  };
  const safeVersion = encodeURIComponent(minecraftVersion);
  const prefix = neoForgePrefixForMinecraft(minecraftVersion);

  // Load all providers in parallel. Maven metadata is cached for ten minutes because
  // each response contains versions for many Minecraft branches and can be large.
  await Promise.all([
    (async () => {
      try {
        const data = await fetchJson<Array<{ version?: string; stable?: boolean; loader?: { version: string; stable: boolean } }>>(`${FABRIC_META}/versions/loader/${safeVersion}`);
        result.fabric = [...new Set(data
          .map((item) => item.loader || item)
          .filter((item) => typeof item.version === 'string' && item.version.length > 0)
          .sort((a, b) => Number(Boolean(b.stable)) - Number(Boolean(a.stable)) || compareNaturalVersionsDescending(a.version!, b.version!))
          .map((item) => item.version!))];
      } catch (error) { result.errors.fabric = shortLoaderError(error); }
    })(),
    (async () => {
      const [promotions, metadata] = await Promise.allSettled([getForgePromotions(), getForgeMavenVersions()]);
      const promoted = promotions.status === 'fulfilled'
        ? [promotions.value[`${minecraftVersion}-recommended`], promotions.value[`${minecraftVersion}-latest`]].filter(Boolean) as string[]
        : [];
      const allForGame = metadata.status === 'fulfilled'
        ? metadata.value.filter((entry) => entry.startsWith(`${minecraftVersion}-`)).map((entry) => entry.slice(minecraftVersion.length + 1))
        : [];
      result.forge = [...new Set([...promoted, ...allForGame])].sort((a, b) => {
        const ai = promoted.indexOf(a); const bi = promoted.indexOf(b);
        if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        return compareNaturalVersionsDescending(a, b);
      });
      if (metadata.status === 'rejected') result.errors.forge = shortLoaderError(metadata.reason);
      else if (promotions.status === 'rejected') result.errors.forge = `Список загружен, но promotions недоступен: ${shortLoaderError(promotions.reason)}`;
    })(),
    (async () => {
      if (!prefix) return;
      try {
        const versions = await getNeoForgeMavenVersions();
        result.neoforge = [...new Set(versions.filter((version) => version.startsWith(prefix)))].sort(compareNaturalVersionsDescending);
      } catch (error) { result.errors.neoforge = shortLoaderError(error); }
    })()
  ]);
  return result;
}

async function installFabric(profile: LauncherProfile, progress: Progress, forceVerify = false) {
  const base = await ensureBaseVersion(profile, profile.minecraftVersion, progress, forceVerify);
  const available = await fetchJson<Array<{ version?: string; stable?: boolean; loader?: { version: string; stable: boolean } }>>(`${FABRIC_META}/versions/loader/${encodeURIComponent(profile.minecraftVersion)}`);
  const loaders = available.map((entry) => entry.loader || entry).filter((entry) => Boolean(entry.version));
  const loaderVersion = profile.loaderVersion || loaders.find((entry) => entry.stable)?.version || loaders[0]?.version;
  if (!loaderVersion) throw new Error(`Fabric не поддерживает Minecraft ${profile.minecraftVersion}`);
  const fabricProfile = await fetchJson<VersionJson>(`${FABRIC_META}/versions/loader/${encodeURIComponent(profile.minecraftVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  const id = fabricProfile.id || `fabric-loader-${loaderVersion}-${profile.minecraftVersion}`;
  fabricProfile.id = id;
  fabricProfile.inheritsFrom = profile.minecraftVersion;
  const versionDir = path.join(profile.gameDir, 'versions', id);
  await mkdir(versionDir, { recursive: true });
  await writeFile(path.join(versionDir, `${id}.json`), JSON.stringify(fabricProfile, null, 2));
  await installLibrariesAndAssets(profile.gameDir, { ...fabricProfile, downloads: base.downloads, assetIndex: base.assetIndex, id }, progress, forceVerify);
  await updateProfile(profile.id, { loaderVersion, installedVersionId: id, installed: true });
  return id;
}

async function getJavaPath(profile?: LauncherProfile) {
  if (profile?.javaPath && existsSync(profile.javaPath)) return profile.javaPath;
  if (process.env.JAVA_HOME) {
    const candidate = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (existsSync(candidate)) return candidate;
  }
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Java\\bin\\java.exe', 'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe', 'C:\\Program Files\\Microsoft\\jdk-21\\bin\\java.exe']
    : ['/usr/bin/java', '/usr/local/bin/java', '/opt/homebrew/bin/java'];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(which, ['java'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim();
    if (found && existsSync(found)) return found;
  } catch { /* java not in PATH */ }
  return '';
}

function inspectJava(javaPath: string) {
  if (!javaPath) return { javaMajor: null as number | null, javaVersion: 'Java не найдена' };
  // Java writes `java -version` to STDERR on successful runs. spawnSync exposes
  // both streams; execFileSync's return value only contained STDOUT and caused
  // valid Java installations to be misdetected.
  const result = spawnSync(javaPath, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/version "([^"]+)"/) || output.match(/openjdk\s+([\d.]+)/i);
  const version = match?.[1] || (result.error ? result.error.message : 'неизвестно');
  const major = version.startsWith('1.') ? Number(version.split('.')[1]) : Number(version.split('.')[0].split('-')[0]);
  return { javaMajor: Number.isFinite(major) ? major : null, javaVersion: version };
}

function recommendedJava(version: VersionJson) {
  if (version.javaVersion?.majorVersion) return version.javaVersion.majorVersion;
  // Mojang's version JSON normally declares javaVersion. Keep a correct fallback
  // for older metadata and for the newer year-based release numbering (26.x).
  const match = version.id.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    // Week-based snapshots before 1.21 generally use Java 17; 24w snapshots
    // and later track the Java 21+ era. Pre-release alpha/beta/infdev versions
    // without a numeric release id use the legacy Java 8 runtime.
    const snapshot = version.id.match(/^(\d{2})w\d{2}[a-z]/i);
    if (snapshot) return Number(snapshot[1]) >= 24 ? 21 : 17;
    return 8;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  if (major >= 26) return 25;
  if (major !== 1) return major >= 21 ? 21 : 17;
  if (minor >= 21) return 21;
  if (minor === 20 && patch >= 5) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

export async function getRuntimeInfo(profile?: LauncherProfile): Promise<RuntimeInfo & { recommendedJava: number }> {
  const javaPath = await getJavaPath(profile);
  const inspected = inspectJava(javaPath);
  let required = 21;
  if (profile) {
    try {
      const entry = await getVersionManifestEntry(profile.minecraftVersion);
      const json = await fetchJson<VersionJson>(entry.url);
      required = recommendedJava(json);
    } catch { required = recommendedJava({ id: profile.minecraftVersion, mainClass: '' }); }
  }
  return {
    totalMemoryMb: Math.floor(os.totalmem() / 1024 / 1024),
    javaFound: Boolean(javaPath),
    javaPath,
    javaMajor: inspected.javaMajor,
    javaVersion: inspected.javaVersion,
    recommendedJava: required,
    os: `${os.type()} ${os.arch()}`
  };
}

async function installOfficialInstaller(profile: LauncherProfile, progress: Progress, loader: 'forge' | 'neoforge', forceVerify = false) {
  await ensureBaseVersion(profile, profile.minecraftVersion, progress, forceVerify);
  await ensureLauncherProfiles(profile.gameDir, profile);
  const java = await getJavaPath(profile);
  if (!java) throw new Error('Java не найдена. Установи подходящую Java и выбери java.exe в настройках профиля.');
  let installerUrl = '';
  let loaderVersion = profile.loaderVersion;
  if (loader === 'forge') {
    if (!loaderVersion) {
      const promotions = await fetchJson<{ promos: Record<string, string> }>(FORGE_PROMOTIONS);
      loaderVersion = promotions.promos[`${profile.minecraftVersion}-recommended`] || promotions.promos[`${profile.minecraftVersion}-latest`] || '';
    }
    if (!loaderVersion) throw new Error(`Forge не опубликовал сборку для Minecraft ${profile.minecraftVersion}`);
    installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${profile.minecraftVersion}-${loaderVersion}/forge-${profile.minecraftVersion}-${loaderVersion}-installer.jar`;
  } else {
    if (!loaderVersion) {
      const versions = await getLoaderVersions(profile.minecraftVersion);
      loaderVersion = versions.neoforge[0] || '';
    }
    if (!loaderVersion) throw new Error(`Не удалось определить версию NeoForge для Minecraft ${profile.minecraftVersion}. Укажи её вручную.`);
    installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  }
  const installerPath = path.join(app.getPath('temp'), `nebula-${loader}-${loaderVersion}-installer.jar`);
  const installerLogPath = path.join(profile.gameDir, `${path.basename(installerPath)}.log`);
  const processLogPath = path.join(profile.gameDir, `nebula-${loader}-installer-process.log`);
  progress('install', 70, `Загрузка установщика ${loader === 'forge' ? 'Forge' : 'NeoForge'}`);
  await downloadFile(installerUrl, installerPath, (pct, msg) => progress('install', 70 + Math.round(pct * 0.18), `Установщик: ${msg}`));

  // Fail early if a CDN, proxy or antivirus returned an HTML/error page instead
  // of a real installer JAR. Java's generic exit code 1 otherwise hides this.
  const installerHeader = await readFile(installerPath).then((buffer) => buffer.subarray(0, 4).toString('hex'));
  if (installerHeader !== '504b0304' && installerHeader !== '504b0506' && installerHeader !== '504b0708') {
    const sample = (await readFile(installerPath)).subarray(0, 180).toString('utf8').replace(/[\r\n\t]+/g, ' ').trim();
    throw new Error(`Сервер не отдал корректный JAR-файл установщика ${loader}. Получен файл ${installerHeader}; начало ответа: ${sample || '(пусто)'}. Проверь соединение и повтори установку.`);
  }

  progress('install', 90, `Запуск официального установщика ${loader === 'forge' ? 'Forge' : 'NeoForge'}`);
  await rm(processLogPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    // Force IPv4 for older Forge bootstrap/network code and keep its own debug
    // log (`<installer>.jar.log`) beside the profile by using cwd=gameDir.
    const installerArgs = ['-Djava.net.preferIPv4Stack=true', '-jar', installerPath, '--installClient', profile.gameDir];
    if (loader === 'forge') installerArgs.push('--debug');
    const child = spawn(java, installerArgs, {
      cwd: profile.gameDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const keepTail = (current: string, chunk: Buffer | string) => `${current}${chunk.toString()}`.slice(-30_000);
    child.stdout?.on('data', (chunk) => { stdout = keepTail(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = keepTail(stderr, chunk); });
    child.on('error', reject);
    child.on('close', async (code) => {
      const processOutput = [
        '=== Nebula process output: STDOUT ===', stdout,
        '=== Nebula process output: STDERR ===', stderr
      ].join('\n');
      try { await writeFile(processLogPath, processOutput, 'utf8'); } catch { /* profile log is best effort */ }
      if (code === 0) return resolve();
      let installerLog = '';
      try { installerLog = await readFile(installerLogPath, 'utf8'); } catch { /* the installer may fail before creating a log */ }
      const detail = [
        stdout.trim() ? `STDOUT:\n${stdout.slice(-8_000)}` : '',
        stderr.trim() ? `STDERR:\n${stderr.slice(-8_000)}` : '',
        installerLog.trim() ? `ЛОГ УСТАНОВЩИКА:\n${installerLog.slice(-14_000)}` : ''
      ].filter(Boolean).join('\n\n');
      const logHint = `Файлы диагностики: ${processLogPath}${existsSync(installerLogPath) ? ` и ${installerLogPath}` : ''}`;
      reject(new Error(`Установщик ${loader} завершился с кодом ${code}.${detail ? `\n\n${detail}` : '\nForge не передал подробности в консоль.'}\n\n${logHint}`));
    });
  });
  const versionsDir = path.join(profile.gameDir, 'versions');
  const folders = await readdir(versionsDir, { withFileTypes: true });
  let installedId = '';
  for (const folder of folders.filter((entry) => entry.isDirectory())) {
    const jsonFile = path.join(versionsDir, folder.name, `${folder.name}.json`);
    if (!existsSync(jsonFile)) continue;
    try {
      const json = JSON.parse(await readFile(jsonFile, 'utf8')) as VersionJson;
      if (json.inheritsFrom === profile.minecraftVersion && (json.id.toLowerCase().includes(loader) || folder.name.toLowerCase().includes(loader))) {
        installedId = json.id;
        break;
      }
    } catch { /* ignore unrelated version dirs */ }
  }
  if (!installedId) throw new Error(`Установщик завершился, но профиль ${loader} не найден в versions. Проверь лог установщика.`);
  await updateProfile(profile.id, { loaderVersion, installedVersionId: installedId, installed: true });
  await rm(installerPath, { force: true });
  return installedId;
}

async function findJavaExecutable(root: string): Promise<string> {
  async function walk(current: string, depth: number): Promise<string> {
    if (depth > 7) return '';
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return ''; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'java.exe' && path.basename(path.dirname(full)).toLowerCase() === 'bin') return full;
      if (entry.isDirectory()) {
        const found = await walk(full, depth + 1);
        if (found) return found;
      }
    }
    return '';
  }
  return walk(root, 0);
}

export async function installJavaRuntime(profile: LauncherProfile, progress: Progress, requestedMajor?: number) {
  if (process.platform !== 'win32') throw new Error('Автоматическая установка Java сейчас доступна для Windows. Выбери установленный java или установи Java вручную.');
  const entry = await getVersionManifestEntry(profile.minecraftVersion);
  const version = await fetchJson<VersionJson>(entry.url);
  const major = requestedMajor || recommendedJava(version);
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const runtimeRoot = path.join(dataRoot(), 'runtimes', `temurin-${major}-${architecture}`);
  const existingJava = await findJavaExecutable(runtimeRoot);
  if (existingJava) {
    const existingInfo = inspectJava(existingJava);
    if (existingInfo.javaMajor !== null && existingInfo.javaMajor >= major) {
      await updateProfile(profile.id, { javaPath: existingJava });
      progress('runtime', 100, `Java ${existingInfo.javaMajor} уже установлена`, true);
      return existingJava;
    }
  }
  // Remove leftovers from an earlier interrupted extraction before unpacking a clean runtime.
  await rm(runtimeRoot, { recursive: true, force: true });
  const archivePath = path.join(app.getPath('temp'), `nebula-temurin-${major}-${Date.now()}.zip`);
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/${architecture}/jre/hotspot/normal/eclipse`;
  progress('runtime', 1, `Загрузка Eclipse Temurin JRE ${major}`);
  await downloadFile(url, archivePath, (pct, message) => progress('runtime', Math.max(1, Math.round(pct * 0.7)), `Temurin ${major}: ${message}`));
  try {
    await mkdir(runtimeRoot, { recursive: true });
    progress('runtime', 72, `Распаковка Java ${major}`);
    await extractZip(archivePath, runtimeRoot);
    const javaPath = await findJavaExecutable(runtimeRoot);
    if (!javaPath) throw new Error('В архиве Temurin не найден bin/java.exe');
    const inspected = inspectJava(javaPath);
    if (inspected.javaMajor && inspected.javaMajor !== major) throw new Error(`Скачана Java ${inspected.javaMajor}, ожидалась Java ${major}`);
    await updateProfile(profile.id, { javaPath });
    progress('runtime', 100, `Java ${major} установлена и назначена профилю`, true);
    return javaPath;
  } finally {
    await rm(archivePath, { force: true });
  }
}

async function ensureCompatibleJava(profile: LauncherProfile, progress: Progress) {
  const entry = await getVersionManifestEntry(profile.minecraftVersion);
  const version = await fetchJson<VersionJson>(entry.url);
  const required = recommendedJava(version);
  const currentPath = await getJavaPath(profile);
  const currentInfo = inspectJava(currentPath);

  if (currentPath && currentInfo.javaMajor !== null && currentInfo.javaMajor >= required) {
    profile.javaPath = currentPath;
    return currentPath;
  }

  if (process.platform === 'win32') {
    progress('runtime', 1, `Для Minecraft ${profile.minecraftVersion} нужна Java ${required}. Подготавливаем её автоматически…`);
    const installedPath = await installJavaRuntime(profile, progress, required);
    profile.javaPath = installedPath;
    return installedPath;
  }

  const found = currentPath ? `Обнаружена Java ${currentInfo.javaMajor ?? 'неизвестной версии'}.` : 'Java не найдена.';
  throw new Error(`${found} Для Minecraft ${profile.minecraftVersion} нужна Java ${required} или новее. Установи её и укажи путь в настройках профиля.`);
}

export async function installProfile(profile: LauncherProfile, progress: Progress) {
  progress('install', 0, `Подготовка ${profile.name}`);
  await ensureCompatibleJava(profile, progress);
  let installedVersionId = profile.minecraftVersion;
  if (profile.loader === 'vanilla') {
    await ensureBaseVersion(profile, profile.minecraftVersion, progress);
  } else if (profile.loader === 'fabric') {
    installedVersionId = await installFabric(profile, progress);
  } else {
    installedVersionId = await installOfficialInstaller(profile, progress, profile.loader);
  }
  await updateProfile(profile.id, { javaPath: profile.javaPath, installedVersionId, installed: true });
  progress('install', 100, 'Профиль установлен и готов к проверке', true);
  return installedVersionId;
}

function substitute(value: string, values: Record<string, string>) {
  return value.replace(/\$\{([^}]+)\}/g, (full, key: string) => values[key] ?? full);
}

function resolveArgList(args: any[] | undefined, values: Record<string, string>) {
  const output: string[] = [];
  for (const item of args || []) {
    if (typeof item === 'string') output.push(substitute(item, values));
    else if (item && typeof item === 'object') {
      if (!ruleAllowed(item.rules)) continue;
      const value = item.value;
      if (Array.isArray(value)) output.push(...value.map((entry) => substitute(String(entry), values)));
      else if (value !== undefined) output.push(substitute(String(value), values));
    }
  }
  return output;
}

function parseLegacyArgs(args: string) {
  return args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((value) => value.replace(/^"|"$/g, '')) || [];
}

async function loadMergedVersion(profile: LauncherProfile) {
  const versionId = profile.installedVersionId || profile.minecraftVersion;
  const jsonPath = path.join(profile.gameDir, 'versions', versionId, `${versionId}.json`);
  if (!existsSync(jsonPath)) throw new Error('Профиль ещё не установлен. Сначала нажми «Установить».');
  const selected = JSON.parse(await readFile(jsonPath, 'utf8')) as VersionJson;
  let base: VersionJson | null = null;
  if (selected.inheritsFrom) {
    const basePath = path.join(profile.gameDir, 'versions', selected.inheritsFrom, `${selected.inheritsFrom}.json`);
    if (!existsSync(basePath)) throw new Error(`Не найдена базовая версия ${selected.inheritsFrom}`);
    base = JSON.parse(await readFile(basePath, 'utf8')) as VersionJson;
  }
  const merged: VersionJson = {
    ...base,
    ...selected,
    id: selected.id,
    libraries: [...(base?.libraries || []), ...(selected.libraries || [])],
    arguments: {
      jvm: [...(base?.arguments?.jvm || []), ...(selected.arguments?.jvm || [])],
      game: [...(base?.arguments?.game || []), ...(selected.arguments?.game || [])]
    },
    minecraftArguments: selected.minecraftArguments || base?.minecraftArguments
  };
  return { version: merged, versionId };
}

function offlineUuid(username: string) {
  const hex = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  hex[6] = (hex[6] & 0x0f) | 0x30;
  hex[8] = (hex[8] & 0x3f) | 0x80;
  const value = hex.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export async function launchProfile(profile: LauncherProfile, username: string, progress: Progress, joinTarget?: { host: string; port: number }): Promise<number> {
  if (!profile.installed) throw new Error('Сначала установи игровой профиль.');
  const preflight = await diagnoseProfile(profile);
  const failures = preflight.checks.filter((item) => item.status === 'error');
  if (failures.length) {
    const summary = failures.slice(0, 5).map((item) => `• ${item.label}: ${item.detail}`).join('\n');
    throw new Error(`Профиль не прошёл проверку перед запуском. Нажми «Починить сборку» и повтори запуск.\n${summary}`);
  }
  const java = await getJavaPath(profile);
  if (!java) throw new Error('Java не найдена. Открой «Настройки памяти» и выбери java.exe.');
  const { version, versionId } = await loadMergedVersion(profile);
  const required = recommendedJava(version);
  const javaInfo = inspectJava(java);
  if (javaInfo.javaMajor && javaInfo.javaMajor < required) throw new Error(`Для этой версии нужна Java ${required} или новее. Сейчас обнаружена Java ${javaInfo.javaMajor}.`);

  const gameDir = profile.gameDir;
  const assetsDir = path.join(gameDir, 'assets');
  const nativesDir = path.join(gameDir, 'natives', versionId.replace(/[^\w.-]/g, '_'));
  await rm(nativesDir, { recursive: true, force: true });
  await mkdir(nativesDir, { recursive: true });
  const libs = (version.libraries || []).filter((library: any) => ruleAllowed(library.rules));
  const classpath: string[] = [];
  for (const library of libs) {
    const artifact = libraryArtifact(library);
    if (artifact?.path) {
      const file = path.join(gameDir, 'libraries', artifact.path);
      if (!existsSync(file)) throw new Error(`Не найдена библиотека ${artifact.path}. Нажми «Починить сборку».`);
      classpath.push(file);
    }
    const nativeKey = library.natives?.[platformName()];
    if (nativeKey && library.downloads?.classifiers) {
      const classifier = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const nativeArtifact = library.downloads.classifiers[classifier];
      if (nativeArtifact?.path) {
        const nativeFile = path.join(gameDir, 'libraries', nativeArtifact.path);
        if (existsSync(nativeFile)) {
          await extractZip(nativeFile, nativesDir, (name) => !name.startsWith('META-INF/') && !name.endsWith('/'));
        }
      }
    }
  }
  const baseVersionId = version.inheritsFrom || versionId;
  const clientJar = path.join(gameDir, 'versions', baseVersionId, `${baseVersionId}.jar`);
  if (!existsSync(clientJar)) throw new Error('Файл клиента Minecraft не найден. Переустанови профиль.');
  classpath.push(clientJar);

  const usernameSafe = username.trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Player';
  const uuid = offlineUuid(usernameSafe);
  const assetIndex = version.assetIndex?.id || version.assets || baseVersionId;
  const values: Record<string, string> = {
    auth_player_name: usernameSafe,
    version_name: versionId,
    game_directory: gameDir,
    assets_root: assetsDir,
    assets_index_name: assetIndex,
    auth_uuid: uuid,
    auth_access_token: '0',
    clientid: '',
    auth_xuid: '',
    user_type: 'legacy',
    version_type: version.type || 'release',
    natives_directory: nativesDir,
    launcher_name: 'VantaLauncher',
    launcher_version: '1.3.0-beta.1',
    classpath: classpath.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: path.join(gameDir, 'libraries'),
    user_properties: '{}',
    resolution_width: '1280',
    resolution_height: '720'
  };

  const defaultJvm = profile.jvmArgs?.trim() || DEFAULT_JVM;
  const jvmArgs = defaultJvm.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((value) => value.replace(/^"|"$/g, '')) || [];
  const versionJvmArgs = resolveArgList(version.arguments?.jvm, values).filter((value, index, all) => {
    if (value === '-cp' || value === '${classpath}' || value.startsWith('-Djava.library.path=')) return false;
    if (index > 0 && all[index - 1] === '-cp') return false;
    return true;
  });
  const memory = Math.max(1024, Math.min(profile.memoryMb || 4096, Math.floor(os.totalmem() / 1024 / 1024) - 512));
  const args: string[] = [
    `-Xms${Math.min(1024, memory)}M`,
    `-Xmx${memory}M`,
    ...jvmArgs,
    ...versionJvmArgs,
    `-Djava.library.path=${nativesDir}`,
    '-cp',
    classpath.join(path.delimiter)
  ];
  const gameArgs = version.arguments?.game?.length
    ? resolveArgList(version.arguments.game, values)
    : parseLegacyArgs(version.minecraftArguments || '').map((value) => substitute(value, values));
  if (!gameArgs.some((value) => value === '--gameDir')) gameArgs.push('--gameDir', gameDir);
  if (!gameArgs.some((value) => value === '--username')) gameArgs.push('--username', usernameSafe);
  if (!gameArgs.some((value) => value === '--uuid')) gameArgs.push('--uuid', uuid);
  if (!gameArgs.some((value) => value === '--accessToken')) gameArgs.push('--accessToken', '0');
  if (!gameArgs.some((value) => value === '--version')) gameArgs.push('--version', versionId);
  if (assetIndex && !gameArgs.some((value) => value === '--assetIndex')) gameArgs.push('--assetIndex', assetIndex);
  if (!gameArgs.some((value) => value === '--assetsDir')) gameArgs.push('--assetsDir', assetsDir);

  if (joinTarget) {
    if (!isPrivateLanAddress(joinTarget.host)) throw new Error('Подключение разрешено только к адресу друга в локальной сети.');
    if (!Number.isInteger(joinTarget.port) || joinTarget.port < 1 || joinTarget.port > 65535) throw new Error('Порт LAN-мира некорректен.');
    const targetAddress = `${joinTarget.host}:${joinTarget.port}`;
    // Quick Play is supported from Minecraft 1.20 onward. Earlier clients still
    // accept --server/--port, which were removed when Quick Play replaced them.
    const majorMatch = profile.minecraftVersion.match(/^(\d+)\.(\d+)/);
    const major = majorMatch ? Number(majorMatch[1]) : 1;
    const minor = majorMatch ? Number(majorMatch[2]) : 0;
    const quickPlaySupported = major > 1 || major === 1 && minor >= 20 || /^23w(\d{2})[a-z]/i.test(profile.minecraftVersion) && Number(profile.minecraftVersion.match(/^23w(\d{2})/i)?.[1] || 0) >= 14;
    if (quickPlaySupported) {
      gameArgs.push('--quickPlayMultiplayer', targetAddress, '--quickPlayPath', 'quickPlay/vanta-join-log.json');
    } else {
      gameArgs.push('--server', joinTarget.host, '--port', String(joinTarget.port));
    }
  }

  const mainClass = version.mainClass || 'net.minecraft.client.main.Main';
  const fullArgs = [...args, mainClass, ...gameArgs];
  progress('launch', 0, joinTarget ? `Подключение к LAN-миру ${joinTarget.host}:${joinTarget.port}` : `Запуск Minecraft ${profile.minecraftVersion} · ${profile.loader.toUpperCase()}`);
  setActiveGameContext(profile, username);
  const child: ChildProcess = spawn(java, fullArgs, { cwd: gameDir, windowsHide: true, detached: false });
  child.stdout?.on('data', (data) => progress('game-log', 0, String(data).trim().slice(0, 300)));
  child.stderr?.on('data', (data) => progress('game-log', 0, String(data).trim().slice(0, 300)));
  child.on('error', (error) => { clearActiveGameContext(); progress('launch', 0, error.message, true, true); });
  child.on('close', (code) => { clearActiveGameContext(); progress('launch', 100, code === 0 ? 'Minecraft закрыт' : `Minecraft завершился с кодом ${code}`, true, code !== 0); });
  await updateProfile(profile.id, { lastPlayed: Date.now() });
  progress('launch', 100, 'Процесс Minecraft запущен', true);
  return child.pid || 0;
}

export interface ProfileCheckItem {
  id: string;
  label: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
}
export interface ProfileCheckReport {
  ready: boolean;
  checkedAt: number;
  checks: ProfileCheckItem[];
}

export async function diagnoseProfile(profile: LauncherProfile): Promise<ProfileCheckReport> {
  const checks: ProfileCheckItem[] = [];
  const add = (id: string, label: string, status: ProfileCheckItem['status'], detail: string) => checks.push({ id, label, status, detail });
  const expectedIssue = profile.installed ? 'error' : 'warning';
  const baseJsonPath = path.join(profile.gameDir, 'versions', profile.minecraftVersion, `${profile.minecraftVersion}.json`);
  const baseJarPath = path.join(profile.gameDir, 'versions', profile.minecraftVersion, `${profile.minecraftVersion}.jar`);
  const folderExists = existsSync(profile.gameDir);
  add('instance', 'Папка профиля', folderExists ? 'ok' : 'error', folderExists ? 'Папка экземпляра найдена.' : 'Папка экземпляра отсутствует.');

  let baseJson: VersionJson | null = null;
  const localMetadataExists = existsSync(baseJsonPath);
  if (localMetadataExists) {
    try {
      const parsed = JSON.parse(await readFile(baseJsonPath, 'utf8')) as VersionJson;
      if (parsed?.id === profile.minecraftVersion && parsed.mainClass && Array.isArray(parsed.libraries)) baseJson = parsed;
      else add('base-json', 'Метаданные Minecraft', 'error', 'Локальный version JSON неполный или относится к другой версии. Нажми «Починить сборку».');
    } catch { add('base-json', 'Метаданные Minecraft', 'error', 'Файл version JSON повреждён. Нажми «Починить сборку».'); }
  } else {
    add('base-json', 'Локальные метаданные Minecraft', profile.installed ? 'error' : 'warning', profile.installed ? 'Файл версии не найден на диске. Починка скачает его заново.' : 'Файл будет загружен при установке профиля.');
  }
  if (!baseJson) {
    try {
      const manifestEntry = await getVersionManifestEntry(profile.minecraftVersion);
      const remoteMetadata = await fetchJson<VersionJson>(manifestEntry.url);
      if (!remoteMetadata?.mainClass || !Array.isArray(remoteMetadata.libraries)) throw new Error('Официальные метаданные Minecraft неполные.');
      baseJson = remoteMetadata;
      add('metadata', 'Связь с Mojang', 'ok', 'Официальные метаданные версии доступны для восстановления.');
    } catch (error) {
      add('metadata', 'Метаданные Mojang', 'error', error instanceof Error ? error.message : String(error));
    }
  }

  const requiredJava = baseJson ? recommendedJava(baseJson) : recommendedJava({ id: profile.minecraftVersion, mainClass: '' });
  const javaPath = await getJavaPath(profile);
  const javaInfo = inspectJava(javaPath);
  if (!javaPath) add('java', 'Java Runtime', profile.installed ? 'error' : 'warning', `Java ${requiredJava}+ ${profile.installed ? 'не найдена' : 'будет подготовлена автоматически при установке'}.`);
  else if (javaInfo.javaMajor === null || javaInfo.javaMajor < requiredJava) add('java', 'Java Runtime', profile.installed ? 'error' : 'warning', `Нужна Java ${requiredJava}+. Обнаружено: ${javaInfo.javaVersion}.`);
  else add('java', 'Java Runtime', 'ok', `Java ${javaInfo.javaMajor} подходит для Minecraft ${profile.minecraftVersion}.`);

  const baseJarExists = existsSync(baseJarPath);
  const baseReady = Boolean(baseJson) && localMetadataExists && baseJarExists;
  add('base', 'Базовая версия Minecraft', baseReady ? 'ok' : expectedIssue, baseReady ? 'Локальные метаданные и клиентский JAR найдены.' : `Не хватает ${[!localMetadataExists ? 'локальный version JSON' : '', !baseJson ? 'валидные метаданные' : '', !baseJarExists ? 'client JAR' : ''].filter(Boolean).join(' и ')}. ${profile.installed ? 'Нужно восстановить файлы.' : 'Будет загружено при установке.'}`);

  let loaderVersion: VersionJson | null = null;
  const selectedId = profile.installedVersionId || profile.minecraftVersion;
  if (profile.loader !== 'vanilla') {
    if (!profile.installedVersionId) {
      add('loader', `${profile.loader.toUpperCase()} профиль`, expectedIssue, 'Профиль загрузчика ещё не установлен или не зарегистрирован.');
    } else {
      const loaderJson = path.join(profile.gameDir, 'versions', selectedId, `${selectedId}.json`);
      try {
        const parsedLoader = JSON.parse(await readFile(loaderJson, 'utf8')) as VersionJson;
        if (!parsedLoader || parsedLoader.id !== selectedId || !parsedLoader.mainClass || parsedLoader.inheritsFrom !== profile.minecraftVersion) {
          add('loader', `${profile.loader.toUpperCase()} профиль`, 'error', `Метаданные ${selectedId}.json неполные или ссылаются на другую базовую версию.`);
        } else {
          loaderVersion = parsedLoader;
          add('loader', `${profile.loader.toUpperCase()} профиль`, 'ok', `Метаданные ${selectedId} корректны и наследуют Minecraft ${profile.minecraftVersion}.`);
        }
      } catch {
        add('loader', `${profile.loader.toUpperCase()} профиль`, expectedIssue, `${selectedId}.json отсутствует или повреждён.`);
      }
    }
  } else {
    add('loader', 'Загрузчик', 'ok', 'Используется чистая Vanilla-версия.');
  }

  if (profile.loader === 'forge' || profile.loader === 'neoforge') {
    const launcherProfiles = path.join(profile.gameDir, 'launcher_profiles.json');
    if (!existsSync(launcherProfiles)) {
      add('launcher-profiles', 'Служебный профиль лаунчера', profile.installed ? 'error' : 'warning', 'launcher_profiles.json отсутствует. Vanta создаёт этот файл автоматически перед установщиком Forge/NeoForge.');
    } else {
      try {
        const parsedProfiles = JSON.parse(await readFile(launcherProfiles, 'utf8'));
        const nebulaProfileKey = `nebula-${profile.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        if (parsedProfiles && typeof parsedProfiles === 'object' && parsedProfiles.profiles && typeof parsedProfiles.profiles === 'object' && parsedProfiles.profiles[nebulaProfileKey]) {
          add('launcher-profiles', 'Служебный профиль лаунчера', 'ok', 'launcher_profiles.json читается и содержит запись Vanta для этой сборки.');
        } else add('launcher-profiles', 'Служебный профиль лаунчера', 'error', 'launcher_profiles.json не содержит служебную запись Vanta. Нажми «Починить сборку».');
      } catch { add('launcher-profiles', 'Служебный профиль лаунчера', 'error', 'launcher_profiles.json не читается как JSON. Починка создаст резервную копию и восстановит файл.'); }
    }
  }

  if (baseJson) {
    const selectedLibraries = [...(baseJson.libraries || []), ...(loaderVersion?.libraries || [])];
    let missingLibraries = 0;
    for (const library of selectedLibraries.filter((item: any) => ruleAllowed(item.rules))) {
      const artifact = libraryArtifact(library);
      if (artifact?.path && !existsSync(path.join(profile.gameDir, 'libraries', artifact.path))) missingLibraries += 1;
      const nativeKey = library.natives?.[platformName()];
      if (nativeKey && library.downloads?.classifiers) {
        const classifier = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
        const native = library.downloads.classifiers[classifier];
        if (native?.path && !existsSync(path.join(profile.gameDir, 'libraries', native.path))) missingLibraries += 1;
      }
    }
    add('libraries', 'Библиотеки Java', missingLibraries === 0 ? 'ok' : expectedIssue, missingLibraries === 0 ? 'Все необходимые библиотеки найдены.' : `Отсутствует файлов библиотек: ${missingLibraries}. ${profile.installed ? 'Починка скачает их заново.' : 'Будут загружены при установке.'}`);

    const indexId = baseJson.assetIndex?.id;
    if (indexId) {
      const assetsDir = path.join(profile.gameDir, 'assets');
      const indexFile = path.join(assetsDir, 'indexes', `${indexId}.json`);
      if (!existsSync(indexFile)) add('assets', 'Игровые ресурсы', expectedIssue, `Отсутствует индекс ${indexId}.`);
      else {
        try {
          const assetIndex = JSON.parse(await readFile(indexFile, 'utf8')) as { objects?: Record<string, { hash: string }> };
          const objects = Object.values(assetIndex.objects || {});
          const missingAssets = objects.filter((object) => !existsSync(path.join(assetsDir, 'objects', object.hash.slice(0, 2), object.hash))).length;
          add('assets', 'Игровые ресурсы', missingAssets === 0 ? 'ok' : expectedIssue, missingAssets === 0 ? `Все ресурсы на месте (${objects.length}).` : `Отсутствует объектов ресурсов: ${missingAssets} из ${objects.length}.`);
        } catch { add('assets', 'Игровые ресурсы', 'error', `Индекс ${indexId} повреждён или не читается.`); }
      }
    } else add('assets', 'Игровые ресурсы', 'warning', 'В метаданных версии нет отдельного asset index.');
  } else {
    add('libraries', 'Библиотеки Java', expectedIssue, 'Нельзя проверить библиотеки без метаданных Minecraft.');
    add('assets', 'Игровые ресурсы', expectedIssue, 'Нельзя проверить ресурсы без метаданных Minecraft.');
  }

  if (!profile.installed) add('installed', 'Состояние профиля', 'warning', 'Профиль ещё не помечен как установленный.');
  else add('installed', 'Состояние профиля', 'ok', 'Лаунчер отмечает профиль установленным.');
  return { ready: checks.every((item) => item.status === 'ok'), checkedAt: Date.now(), checks };
}

export async function repairProfile(profile: LauncherProfile, progress: Progress): Promise<ProfileCheckReport> {
  progress('repair', 0, 'Проверяем и восстанавливаем файлы профиля…');
  await ensureCompatibleJava(profile, (task, percent, message, done, error) => progress('repair', percent, message, done, error));

  let installedVersionId = profile.minecraftVersion;
  if (profile.loader === 'vanilla') {
    await ensureBaseVersion(profile, profile.minecraftVersion, (task, percent, message, done, error) => progress('repair', Math.min(90, percent), message, done, error), true);
  } else if (profile.loader === 'fabric') {
    installedVersionId = await installFabric(profile, (task, percent, message, done, error) => progress('repair', Math.min(88, percent), message, done, error), true);
  } else if (profile.loader === 'forge' || profile.loader === 'neoforge') {
    installedVersionId = await installOfficialInstaller(profile, (task, percent, message, done, error) => progress('repair', Math.min(92, percent), message, done, error), profile.loader, true);
  }

  await updateProfile(profile.id, { javaPath: profile.javaPath, installedVersionId, installed: true });
  const report = await diagnoseProfile({ ...profile, installedVersionId, javaPath: profile.javaPath, installed: true });
  const failures = report.checks.filter((item) => item.status === 'error');
  if (failures.length) {
    const details = failures.map((item) => `${item.label}: ${item.detail}`).join('\n');
    throw new Error(`Починка завершилась, но проверка нашла проблемы:\n${details}`);
  }
  progress('repair', 100, 'Сборка восстановлена. Проверка пройдена.', true);
  return report;
}

export async function listInstalledMods(profile: LauncherProfile) {
  const modsDir = path.join(profile.gameDir, 'mods');
  await mkdir(modsDir, { recursive: true });
  const files = await readdir(modsDir, { withFileTypes: true });
  const results = [];
  for (const entry of files) {
    if (!entry.isFile() || !/\.jar(?:\.disabled)?$/i.test(entry.name)) continue;
    const file = path.join(modsDir, entry.name);
    const info = await stat(file);
    const enabled = !entry.name.toLowerCase().endsWith('.disabled');
    results.push({ name: entry.name.replace(/\.jar(?:\.disabled)?$/i, ''), file: entry.name, enabled, size: info.size });
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function importModFiles(profile: LauncherProfile, files: string[]) {
  const modsDir = path.join(profile.gameDir, 'mods');
  await mkdir(modsDir, { recursive: true });
  const imported: string[] = [];
  for (const file of files) {
    if (path.extname(file).toLowerCase() !== '.jar') continue;
    const target = path.join(modsDir, path.basename(file));
    await copyFile(file, target);
    imported.push(path.basename(file));
  }
  return imported;
}

export async function toggleMod(profile: LauncherProfile, fileName: string, enabled: boolean) {
  const modsDir = path.join(profile.gameDir, 'mods');
  const source = safeJoin(modsDir, fileName);
  const targetName = enabled ? fileName.replace(/\.jar\.disabled$/i, '.jar') : fileName.replace(/\.jar$/i, '.jar.disabled');
  const target = safeJoin(modsDir, targetName);
  await renameSafe(source, target);
  return targetName;
}

async function renameSafe(source: string, target: string) {
  const fs = await import('node:fs/promises');
  await fs.rename(source, target);
}

export async function deleteMod(profile: LauncherProfile, fileName: string) {
  const target = safeJoin(path.join(profile.gameDir, 'mods'), fileName);
  await rm(target, { force: true });
}
