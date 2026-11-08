<h1 align="center">Moyu</h1>
<p align="center"><strong>把喜欢的漫画，留在自己的书库里。</strong></p>
<p align="center">本地优先的 Windows / Linux 桌面漫画阅读器。</p>
<p align="center">简体中文 · <a href="README.en.md">English</a></p>
<p align="center"><a href="https://d-onexxx.github.io/Moyu/"><strong>互动演示 ↗</strong></a> · <a href="https://github.com/D-OneXXX/Moyu/releases"><strong>下载 Moyu ↗</strong></a> · <a href="https://github.com/D-OneXXX/Moyu/issues">问题反馈</a></p>

## 阅读，从这里开始

- **本地书库**：整理文件夹、ZIP、CBZ 和本地 PDF；支持搜索、筛选和系列聚合。
- **自由阅读**：单页、双页、条漫、缩放与阅读方向；PDF 使用独立单页布局。
- **记住进度**：自动保存阅读位置，文件移动后可重新定位。
- **外观与语言**：明亮、深色或跟随系统，支持六种界面语言。
- **按需在线阅读**：使用你有权访问的在线地址；应用不内置在线漫画源。

[体验简化互动演示 →](https://d-onexxx.github.io/Moyu/)　也可在下载仓库后打开 [HTML 文件](public/demo/index.html)。演示为示意画面，不读取本地文件或保存进度。

## 下载与开始

从 [GitHub Releases](https://github.com/D-OneXXX/Moyu/releases) 获取安装包：Windows x64 使用安装器；Linux x86_64 提供 DEB、RPM 和 AppImage。两个平台的发布通道独立，具体版本与文件以 Release 页面为准。目前不提供 macOS 或 ARM64 构建。

Windows 安装器未做 Authenticode 代码签名，SmartScreen 可能显示警告；运行前请确认文件来自本仓库。应用更新包使用独立的签名校验。Linux 的 DEB / RPM 通过包管理器更新，AppImage 可使用应用内更新。

安装后选择「添加文件夹」或「添加书籍」，导入内容并打开阅读。加密 PDF 暂不支持。仓库源码中的局域网阅读和自建 OPDS 功能可能尚未包含在公开版本中，请以对应平台发行说明为准。

## 数据与隐私

书库数据和进度保存在本机，无需账号或云端书库。在线阅读和手动检查更新等功能会进行相应网络请求。`.mrbackup` 包含书库记录、进度及部分偏好，**不包含漫画源文件**；迁移时请另外复制文件。

Windows 默认数据目录为 `%APPDATA%\com.local.manga-reader`，缓存为 `%LOCALAPPDATA%\com.local.manga-reader`。部分安装器名称与数据目录仍保留 MangaReader 标识，以兼容已有安装。

## 反馈与开发

- [问题与建议](https://github.com/D-OneXXX/Moyu/issues) · [私下报告安全问题](https://github.com/D-OneXXX/Moyu/security/advisories/new) · [架构说明](docs/ARCHITECTURE.md)
- 分享日志或截图前，请移除个人路径、书名、Cookie、Token 和完整 URL。

<a id="development"></a>
### 从源码构建

需要 Node.js 22+、稳定版 Rust、Tauri 2 平台依赖，以及 Windows WebView2。

```bash
npm install
npm run tauri dev
npm run build
npm run check
```

`tauri dev` 会启动桌面窗口。`npm run build` 内置版本一致性检查，会校验 `package.json`、Tauri 配置、Cargo 与 lockfile。公开快照只包含核心产品源码与构建配置；完整 QA、发布和内部工程脚本不随公开仓提供。更多说明见 [英文开发说明](README.en.md#development)。

## 许可证

Moyu 使用 [PolyForm Noncommercial License 1.0.0](LICENSE)，允许个人及其他非商业用途，不授予商业使用权。项目源码可见，但不属于 OSI 定义的开源软件。参见 [NOTICE](NOTICE.md) 与 [第三方许可](THIRD_PARTY_NOTICES.md)。
