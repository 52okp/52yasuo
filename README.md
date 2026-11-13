# 自动压缩工具

本地 Windows 桌面压缩工具，正式版本 **1.0.0**。使用 Electron 与 7-Zip，支持加密、文件名加密、自动分卷和完整性测试。

## 功能

- 拖入文件或文件夹，递归统计并合并压缩。
- 7z 格式、AES-256 加密、文件名加密。
- 密码在本地配置中明文保存，下次启动自动读取。
- 按文件总大小自动选择每卷容量，也可指定计划卷数重新计算；最终卷数受压缩率影响，至少两卷。
- 从文件名称提取关键词及 No 编号，一键填入压缩包名称。
- 自动或手动完整性测试、任务取消、进度与结果显示。
- 浅色双栏界面，融合式窗口标题栏。

## 开发

需要 Node.js 20 或更新版本及 npm；桌面和引擎集成测试以 Windows 为目标环境。

```powershell
npm ci
npm run desktop:dev
```

仅启动本地网页服务：

```powershell
$env:COMPRESS_ENGINE_PATH = (Resolve-Path 'vendor/7z.exe').Path
npm run dev
```

默认访问地址为 http://127.0.0.1:8765。资源管理器拖放需要桌面客户端，浏览器中可使用浏览或粘贴路径。

## 检查和测试

```powershell
npm run lint
npm run typecheck
$env:COMPRESS_ENGINE_PATH = (Resolve-Path 'vendor/7z.exe').Path
npm test
npm run test:desktop
```

桌面测试使用独立临时配置和测试文件，不读取用户密码。截图与测试结果写入 `output/verification/`。

## 构建

```powershell
npm run desktop:build
```

默认在 `release/` 中生成 Windows 安装版和单文件便携版，同时生成 `win-unpacked/` 目录。直接运行该目录中的程序时需保留整个目录。

单文件便携版每次启动会解包，启动速度优先时使用安装版或 `win-unpacked/`。

## 本地数据与第三方组件

- 桌面配置保存在 Electron 的用户数据目录中，密码不加密存储。
- `config.json`、`node_modules/`、`dist/`、`output/` 和 `release/` 不提交到仓库。
- 保留源文件；取消后已生成的压缩文件可能不完整，需要重新测试或重新压缩。
- `vendor/` 包含用于本工具的 7-Zip 二进制及其 [许可证](vendor/License.txt)。7-Zip 项目和源码见 https://www.7-zip.org/ 。
- 历史内部迭代记录见 [优化记录](优化记录.md)；本仓库首次正式提交统一使用 `1.0.0` 和 `v1.0.0` 标签。
