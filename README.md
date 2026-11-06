<p align="center">
  <img src="docs/assets/logo.png" width="96" alt="Moyu 图标">
</p>

<h1 align="center">Moyu</h1>

<p align="center"><strong>把喜欢的漫画，留在自己的书库里。</strong></p>

<p align="center">
  一款本地优先的桌面漫画阅读器。<br>
  整理书库，打开漫画，从上次停下的地方继续阅读。
</p>

<p align="center">
  简体中文 · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/D-OneXXX/Moyu/releases"><strong>下载 Moyu ↗</strong></a>
  &nbsp; · &nbsp;
  <a href="#开始使用">开始使用</a>
  &nbsp; · &nbsp;
  <a href="#常见问题">常见问题</a>
  &nbsp; · &nbsp;
  <a href="https://github.com/D-OneXXX/Moyu/issues">问题反馈 ↗</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-x64-38A8F8?style=flat-square" alt="Windows x64">
  <img src="https://img.shields.io/badge/Linux-x86__64-38A8F8?style=flat-square" alt="Linux x86_64">
  <img src="https://img.shields.io/badge/许可-非商业使用-64748B?style=flat-square" alt="非商业使用许可">
</p>

<p align="center">
  <img src="public/demo/assets/real-library.png" width="88%" alt="Moyu 书库，展示四本 AI 生成的演示漫画">
  <br><sub>真实应用开发版截图 · 使用隔离书库与 AI 生成的示例漫画</sub>
</p>

---

<details>
<summary>查看真实阅读界面</summary>

![Moyu 阅读器中的演示漫画](docs/assets/screenshots/demo-reader.png)

</details>

## 让阅读回到简单

| 你的书库 | 舒适阅读 | 接着上次继续 |
| :--- | :--- | :--- |
| 整理文件夹、ZIP、CBZ 和本地 PDF，按系列浏览、搜索与筛选。 | 单页、双页、连续条漫、缩放与阅读方向，按自己的习惯选择。 | 自动记住阅读进度；本地文件移动后，可重新定位并保留已有进度。 |

- **本地优先**：无需账号或云端书库；书库数据与阅读进度保存在本机。
- **贴合习惯**：支持明亮、深色和跟随系统外观，以及六种界面语言。
- **按需在线阅读**：支持指定格式的在线页面和公开 Telegram 频道；不内置漫画源。

> PDF 使用独立的单页阅读布局，支持适应页面与宽度；不支持加密 PDF。

## 演示漫画

[查看轻量 HTML 演示源码](public/demo/index.html) · [预览演示页面](docs/assets/screenshots/demo-site.png) · 下载仓库后可直接在浏览器中打开；当前源码构建也可从「设置 → 关于与维护」进入。演示页展示的是简化交互。


用四份 AI 生成的示例漫画体验不同的阅读方式。前三部各含封面和一页正文；《木卫二的回声》包含封面和四页正文，可用于体验连续翻页。点击标题可获取 CBZ 文件，再从书库导入。

<table>
  <tr>
    <td align="center"><a href="public/demo/assets/sky-station.cbz"><img src="public/demo/assets/sky-cover.png" width="210" alt="黑白漫画：天空站与机械鸟"></a><br><a href="public/demo/assets/sky-station.cbz"><strong>天空站与机械鸟 ↓</strong></a><br><sub>黑白分镜 · 单页阅读</sub></td>
    <td align="center"><a href="public/demo/assets/rain-cafe.cbz"><img src="public/demo/assets/rain-cover.png" width="125" alt="彩色条漫：雨天咖啡馆"></a><br><a href="public/demo/assets/rain-cafe.cbz"><strong>雨天咖啡馆 ↓</strong></a><br><sub>彩色条漫 · 纵向阅读</sub></td>
    <td align="center"><a href="public/demo/assets/orbital-garden.cbz"><img src="public/demo/assets/orbital-cover.png" width="210" alt="彩色漫画：星轨温室"></a><br><a href="public/demo/assets/orbital-garden.cbz"><strong>星轨温室 ↓</strong></a><br><sub>彩色分镜 · 单页阅读</sub></td>
    <td align="center"><a href="public/demo/assets/europa-echo.cbz"><img src="public/demo/assets/europa-cover.png" width="210" alt="写实科幻漫画：木卫二的回声"></a><br><a href="public/demo/assets/europa-echo.cbz"><strong>木卫二的回声 ↓</strong></a><br><sub>写实科幻 · 多页阅读</sub></td>
  </tr>
