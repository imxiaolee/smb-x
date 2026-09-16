SMB X 首个公共版本：macOS / Windows 双栏 SMB 文件管理与传输工具。

- macOS Apple Silicon：下载 `SMB-X-v1.0.0-macOS-arm64.dmg`，将 `SMB X.app` 拖到 Applications。
- Windows x64：下载 `SMB-X-v1.0.0-Windows-x64.zip`，解压后运行 `SMB-X/SMB X.exe`。需要 Microsoft Edge WebView2 Runtime。
- 提供 `SHA256SUMS.txt` 与双平台第三方许可清单。

macOS 当前仅 ad-hoc 签名，未经 Apple Developer ID 签名和公证。确认下载来自本仓库、校验文件后，如果系统阻止启动，可执行：

```bash
xattr -dr com.apple.quarantine "/Applications/SMB X.app"
open "/Applications/SMB X.app"
```

Windows 未进行代码签名。此版本尚未完成真实 NAS、系统凭据存储及 macOS 人工交互验收，首次使用请在测试目录操作；已知功能边界见 README。采用 MIT 开源协议，详见 LICENSE。
