<div align="center">

<img src="docs/media/harbor-mark.svg" width="72" alt="Harbor">

# Harbor App

A Stremio client for Android.

<a href="https://github.com/Sultan-it-1/Harbor-App/releases/latest/download/harbor-android.apk"><img alt="Download for Android" src="https://img.shields.io/badge/Download-Android%20APK-3DDC84?style=for-the-badge&logo=android&logoColor=white"></a>

<sub><a href="docs/GUIDE.md">دليل الاستخدام (Guide)</a> · <a href="https://github.com/Sultan-it-1/Harbor-App/releases">All releases</a> · <a href="https://github.com/Sultan-it-1/Harbor-App/issues">Issues</a></sub>

</div>

## Features

- Native screens: home, discover, movies, shows, anime, library, title pages, search, Live TV, calendar, downloads, addons and the source picker.
- Native player (ExoPlayer) with FFmpeg audio, so Dolby / DTS tracks play with sound.
- Addon subtitles with adjustable size, background, colour, position and delay.
- Downloads run in the background (movies, episodes and whole seasons) and play offline, with their subtitles.
- Watched marks on posters and episodes, from Harbor's history, your Stremio library and Trakt.
- Arabic and English.

## Install

1. Download [`harbor-android.apk`](https://github.com/Sultan-it-1/Harbor-App/releases/latest/download/harbor-android.apk) on your phone.
2. Open it and allow "install from unknown sources" when asked.

Each release is signed with the same key, so a new version installs over the previous one.

New to Harbor? Read the step-by-step guide (Arabic): [docs/GUIDE.md](docs/GUIDE.md).

## Development

```bash
pnpm install
pnpm dev            # web UI at http://localhost:1420
```

Android APK (needs the Android SDK and JDK 17):

```bash
pnpm build
cd android && ./gradlew assembleRelease
```

| Path | What |
| --- | --- |
| `src/` | React UI |
| `android/` | Android app: native screens, player, subtitles, downloads |
| `relay/` | Optional Watch Together relay (see Settings → Watch Together relay) |

A release is published when the version in `package.json` changes on `main`.

## Credits

Harbor App is based on [Harbor](https://github.com/Harborofficial/Harbor) by its original developers, used under the MIT license.

## Disclaimer

Harbor hosts no media and ships no content addons. You choose which addons and sources to use and are responsible for complying with the laws where you live. Not affiliated with Stremio.

## License

[MIT](./LICENSE)
