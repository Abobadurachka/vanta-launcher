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

  console.log('\nГотово: Pre-Release опубликован в GitHub Releases.');
  console.log('Установленные клиенты с этим же каналом проверят его при старте и далее каждые 10 минут.');
}

main().catch((error) => {
  console.error('\n[RELEASE ERROR]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