</table>

示例仅用于演示，不代表应用内置漫画源。

## 下载 Moyu

<table>
  <tr><td><strong>Windows</strong><br>x64 · NSIS 安装器</td><td><strong>Linux</strong><br>x86_64 · DEB / RPM / AppImage</td></tr>
  <tr><td colspan="2" align="center"><a href="https://github.com/D-OneXXX/Moyu/releases"><strong>前往 GitHub Releases 选择安装包 →</strong></a></td></tr>
</table>

Windows 与 Linux 分别维护发布通道，版本和可用安装包请以 Releases 页面为准。目前不提供 macOS 或 ARM64 构建。

Windows 安装器未做 Authenticode 代码签名，SmartScreen 可能显示警告；运行前请确认文件来自本项目的 Releases 页面。应用内更新包使用独立的签名校验。Linux 的 DEB / RPM 安装通过包管理器更新；AppImage 可使用应用内更新。

## 开始使用

**01 · 安装**　从 Releases 下载适合系统的安装包并安装。

**02 · 添加**　在书库中选择「添加文件夹」或「添加书籍」，导入本地内容。

**03 · 阅读**　打开一本书，选择喜欢的阅读布局，Moyu 会记住你的进度。

在线内容由你自行提供，请只访问你有权访问的内容。

## 常见问题

<details>
<summary><strong>我的书库和阅读进度存在哪里？</strong></summary>
<br>

数据保存在本机。Windows 默认数据目录为 `%APPDATA%\com.local.manga-reader`，缓存目录为 `%LOCALAPPDATA%\com.local.manga-reader`；应用的「设置 → 存储与数据」也会显示实际位置。没有账号或云同步。

</details>

<details>
<summary><strong>Moyu 会联网吗？</strong></summary>
<br>

阅读本地漫画和 PDF 不需要上传书库。使用在线阅读或检查更新等网络功能时，应用需要进行相应的网络请求。在线会话请求头可选择仅驻留内存；全局请求头设置则是用户管理的持久化偏好。

</details>

<details>
<summary><strong>备份会包含漫画文件吗？</strong></summary>
<br>

不会。`.mrbackup` 保存书库记录、进度、统计和部分偏好，不包含漫画源文件或图片缓存。迁移时请另外复制源文件，并根据需要重新定位；备份不会保存在线请求头。

</details>

<details>
<summary><strong>为什么看到 MangaReader 这个名字？</strong></summary>
<br>

应用名称是 Moyu。为了兼容已有安装、数据和更新，部分安装器名称、文件关联与数据目录仍保留 MangaReader 标识。

</details>

<details>
<summary><strong>源码里的功能都会出现在下载版中吗？</strong></summary>
<br>

不一定。仓库主分支可能包含尚未发布的改动，例如局域网阅读和自建 OPDS 书库。请以相应平台的公开 Release 和发行说明为准；Windows 与 Linux 的发布节奏可能不同。

</details>

## 反馈与开发

- 发现问题或有建议：[提交 Issue](https://github.com/D-OneXXX/Moyu/issues)。提交日志或截图前，请移除个人路径、书名、Cookie、Token 和完整 URL。
- 发现安全问题：[私下提交安全报告](https://github.com/D-OneXXX/Moyu/security/advisories/new)。
- 想了解架构：[查看架构说明](docs/ARCHITECTURE.md)。

<a id="development"></a>
### 从源码构建

需要 Node.js 22+、稳定版 Rust 工具链，以及对应平台的 Tauri 2 构建依赖；Windows 还需要 WebView2。

```bash
npm install
npm run tauri dev
```

构建前端使用 `npm run build`，更多验证命令见 [英文开发说明](README.en.md#development)。`tauri dev` 会启动桌面窗口；请在适合交互操作的环境中运行。

## 许可证

Moyu 使用 [PolyForm Noncommercial License 1.0.0](LICENSE)，允许个人及其他非商业用途，不授予商业使用权。项目源码可见，但不属于 OSI 定义的开源软件。其他声明见 [NOTICE](NOTICE.md) 和 [第三方许可](THIRD_PARTY_NOTICES.md)。

<p align="center"><sub>不内置漫画源 · 你的内容，由你选择</sub></p>
