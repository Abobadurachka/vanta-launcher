# Стабильный канал автообновлений VANTA Launcher 1.4.0

## Канал релизов

VANTA Launcher 1.4.0 использует только стандартный стабильный канал `latest`.

- `autoUpdater.channel = 'latest'`
- `autoUpdater.allowPrerelease = false`
- GitHub: выбираются только релизы с `draft=false` и `prerelease=false`.
- Generic HTTPS: манифест называется `latest.yml`.
- Стабильная версия указывается чистым SemVer, например `1.4.0`.

## Публикация GitHub Release

1. Создай публичный GitHub-репозиторий.
2. Запусти `PUBLISH-GITHUB.bat`.
3. Укажи `owner/repository`.
4. Введи fine-grained GitHub token с правом Contents: Read and write для этого репозитория. Токен используется только в процессе публикации и не записывается в файлы проекта.
5. Скрипт `scripts/publish-github-release.cjs` соберёт Windows x64 NSIS, опубликует обычный Release с `channel: latest`, загрузит `latest.yml`, установщик и blockmap, затем обновит описание релиза содержимым `RELEASE_NOTES.md` и выставит `prerelease=false`.
6. Установи первый update-enabled установщик вручную. Дальнейшие стабильные релизы обнаруживаются при запуске приложения и по расписанию.

## Generic HTTPS

На указанном HTTPS-каталоге должен находиться `latest.yml`, а также установщик и `.blockmap`, перечисленные в манифесте. URL указывается с завершающим `/`. Не используй `beta.yml`.

## Важно

Скрипт публикации не может определить чужой репозиторий автоматически. Для каждого владельца/репозитория необходимо задать корректный публичный URL и собственный GitHub token. `PUBLISH-GITHUB.ps1` не сохраняет токен в проект и очищает переменные окружения после сборки.
