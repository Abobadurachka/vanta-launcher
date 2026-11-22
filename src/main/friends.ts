import dgram, { type RemoteInfo, type Socket } from 'node:dgram';
import os from 'node:os';
import { getFriendSettings, normalizeFriendCode } from './store';
import type { FriendsState, LauncherProfile } from './types';

const FRIEND_MULTICAST = '239.192.73.41';
const FRIEND_PORT = 47831;
const MINECRAFT_MULTICAST = '224.0.2.60';
const MINECRAFT_PORT = 4445;
const HEARTBEAT_MS = 2_500;
const PRESENCE_TTL_MS = 9_000;

interface ActiveGameContext {
  username: string;
  minecraftVersion: string;
  loader: LauncherProfile['loader'];
  loaderVersion: string;
}
interface PresencePacket {
  protocol: 'vanta-friends-v1';
  code: string;
  name: string;
  host: boolean;
  minecraftVersion?: string;
  loader?: LauncherProfile['loader'];
  loaderVersion?: string;
  port?: number;
  worldName?: string;
  sentAt: number;
}
interface PeerPresence extends PresencePacket {
  address: string;
  lastSeen: number;
}

let receiveSocket: Socket | null = null;
let sendSocket: Socket | null = null;
let minecraftSocket: Socket | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
let activeGame: ActiveGameContext | null = null;
let detectedPort: number | null = null;
let detectedWorld = '';
let detectedUntil = 0;
let manualPort: number | null = null;
let ownCode = '';
let serviceReady = false;
let discoveryMessage = 'Инициализация LAN-обнаружения…';
let onChange: ((state: FriendsState) => void) | null = null;
const peers = new Map<string, PeerPresence>();

function ownIpv4Addresses() {
  const found = new Set<string>(['127.0.0.1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) found.add(entry.address);
    }
  }
  return found;
}

export function isPrivateLanAddress(address: string) {
  if (address.startsWith('::ffff:')) address = address.slice(7);
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254 || a === 127;
}

function notifyChanged() {
  void getFriendsState().then((state) => onChange?.(state)).catch(() => undefined);
}

