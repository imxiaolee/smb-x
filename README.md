# SMB X <sub><sup>[Homepage](https://mac.xiaolee.com/smbx/)</sup></sub>

English | [简体中文](README.zh-CN.md)

A lightweight, straightforward dual-pane SMB file manager for macOS and Windows.

![SMB X dual-pane file manager](assets/screenshot-demo.png)

## Features

- Browse local files and remote SMB shares side by side
- Upload, download, copy, and move files, with drag and drop between panes
- Filter the current folder by name, or drag files in from Finder / File Explorer
- Connect over SMB2/3, use custom ports and domain logins, and list available shares
- Bookmark servers and folders so you don't have to find your way back every time
- Track transfer progress and speed in a queue, cancel transfers, retry failures, and resolve filename conflicts
- Save passwords in macOS Keychain or Windows Credential Manager
- Use Simplified Chinese or English, following your system language by default
- Built with Tauri 2 and your system's WebView, without bundling another copy of Chromium

## Finding files and dropping them in

Press `A–Z` in the active file pane to select and scroll to a file or folder whose name starts with that letter, regardless of case. Press the same letter again to cycle through matches in the current order. If nothing matches, the selection stays where it is. With a filter active, this only searches the visible results. Typing in an input field won't trigger a jump.

Click the search icon beside either pane's address bar, or press `Cmd/Ctrl + F`, to filter the current folder by name as you type. Matching is case-insensitive and works with partial names; it doesn't search subfolders. Press `Esc`, close the filter, or navigate to another folder to clear it. While filtering, Select All only selects the visible results, so hidden files won't be included by accident.

Drag files or folders from Finder / File Explorer into the local or NAS pane. Drop them on an empty part of the list to copy them into the current folder, or onto a folder row to copy them into that subfolder. You can drop several files and folders at once. The originals stay in place, and filename conflicts appear in the transfer queue for confirmation. Drops aren't accepted while the folder is loading, while a dialog is open, or when the target is a symbolic link.

## Download

Get the latest version for your system from [GitHub Releases](https://github.com/imxiaolee/smb-x/releases/latest).

| Platform | File | How to install |
| --- | --- | --- |
| macOS 11+ / Apple Silicon | `.dmg` | Open the DMG and drag `SMB X.app` into Applications |
| Windows 10/11 x64 | `.zip` | Extract the ZIP and run `SMB X.exe`; no installation needed |

> There isn't an Intel Mac build at the moment.

### Opening on macOS for the first time

The app doesn't yet have an Apple Developer ID certificate for signing and notarization, so Gatekeeper may block it when you first open it.

After checking that you downloaded the app from this repository, drag `SMB X.app` into `/Applications`, then open Terminal and run:

```bash
xattr -dr com.apple.quarantine "/Applications/SMB X.app"
```

This removes the download quarantine flag. You can then open the app from Finder, or run:

```bash
open "/Applications/SMB X.app"
```

The `xattr` command bypasses the system's download quarantine check, so only use it for an app whose source you trust. On first use, macOS may also ask for access to Desktop, Documents, Downloads, or your local network. Allow access as needed.

### Windows

The Windows build is portable: extract the ZIP and run the app. It doesn't have a commercial code-signing certificate yet either.

The app needs [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Windows 11 usually includes it. If the app won't launch, try installing the runtime first.

## Verify your download

Each release includes `SHA256SUMS.txt`. To check a download's integrity, calculate its hash and compare it with the matching entry in that file.

macOS:

```bash
shasum -a 256 <filename>
```

Windows PowerShell:

```powershell
Get-FileHash <filename> -Algorithm SHA256
```

The hash should match the one listed in `SHA256SUMS.txt` for that file.

## Development

You'll need:

- Node.js 22
- Rust stable

Install dependencies and start the development environment:

```bash
npm ci
npm run tauri dev
```

Run the tests:

```bash
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

On macOS, install Xcode Command Line Tools.

On Windows, building requires Visual Studio's **Desktop development with C++** workload, the Windows SDK, and WebView2 Runtime.

## Known limitations

- macOS builds are currently available for Apple Silicon only
- Neither platform's downloads have paid code-signing certificates yet
- SMB1 isn't supported for security reasons
- Kerberos SSO, automatic SMB discovery on the local network, two-way file sync, and recursive search aren't supported yet

## License

SMB X is open source under the [MIT License](LICENSE).

Third-party components use their own open-source licenses. Their license files are included with each release.
