import { app } from 'electron';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface AdminCredential {
  username: string;
  salt: string;
  passwordHash: string;
  createdAt: number;
}

const credentialPath = () => path.join(app.getPath('userData'), 'NebulaLauncher', 'developer-admin.json');
const SESSION_IDLE_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 60 * 1000;
let authenticatedUntil = 0;
let failedAttempts = 0;
let lockedUntil = 0;

async function readCredential(): Promise<AdminCredential | null> {
  try {
    const raw = await readFile(credentialPath(), 'utf8');
    const value = JSON.parse(raw) as Partial<AdminCredential>;
    if (typeof value.username !== 'string' || typeof value.salt !== 'string' || typeof value.passwordHash !== 'string') {
      throw new Error('Файл учётной записи разработчика повреждён. Удали developer-admin.json только если хочешь создать новую учётную запись.');
    }
    return value as AdminCredential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function validateCredentials(username: string, password: string) {
  const cleanUsername = username.trim();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) {
    throw new Error('Логин должен содержать 3–32 символа: латинские буквы, цифры, точку, дефис или подчёркивание.');
  }
  if (password.length < 10 || password.length > 128) {
    throw new Error('Пароль должен содержать от 10 до 128 символов.');
  }
  return cleanUsername;
}

function passwordHash(password: string, salt: string) {
  return scryptSync(password, Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 }).toString('base64');
}

export async function getAdminStatus() {
  const credential = await readCredential();
  return {
    configured: Boolean(credential),
    authenticated: Date.now() < authenticatedUntil,
    lockedForMs: Math.max(0, lockedUntil - Date.now())
  };
}

export async function setupAdmin(username: string, password: string) {
  const existing = await readCredential();
  if (existing) throw new Error('Учётная запись разработчика уже создана. Выполни вход.');
  const cleanUsername = validateCredentials(username, password);
  const salt = randomBytes(16).toString('base64');
  const credential: AdminCredential = {
    username: cleanUsername,
    salt,
    passwordHash: passwordHash(password, salt),
    createdAt: Date.now()
  };
  const file = credentialPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(credential, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  authenticatedUntil = Date.now() + SESSION_IDLE_MS;
  failedAttempts = 0;
  lockedUntil = 0;
  return { username: cleanUsername, sessionMinutes: SESSION_IDLE_MS / 60000 };
}

export async function loginAdmin(username: string, password: string) {
  if (password.length > 128 || username.length > 64) throw new Error('Неверный логин или пароль.');
  if (Date.now() < lockedUntil) {
    const seconds = Math.ceil((lockedUntil - Date.now()) / 1000);
    throw new Error(`Слишком много неудачных попыток. Повтори вход через ${seconds} сек.`);
  }
  const credential = await readCredential();
  if (!credential) throw new Error('Учётная запись разработчика ещё не создана.');

  const expected = Buffer.from(credential.passwordHash, 'base64');
  const actual = Buffer.from(passwordHash(password, credential.salt), 'base64');
  const userMatches = username.trim().toLowerCase() === credential.username.toLowerCase();
  const passMatches = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!userMatches || !passMatches) {
    failedAttempts += 1;
    if (failedAttempts >= 5) {
      failedAttempts = 0;
      lockedUntil = Date.now() + LOCKOUT_MS;
      throw new Error('5 неудачных попыток. Вход временно заблокирован на 60 секунд.');
    }
    throw new Error(`Неверный логин или пароль. Осталось попыток: ${5 - failedAttempts}.`);
  }

  failedAttempts = 0;
  lockedUntil = 0;
  authenticatedUntil = Date.now() + SESSION_IDLE_MS;
  return { username: credential.username, sessionMinutes: SESSION_IDLE_MS / 60000 };
}

export function requireAdmin() {
  if (Date.now() >= authenticatedUntil) {
    authenticatedUntil = 0;
    throw new Error('Сеанс разработчика истёк. Войди повторно.');
  }
  authenticatedUntil = Date.now() + SESSION_IDLE_MS;
}

export function logoutAdmin() {
  authenticatedUntil = 0;
}
