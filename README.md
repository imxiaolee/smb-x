# SMB X

轻量、简洁的 macOS / Windows 双栏 SMB 文件管理与传输工具。

![SMB X 双栏文件管理界面](assets/screenshot-demo.png)

## 功能

* 双栏浏览本地文件与 SMB 共享
* 支持上传、下载、复制、移动和跨栏拖拽
* 支持 SMB2/3、自定义端口、Domain 和共享枚举
* 支持服务器及目录收藏
* 支持传输进度、速度、取消、失败重试和同名文件处理
* 密码可安全保存在 macOS Keychain / Windows Credential Manager
* 支持简体中文、English 和跟随系统
* 基于 Tauri 2，使用系统 WebView，无需内置 Chromium

## 下载

请前往 [GitHub Releases](https://github.com/imxiaolee/smb-x/releases/latest) 下载最新版本。

| 平台                        | 文件     | 安装方式                                 |
| ------------------------- | ------ | ------------------------------------ |
| macOS 11+ / Apple Silicon | `.dmg` | 打开 DMG，将 `SMB X.app` 拖入 Applications |
| Windows 10/11 x64         | `.zip` | 解压后直接运行 `SMB X.exe`，无需安装             |

> 当前暂不提供 Intel Mac 版本。

### macOS 首次打开

当前 macOS 版本尚未经过 Apple Developer ID 签名和 Apple 公证（Notarization），下载后可能被 Gatekeeper 阻止。

确认应用下载自本仓库后，将 `SMB X.app` 放入 `/Applications`，打开终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/SMB X.app"
```

然后即可从 Finder 正常打开，也可以执行：

```bash
open "/Applications/SMB X.app"
```

`xattr` 命令会移除该应用的下载隔离标记，请仅对可信来源的应用使用。

macOS 首次使用时可能请求访问桌面、文稿、下载目录或局域网，请根据实际需要授权。

### Windows

Windows 版本为免安装版，解压 ZIP 后即可运行。

应用依赖 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。Windows 11 通常已经包含；如果无法启动，请先安装 WebView2 Runtime。

当前 Windows 版本尚未进行代码签名。

## 校验下载

Release 同时提供 `SHA256SUMS.txt`。

macOS：

```bash
shasum -a 256 <文件名>
```

Windows PowerShell：

```powershell
Get-FileHash <文件名> -Algorithm SHA256
```

计算结果应与 `SHA256SUMS.txt` 中对应文件的哈希一致。

## 开发

需要：

* Node.js 22
* Rust stable

安装依赖并启动：

```bash
npm ci
npm run tauri dev
```

运行测试：

```bash
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

macOS 需要 Xcode Command Line Tools。

Windows 构建需要 Visual Studio 的 **Desktop development with C++** 工作负载、Windows SDK 和 WebView2 Runtime。

## 已知限制

* 目前仅提供 Apple Silicon 版 macOS 应用
* macOS / Windows 安装包目前均未进行正式代码签名
* 不支持 SMB1
* 暂不支持 Kerberos SSO、SMB 自动发现、文件同步和搜索


## License

本项目采用 [MIT License](LICENSE)。

第三方组件遵循各自的开源许可证，相关许可文件随 Release 一同提供。
