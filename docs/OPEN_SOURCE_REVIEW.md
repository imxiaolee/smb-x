# 公共发布检查记录（2026-09-16）

## 范围与结果

- 当前交付目录原本没有 `.git`，本次建立全新公共历史；没有迁入旧开发仓库或旧提交身份。旧文档对历史扫描的描述不适用于这个目录，已移除。
- 人工检查应用源码、配置、脚本和文档，并搜索常见令牌、密钥、密码赋值、凭据 URL、邮箱、内网地址和个人绝对路径。未发现真实凭据、私钥、签名证书、个人邮箱或真实服务器配置。静态检查不能保证不存在未识别的敏感内容。
- 密码字段属于运行时凭据处理；测试中的带凭据 SMB URL 是固定拒绝用例。`/Users/demo`、`/Users/me` 为演示或测试路径；`127.0.0.1` 和 `ipc.localhost` 用于本地开发 / Tauri IPC。系统工具路径为 macOS API 调用，不是开发者路径。
- 普通设置 JSON 只序列化连接元数据和收藏，密码进入系统 Keychain / Credential Manager 或内存；系统安全存储失败不会降级到明文文件。
- 产品截图经过内置 imagegen 编辑脱敏，仅保留中性示例路径、服务器名和文件列表。原始截图不进入仓库。图像编辑提示摘要：保留双栏布局和中文界面，以 `demo`、`nas.example`、Documents / Images / Projects 等替换用户名、内网 IP、业务文件名和日期。成品位于 `assets/screenshot-demo.png`。

## 提交与发布边界

- 需求原件、本机配置、环境文件、证书、IDE 缓存、生成 schema、依赖目录、编译目录及安装包均由 `.gitignore` 排除。
- 提交 npm / Cargo 锁文件；构建产物只进入 Actions Artifacts 和 GitHub Releases。
- 提交作者使用 GitHub noreply 邮箱。
- 普通分支 push / PR 不触发 Actions。仅 `v*` 标签与手动操作触发，版本必须与源码一致。
- 手动运行只验证并上传 Artifacts；正式标签运行须双平台成功后上传至草稿，再公开完整 Release。
- 使用固定提交版本的 GitHub 官方 Actions。默认 `contents: read`，只有汇总发布任务使用 `contents: write`。无外部签名证书或密码。

## 许可证

- 项目按维护者要求采用 MIT；根目录提供完整 LICENSE。
- 未直接复制第三方源码进入项目。Tauri、Rust crates、Lucide 等以锁文件依赖引入。
- `scripts/third-party-notices.py` 从 Cargo 依赖元数据和已安装 npm 包收集声明、LICENSE / COPYING / NOTICE / AUTHORS 等文本。包含构建和测试依赖，范围可能大于最终二进制；清单随各平台包和 Release 附件发布。
- 依赖许可表达式和未包含单独许可文件的组件会出现在构建日志中，首次构建需核对；不能仅凭项目 MIT 标签推定依赖都采用 MIT。

## 验证记录与限制

- 本地前端 11 项单元测试通过。Rust 编译、测试、原生打包及包启动检查由 macOS ARM64 / Windows x64 runner 执行，结果以仓库对应 Actions run 为准。
- macOS 检查 ad-hoc 签名、DMG 完整性、挂载复制和应用进程启动；Windows 检查 ZIP 解压和进程启动。这些检查不等于人工界面或 NAS 功能验收。
- 真实 NAS、系统凭据读写和 macOS 隐私授权仍需按照 [验收清单](ACCEPTANCE.md) 测试。
