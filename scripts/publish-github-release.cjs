#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const repository = String(process.env.VANTA_GITHUB_REPOSITORY || '').trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
  const match = repository.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9]))\/([A-Za-z0-9_.-]{1,100})$/);
  if (!match) {
    throw new Error('Сначала укажи VANTA_GITHUB_REPOSITORY в формате owner/repository через PUBLISH-GITHUB.bat.');
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    throw new Error('Не найден GH_TOKEN. Запусти PUBLISH-GITHUB.bat: он запросит токен локально и не сохранит его в проекте.');
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  if (!String(packageJson.version).includes('-')) {
    throw new Error(`Версия ${packageJson.version} не является Pre-Release. Для этого канала используй суффикс -beta.N.`);
  }

  const { build, Platform, Arch } = require('electron-builder');
  console.log(`\nVANTA RELEASE · ${packageJson.version}`);
  console.log(`GitHub repository: ${match[1]}/${match[2]}`);
  console.log('Сборка Windows x64 NSIS и публикация GitHub Pre-Release…\n');

  await build({
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'always',
    config: {
      publish: [{
        provider: 'github',
        owner: match[1],
        repo: match[2],
        releaseType: 'prerelease',
        channel: 'beta',
        private: false
      }]
    }
  });

  // electron-updater exposes the GitHub release body as info.releaseNotes.
  // Publish the project's release notes as that body after electron-builder uploads the assets.
  const releaseNotes = fs.readFileSync(path.join(__dirname, '..', 'RELEASE_NOTES.md'), 'utf8');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Vanta-Launcher-Release-Publisher'
  };
  const releasesResponse = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/releases?per_page=100`, { headers });
  if (!releasesResponse.ok) {
    throw new Error(`Установщик опубликован, но не удалось получить релиз для добавления RELEASE_NOTES.md (HTTP ${releasesResponse.status}).`);
  }
  const releases = await releasesResponse.json();
  const release = releases.find((item) => item.tag_name === `v${packageJson.version}` || item.tag_name === packageJson.version);
  if (!release) {
    throw new Error(`Установщик опубликован, но GitHub Release для версии ${packageJson.version} не найден; RELEASE_NOTES.md не прикреплён.`);
  }
  const patchResponse = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: releaseNotes, prerelease: true })
  });
  if (!patchResponse.ok) {
    throw new Error(`Установщик опубликован, но не удалось обновить описание релиза с RELEASE_NOTES.md (HTTP ${patchResponse.status}).`);
  }

  console.log('\nГотово: Pre-Release и RELEASE_NOTES.md опубликованы в GitHub Releases.');
  console.log('electron-updater передаст описание релиза в info.releaseNotes; VANTA покажет его в карточке обновления.');
  console.log('Установленные клиенты с этим же каналом проверят его при старте и далее каждые 10 минут.');
}

main().catch((error) => {
  console.error('\n[RELEASE ERROR]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
