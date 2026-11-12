<h1 align="center">Moyu</h1>
<p align="center"><strong>Your manga, your own library.</strong></p>
<p align="center">A local-first desktop manga reader for Windows and Linux.</p>
<p align="center"><a href="README.md">简体中文</a> · English</p>
<p align="center"><a href="https://d-onexxx.github.io/Moyu/">Interactive demo ↗</a> · <a href="https://github.com/D-OneXXX/Moyu/releases">Download ↗</a> · <a href="https://github.com/D-OneXXX/Moyu/issues">Support</a></p>

## Features

- Organize folders, ZIP, CBZ, and local PDF documents in a local library.
- Read in single-page, double-page, or continuous layouts; PDFs use a single-page layout.
- Resume reading, relocate moved files, and choose from six languages and two themes.
- Open supported online pages you are authorized to access; no online manga sources are bundled.

The [HTML demo](https://d-onexxx.github.io/Moyu/) is an interactive illustration; it does not access your files or save progress. You can also open [the local HTML file](public/demo/index.html) after downloading the repository.

## Download and privacy

Get Windows x64 or Linux x86_64 packages from [GitHub Releases](https://github.com/D-OneXXX/Moyu/releases). Release channels are independent; macOS and ARM64 builds are not provided. The Windows installer is not Authenticode-signed and may trigger SmartScreen; verify its source. Updater packages use a separate signature. Update DEB/RPM packages using your package manager; AppImage can use the in-app updater.

Your library and progress stay on your device. Online reading and manual update checks make network requests. Backup files contain records, progress and selected preferences, **not the original comics**. Encrypted PDFs are not supported. The main branch may include unreleased features, including local-network reading and self-hosted OPDS; check the release notes for your platform.

<a id="development"></a>
## Development

Requirements: Node.js 22+, stable Rust, Tauri 2 platform dependencies, and WebView2 on Windows.

```bash
npm install
npm run tauri dev
npm run build
npm run test:demo
npx tsc --noEmit
cargo test --lib --manifest-path src-tauri/Cargo.toml
node tests/qa/run-qa.mjs --suite=static
```

`tauri dev` opens a desktop window. See [architecture](docs/ARCHITECTURE.md). Report bugs in [Issues](https://github.com/D-OneXXX/Moyu/issues) and vulnerabilities privately via [Security Advisories](https://github.com/D-OneXXX/Moyu/security/advisories/new). Remove personal paths, titles, cookies, tokens, and full URLs from shared logs.

## License

All versions of Moyu, including earlier releases, are available under the [MIT License](LICENSE). See [license history](docs/license-history.md) and [third-party notices](THIRD_PARTY_NOTICES.md). MIT applies only to project-owned content. The UnRAR component has its own terms, including restrictions on developing a RAR-compatible archiver or recreating the RAR compression algorithm; see the [UnRAR license](docs/licenses/unrar-rs.txt).