function parseMinecraftLanBeacon(message: Buffer) {
  const text = message.toString('utf8');
  const portMatch = text.match(/\[AD\](\d{1,5})\[\/AD\]/);
  if (!portMatch) return null;
  const port = Number(portMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const worldName = text.match(/\[MOTD\]([\s\S]*?)\[\/MOTD\]/)?.[1]?.replace(/§[0-9A-FK-OR]/gi, '').trim().slice(0, 80) || 'Minecraft LAN';
  return { port, worldName };
}

function handleMinecraftBeacon(message: Buffer, remote: RemoteInfo) {
  // Minecraft Java emits its LAN announcement on a local multicast group. Only accept
  // beacons sourced by this PC, otherwise another LAN host could be announced as us.
  if (!ownIpv4Addresses().has(remote.address) || !activeGame) return;
  const beacon = parseMinecraftLanBeacon(message);
  if (!beacon) return;
  detectedPort = beacon.port;
  detectedWorld = beacon.worldName;
  detectedUntil = Date.now() + 7_500;
  notifyChanged();
}

function isHosting() {
  if (!activeGame) return false;
  if (manualPort) return true;
  return Boolean(detectedPort && detectedUntil > Date.now());
}

function currentPort() {
  if (manualPort) return manualPort;
  return detectedUntil > Date.now() ? detectedPort : null;
}

async function sendPresence() {
  if (!sendSocket || !serviceReady) return;
  try {
    const settings = await getFriendSettings();
    ownCode = settings.myCodeRaw;
    const hosting = isHosting();
    const packet: PresencePacket = {
      protocol: 'vanta-friends-v1',
      code: settings.myCodeRaw,
      name: activeGame?.username || 'Vanta Player',
      host: hosting,
      minecraftVersion: activeGame?.minecraftVersion,
      loader: activeGame?.loader,
      loaderVersion: activeGame?.loaderVersion || '',
      port: hosting ? currentPort() || undefined : undefined,
      worldName: hosting ? (detectedWorld || 'LAN-мир') : undefined,
      sentAt: Date.now()
    };
    const payload = Buffer.from(JSON.stringify(packet), 'utf8');
    if (payload.length > 1_400) return;
    sendSocket.send(payload, FRIEND_PORT, FRIEND_MULTICAST, () => undefined);
  } catch { /* Discovery is optional and must never interrupt the launcher. */ }
}

function handleFriendPacket(message: Buffer, remote: RemoteInfo) {
  if (!isPrivateLanAddress(remote.address)) return;
  if (message.length > 1_400) return;
  let packet: PresencePacket;
  try { packet = JSON.parse(message.toString('utf8')) as PresencePacket; } catch { return; }
  if (packet.protocol !== 'vanta-friends-v1' || typeof packet.code !== 'string' || packet.code === ownCode) return;
  const age = Date.now() - Number(packet.sentAt);
  if (!Number.isFinite(age) || age < -5_000 || age > PRESENCE_TTL_MS) return;
  let code: string;
  try { code = normalizeFriendCode(packet.code); } catch { return; }
  const port = Number(packet.port);
  const host = Boolean(packet.host) && Number.isInteger(port) && port > 0 && port <= 65535;
  peers.set(code, {
    protocol: 'vanta-friends-v1',
    code,
    name: String(packet.name || 'Vanta Player').replace(/[\u0000-\u001f]/g, '').slice(0, 32),
    host,
    minecraftVersion: typeof packet.minecraftVersion === 'string' ? packet.minecraftVersion.slice(0, 32) : undefined,
    loader: ['vanilla', 'fabric', 'forge', 'neoforge'].includes(String(packet.loader)) ? packet.loader : undefined,
    port: host ? port : undefined,
    worldName: host ? String(packet.worldName || 'LAN-мир').slice(0, 80) : undefined,
    address: remote.address,
    lastSeen: Date.now(),
    sentAt: Number(packet.sentAt)
  });
  notifyChanged();
}

export async function getFriendsState(): Promise<FriendsState> {
  const settings = await getFriendSettings();
  const now = Date.now();
  const friends = settings.friends.map((friend) => {
    const peer = peers.get(friend.code);
    const online = Boolean(peer && now - peer.lastSeen <= PRESENCE_TTL_MS);
    const hosting = online && Boolean(peer?.host && peer.port && peer.address && isPrivateLanAddress(peer.address));
    return {
      code: friend.code,
      name: friend.name,
      online,
      hosting,
      minecraftVersion: online ? peer?.minecraftVersion : undefined,
      loader: online ? peer?.loader : undefined,
      loaderVersion: online ? peer?.loaderVersion : undefined,
      worldName: hosting ? peer?.worldName : undefined,
      address: hosting ? peer?.address : undefined,
      port: hosting ? peer?.port : undefined,
      lastSeen: online ? peer?.lastSeen : undefined
    };
  });
  return {
    myCode: settings.myCode,
    friends,
    lanDiscovery: serviceReady,
    discoveryMessage
  };
}

export function setActiveGameContext(profile: LauncherProfile, username: string) {
  activeGame = {
    username: String(username || 'Player').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Player',
    minecraftVersion: profile.minecraftVersion,
    loader: profile.loader,
    loaderVersion: profile.loaderVersion || ''
  };
  detectedPort = null;
  detectedWorld = '';
  detectedUntil = 0;
  manualPort = null;
  void sendPresence();
}

export function clearActiveGameContext() {
  activeGame = null;
  detectedPort = null;
  detectedWorld = '';
  detectedUntil = 0;
  manualPort = null;
  void sendPresence();
}

export function setManualLanPort(portValue: number | null) {
  if (portValue === null) {
    manualPort = null;
    void sendPresence();
    notifyChanged();
    return true;
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт должен быть числом от 1 до 65535.');
  if (!activeGame) throw new Error('Сначала запусти Minecraft через VANTA, открой мир и нажми «Открыть для сети».');
  manualPort = port;
  void sendPresence();
  notifyChanged();
  return true;
}

export async function startLanFriendService(onState: (state: FriendsState) => void) {
  onChange = onState;
  const settings = await getFriendSettings();
  ownCode = settings.myCodeRaw;
  if (receiveSocket || sendSocket) return;

  receiveSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  receiveSocket.on('message', handleFriendPacket);
  receiveSocket.on('error', (error) => {
    discoveryMessage = `Ошибка UDP-обнаружения друзей: ${error.message}`;
    serviceReady = false;
    notifyChanged();
  });
  receiveSocket.bind(FRIEND_PORT, '0.0.0.0', () => {
    try {
      receiveSocket?.addMembership(FRIEND_MULTICAST);
      receiveSocket?.setMulticastTTL(1);
      receiveSocket?.setMulticastLoopback(true);
      serviceReady = true;
      discoveryMessage = 'Автообнаружение друзей в локальной сети активно.';
      notifyChanged();
    } catch (error) {
      discoveryMessage = `Не удалось подключиться к multicast: ${error instanceof Error ? error.message : String(error)}`;
      serviceReady = false;
      notifyChanged();
    }
  });

  sendSocket = dgram.createSocket('udp4');
  sendSocket.on('error', (error) => {
    discoveryMessage = `Ошибка отправки LAN-сигнала: ${error.message}`;
    notifyChanged();
  });
  sendSocket.bind(() => {
    try { sendSocket?.setMulticastTTL(1); sendSocket?.setMulticastLoopback(true); } catch { /* socket may be unavailable */ }
  });

  // Listen to Minecraft's own LAN announcement. This lets the host publish the actual
  // ephemeral port generated by the in-game "Open to LAN" screen without asking the
  // player to copy it manually. If Windows blocks multicast, a manual port field remains.
  minecraftSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  minecraftSocket.on('message', handleMinecraftBeacon);
  minecraftSocket.on('error', () => {
    discoveryMessage = 'LAN-обнаружение VANTA работает, но автоматическое чтение Minecraft beacon недоступно. Можно указать порт вручную.';
    notifyChanged();
  });
  minecraftSocket.bind(MINECRAFT_PORT, '0.0.0.0', () => {
    try { minecraftSocket?.addMembership(MINECRAFT_MULTICAST); minecraftSocket?.setMulticastTTL(1); }
    catch {
      discoveryMessage = 'Не удалось включить автоопределение порта Minecraft. Можно указать порт вручную.';
      notifyChanged();
    }
  });

  heartbeat = setInterval(() => { void sendPresence(); }, HEARTBEAT_MS);
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [code, peer] of peers) if (now - peer.lastSeen > PRESENCE_TTL_MS) peers.delete(code);
    if (detectedUntil <= now && detectedPort) { detectedPort = null; detectedWorld = ''; }
    notifyChanged();
  }, 2_000);
  await sendPresence();
  notifyChanged();
}

export function stopLanFriendService() {
  if (heartbeat) clearInterval(heartbeat);
  if (cleanupTimer) clearInterval(cleanupTimer);
  heartbeat = null;
  cleanupTimer = null;
  for (const socket of [receiveSocket, sendSocket, minecraftSocket]) {
    try { socket?.close(); } catch { /* already closed */ }
  }
  receiveSocket = null;
  sendSocket = null;
  minecraftSocket = null;
  serviceReady = false;
}

export function getPeerForJoin(rawCode: string) {
  const code = normalizeFriendCode(rawCode);
  const peer = peers.get(code);
  if (!peer || Date.now() - peer.lastSeen > PRESENCE_TTL_MS || !peer.host || !peer.port) {
    throw new Error('Друг сейчас не открыл мир для локальной сети или не находится в той же сети Wi-Fi/LAN.');
  }
  if (!isPrivateLanAddress(peer.address)) throw new Error('VANTA разрешает подключение друзей только по адресу локальной сети.');
  return { address: peer.address, port: peer.port, minecraftVersion: peer.minecraftVersion, loader: peer.loader, loaderVersion: peer.loaderVersion, worldName: peer.worldName };
}
