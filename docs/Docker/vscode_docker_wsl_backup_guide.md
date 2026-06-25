# VS Code 便携版、WSL、Dev Container、Docker 备份与 docker_data.vhdx 压缩整理文档

整理日期：2026-06-12  
环境：Windows + WSL2 + Docker Desktop + VS Code Dev Containers

本文档整理本次对话中的全部关键结论、命令、风险点与后续操作流程。目标是：

1. 兼容 Ubuntu 16.04、Ubuntu 18.04 与 Codex 的 VS Code 版本选择。
2. 使用 VS Code 便携版连接 WSL、Docker、Dev Container。
3. 在不丢失 Docker 容器可写层的前提下完整备份容器。
4. 解释 Docker 镜像、容器可写层、volume、bind mount、WSL 项目目录的区别。
5. 删除 `docker commit` 临时镜像后，压缩变大的 `docker_data.vhdx`。

---

## 1. VS Code 版本选择结论

你最初遇到的问题是 VS Code Dev Container / Remote 连接旧 Linux 时提示类似：

```text
Missing GLIBC >= 2.28
```

原因是旧 Ubuntu 的 glibc 版本较低。

| 系统 | glibc 版本 | 建议 VS Code 策略 |
|---|---:|---|
| Ubuntu 16.04 | 2.23 | 使用 VS Code 1.85.2 Portable |
| Ubuntu 18.04 | 2.27 | 使用 VS Code 1.98.2 Portable，避免升级到 1.99+ |
| Ubuntu 20.04 | 2.31 | 通常可用新版 VS Code |
| Ubuntu 22.04 | 2.35 | 推荐长期使用 |

### 1.1 Ubuntu 16.04 专用 VS Code

推荐：

```text
VS Code 1.85.2 Portable
```

建议目录：

```text
E:\VSCode-1.85.2-ubuntu1604\
  Code.exe
  data\
```

用途：

- 专门 Remote SSH 连接 Ubuntu 16.04。
- 不建议装 Codex。
- Remote - SSH 插件尽量使用旧版本。
- 关闭自动更新。

### 1.2 Ubuntu 18.04 + Codex 专用 VS Code

推荐：

```text
VS Code 1.98.2 Portable
```

建议目录：

```text
E:\VSCode-1.98.2-ubuntu1804-codex\
  Code.exe
  data\
```

用途：

- 连接 Ubuntu 18.04。
- 使用 WSL、Docker、Dev Containers。
- 安装 Codex 扩展。
- 不要升级到 VS Code 1.99+。

建议安装扩展：

```text
ms-vscode-remote.remote-ssh
ms-vscode-remote.remote-wsl
ms-vscode-remote.remote-containers
openai.chatgpt
```

建议在两个便携版中都关闭更新：

```json
{
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false
}
```

---

## 2. VS Code 便携版是否会和主 VS Code 冲突

只要便携版 `Code.exe` 同级目录存在 `data` 文件夹，一般不会和主 VS Code 冲突。

主 VS Code 通常使用：

```text
%APPDATA%\Code\User
%USERPROFILE%\.vscode\extensions
```

便携版使用自己的目录：

```text
E:\VSCode-1.98.2-ubuntu1804-codex\data\user-data
E:\VSCode-1.98.2-ubuntu1804-codex\data\extensions
```

推荐组合：

```text
主 VS Code：日常使用，新版，Codex 等
便携 VS Code 1.85.2：专门连接 Ubuntu 16.04
便携 VS Code 1.98.2：专门连接 Ubuntu 18.04 / WSL / Docker / Codex
```

---

## 3. 从 WSL 启动 VS Code 便携版

### 3.1 PowerShell 中启动

在 PowerShell 中要指向具体的 `Code.exe`，不能只写文件夹：

```powershell
& "E:\VSCode-1.98.2-ubuntu1804-codex\Code.exe" .
```

### 3.2 WSL 中启动

在 WSL 中建议这样启动，让 VS Code 正确进入 WSL Remote 上下文：

```bash
/mnt/e/VSCode-1.98.2-ubuntu1804-codex/Code.exe --remote "wsl+$WSL_DISTRO_NAME" "$(pwd)"
```

建议创建 `code198` 命令：

```bash
mkdir -p ~/bin

cat > ~/bin/code198 <<'EOF'
#!/usr/bin/env bash
TARGET="${1:-.}"
if [[ "$TARGET" != /* ]]; then
  TARGET="$(realpath -m "$TARGET")"
fi
/mnt/e/VSCode-1.98.2-ubuntu1804-codex/Code.exe --remote "wsl+$WSL_DISTRO_NAME" "$TARGET" >/dev/null 2>&1 &
EOF

chmod +x ~/bin/code198

grep -q 'export PATH="$HOME/bin:$PATH"' ~/.bashrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

以后在 WSL 项目目录中执行：

```bash
cd ~/workspace/v851s
code198 .
```

### 3.3 WSL 执行 Windows exe 报错

你遇到过：

```text
cannot execute binary file: Exec format error
```

这通常说明 WSL interop 有问题。测试：

```bash
notepad.exe
cmd.exe /c ver
```

如果失败，检查 `/etc/wsl.conf`：

```bash
cat /etc/wsl.conf
```

建议配置：

```ini
[interop]
enabled=true
appendWindowsPath=true
```

修改后在 PowerShell 中执行：

```powershell
wsl --shutdown
```

---

## 4. 打开 Dev Container 时如何避免可写层丢失

你担心的是：换成 VS Code 便携版打开 Docker / Dev Container，会不会导致之前容器的可写层数据丢失。

核心结论：

| 操作 | 风险 |
|---|---|
| `Dev Containers: Attach to Running Container...` | 最安全，附加到已有容器 |
| `docker start 容器ID` | 安全，只是启动已有容器 |
| `Reopen in Container` | 可能复用，也可能重新创建容器 |
| `Rebuild Container` | 有风险，会重建环境 |
| `Clean Up Dev Containers` | 有风险 |
| `docker rm 容器ID` | 会删除容器，可写层丢失 |
| `docker compose down -v` | 风险高，可能删容器和 volume |
| `docker system prune --volumes` | 风险很高 |

推荐流程：

```text
Ctrl + Shift + P
Dev Containers: Attach to Running Container...
```

选择已有容器。

---

## 5. 当前目标容器信息

你截图中第一个容器是：

```text
Container ID: 9d8f698a3030
Name: agitated_shtern
Image: gloomyghost/yuzukilizard:1.2
```

启动它：

```powershell
docker start 9d8f698a3030
```

然后在 VS Code 中选择：

```text
Dev Containers: Attach to Running Container...
agitated_shtern
```

不要优先选择 `Rebuild Container`。

---

## 6. 当前 devcontainer.json 与项目目录情况

你的 WSL 项目目录：

```text
/home/nopiskl/workspace/v851s
```

实际内容：

```text
~/workspace/v851s/
  .devcontainer/
    devcontainer.json
```

`devcontainer.json` 内容：

```json
{
    "name": "v851s",

    "image": "gloomyghost/yuzukilizard:1.2",

    "customizations": {
        "vscode": {
            "extensions": [
                "ms-vscode.cpptools-extension-pack"
            ]
        }
    }
}
```

这说明 `~/workspace/v851s` 只是 Dev Container 的启动壳，不是 SDK 本体。真正 SDK 在容器内部，例如：

```text
/root/...
/opt/...
/home/...
/usr/...
```

因此 attach 到容器后，如果要找 SDK，需要在容器里打开真正的 SDK 路径，而不是只看：

```text
/workspaces/v851s
```

---

## 7. 为什么 SDK Docker 会分布在 /root、/opt、/home

Docker 镜像不是一个单独的 SDK 压缩包，而是完整 Linux 文件系统快照。常见目录含义：

| 路径 | 用途 |
|---|---|
| `/root` | root 用户家目录，可能放 SDK、示例工程、脚本、构建缓存 |
| `/opt` | 第三方工具链、厂商 SDK、交叉编译器 |
| `/usr` | 系统命令、库、头文件、apt 安装的软件 |
| `/home` | 普通用户目录 |
| `/etc` | 系统配置 |
| `/workspaces/v851s` | WSL 项目目录挂载进容器的位置 |
| `/vscode` | VS Code Dev Containers 使用的 Docker volume |

所以 SDK 可能由多个部分组成：工具链、库、头文件、脚本、环境变量、示例工程，而不是单独一个 `/sdk` 目录。

---

## 8. 当前容器挂载信息解释

你执行过：

```powershell
docker inspect 9d8f698a3030 --format '{{ range .Mounts }}{{ .Type }}  {{ .Name }}  {{ .Source }} -> {{ .Destination }}{{ println }}{{ end }}'
```

结果：

```text
bind    /run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-20.04/... -> /tmp/vscode-wayland-d101d7e2-b9fa-47c9-a0e9-999022b720f6.sock
volume  vscode  /var/lib/docker/volumes/vscode/_data -> /vscode
bind    /home/nopiskl/workspace/v851s -> /workspaces/v851s
```

解释：

### 8.1 `/workspaces/v851s`

```text
bind /home/nopiskl/workspace/v851s -> /workspaces/v851s
```

这是 WSL 项目目录挂载。它不属于容器可写层，所以 `docker commit` 不会保存它。

### 8.2 `/vscode`

```text
volume vscode -> /vscode
```

这是 Docker volume，不属于容器可写层。它通常存放 VS Code Server、远程扩展、缓存等。它不会被 `docker commit` 保存，所以要单独备份。

### 8.3 `/tmp/vscode-wayland-xxx.sock`

这是临时 socket，不需要备份。

---

## 9. Docker 镜像、容器可写层、volume、bind mount 的区别

| 类型 | 例子 | 是否被 `docker commit` 保存 | 是否要单独备份 |
|---|---|---:|---:|
| 原始镜像层 | `gloomyghost/yuzukilizard:1.2` | 是，作为基础层 | 通过 `docker save` 保存 |
| 容器可写层 | `/root`、`/opt`、`/usr` 的后续改动 | 是 | 通过 `docker commit` + `docker save` |
| Docker volume | `/vscode` | 否 | 是 |
| bind mount | `/workspaces/v851s` | 否 | 是 |
| 临时 socket | `/tmp/vscode-wayland-xxx.sock` | 否 | 否 |

你的 SDK 如果在 `/root/...`、`/opt/...`，且这些路径不是挂载点，就属于镜像/容器文件系统，会被 `docker commit` 保存。

---

## 10. 完整备份流程

完整备份需要保存：

```text
1. 容器可写层：9d8f698a3030 / agitated_shtern
2. 镜像快照：docker commit 后 docker save
3. Docker volume：vscode -> /vscode
4. WSL 项目目录：/home/nopiskl/workspace/v851s -> /workspaces/v851s
5. 容器配置：docker inspect
```

### 10.1 完整备份脚本

假设备份目录在：

```text
F:\docker-backups
```

PowerShell 执行：

```powershell
$ErrorActionPreference = "Stop"

$ContainerId = "9d8f698a3030"
$ImageTag = "backup-v851s-before-vscode198:latest"
$VolumeName = "vscode"
$Distro = "Ubuntu-20.04"
$WslProjectParent = "/home/nopiskl/workspace"
$WslProjectName = "v851s"
$BackupRootWin = "F:\docker-backups"

$Time = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDirWin = Join-Path $BackupRootWin "v851s-$Time"
New-Item -ItemType Directory -Force $BackupDirWin | Out-Null

function ConvertTo-WslPath {
    param([string]$WinPath)
    $Full = [System.IO.Path]::GetFullPath($WinPath)
    $Drive = $Full.Substring(0,1).ToLower()
    $Rest = $Full.Substring(2).Replace("\","/")
    return "/mnt/$Drive$Rest"
}

$BackupDirWsl = ConvertTo-WslPath $BackupDirWin
Write-Host "Backup directory: $BackupDirWin"

docker inspect $ContainerId | Out-File "$BackupDirWin\container.inspect.json" -Encoding utf8

docker inspect $ContainerId --format '{{ range .Mounts }}{{ .Type }}  {{ .Name }}  {{ .Source }} -> {{ .Destination }}{{ println }}{{ end }}' |
    Out-File "$BackupDirWin\mounts.txt" -Encoding utf8

docker ps -a --no-trunc | Out-File "$BackupDirWin\docker-ps-a.txt" -Encoding utf8
docker images | Out-File "$BackupDirWin\docker-images.txt" -Encoding utf8
docker volume ls | Out-File "$BackupDirWin\docker-volumes.txt" -Encoding utf8
docker version | Out-File "$BackupDirWin\docker-version.txt" -Encoding utf8

docker commit $ContainerId $ImageTag | Out-File "$BackupDirWin\commit-image-id.txt" -Encoding utf8

docker image inspect $ImageTag | Out-File "$BackupDirWin\backup-image.inspect.json" -Encoding utf8

docker save -o "$BackupDirWin\backup-v851s-image.tar" $ImageTag

docker run --rm `
    -v "${VolumeName}:/volume:ro" `
    -v "${BackupDirWin}:/backup" `
    gloomyghost/yuzukilizard:1.2 `
    sh -lc "tar czf /backup/vscode-volume.tar.gz -C /volume ."

wsl -d $Distro bash -lc "mkdir -p '$BackupDirWsl' && tar czf '$BackupDirWsl/v851s-workspace.tar.gz' -C '$WslProjectParent' '$WslProjectName'"

Get-ChildItem $BackupDirWin -File |
    Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
    ForEach-Object { Get-FileHash $_.FullName -Algorithm SHA256 } |
    Format-Table -AutoSize |
    Out-File "$BackupDirWin\SHA256SUMS.txt" -Encoding utf8

Get-ChildItem $BackupDirWin
Write-Host "Backup finished: $BackupDirWin"
```

### 10.2 备份结果解释

你的实际备份目录：

```text
F:\docker-backups\v851s-20260612-173128
```

实际文件：

```text
backup-v851s-image.tar        34,779,577,344 bytes
vscode-volume.tar.gz          1,058,941,311 bytes
v851s-workspace.tar.gz        310 bytes
container.inspect.json        10,148 bytes
backup-image.inspect.json     3,505 bytes
mounts.txt                    335 bytes
docker-images.txt             413 bytes
docker-ps-a.txt               935 bytes
docker-version.txt            785 bytes
docker-volumes.txt            44 bytes
commit-image-id.txt           76 bytes
SHA256SUMS.txt                第一次生成失败，需要重新生成
```

解释：

| 文件 | 含义 |
|---|---|
| `backup-v851s-image.tar` | 最关键备份，包含原始镜像层 + 容器可写层 |
| `vscode-volume.tar.gz` | `/vscode` Docker volume 备份，不是可写层 |
| `v851s-workspace.tar.gz` | WSL 项目目录备份，很小是正常的，因为只有 `.devcontainer` |
| `container.inspect.json` | 原容器配置，恢复时很重要 |
| `mounts.txt` | 挂载摘要 |
| `docker-*.txt` | 备份时 Docker 环境记录 |

### 10.3 重新生成 SHA256 校验文件

第一次生成 SHA256 时失败，是因为脚本把正在写入的 `SHA256SUMS.txt` 自己也拿去计算哈希。

修正命令：

```powershell
Get-ChildItem "F:\docker-backups\v851s-20260612-173128" -File |
    Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
    ForEach-Object {
        Get-FileHash $_.FullName -Algorithm SHA256
    } |
    Format-Table -AutoSize |
    Out-File "F:\docker-backups\v851s-20260612-173128\SHA256SUMS.txt" -Encoding utf8
```

---

## 11. 可写层到底多大

用下面命令查看：

```powershell
docker ps -a -s --filter "id=9d8f698a3030"
```

或：

```powershell
docker inspect 9d8f698a3030 --size --format "SizeRw={{.SizeRw}} SizeRootFs={{.SizeRootFs}}"
```

字段含义：

| 字段 | 含义 |
|---|---|
| `SizeRw` | 容器可写层大小 |
| `SizeRootFs` | 容器完整 rootfs 视角大小，包括基础镜像 |

你执行 `docker system df -v` 后得到的关键信息：

```text
Images:
gloomyghost/yuzukilizard:1.2                                  12.5GB
registry.cn-hangzhou.aliyuncs.com/cld1994/tina-sdk:5.0-nori    15.5GB
alpine:3.16.3                                                  5.54MB

Containers:
9d8f698a3030 / agitated_shtern    21.9GB
7689fc4f48cc / admiring_lamarr    5.32GB

Local Volumes:
vscode                            1.485GB

Build cache: 0B
```

所以 v851s 环境大约：

```text
12.5GB 原始镜像
+ 21.9GB 容器可写层
+ 1.485GB vscode volume
≈ 35.9GB
```

因此 `backup-v851s-image.tar` 约 34.8GB 是合理的。

---

## 12. 删除 commit 后产生的本地备份镜像

你 commit 出来的镜像是：

```text
backup-v851s-before-vscode198:latest
```

确认：

```powershell
docker image ls backup-v851s-before-vscode198
```

删除：

```powershell
docker rmi backup-v851s-before-vscode198:latest
```

或：

```powershell
docker image rm backup-v851s-before-vscode198:latest
```

这只删除 Docker 内部的临时备份镜像，不会删除：

```text
原容器：9d8f698a3030 / agitated_shtern
原始镜像：gloomyghost/yuzukilizard:1.2
备份文件：F:\docker-backups\...\backup-v851s-image.tar
```

删除后确认：

```powershell
docker image ls backup-v851s-before-vscode198
```

没有输出即表示已删除。

---

## 13. 为什么删除镜像后磁盘空间没有立即回来

你观察到：

```text
commit 前剩余约 76GB
commit/save/rmi 后剩余约 39GB
Docker 文件夹约 116GB
docker_data.vhdx 变大很多
```

原因是 Docker Desktop + WSL2 使用 `docker_data.vhdx` 这类动态虚拟磁盘。

特点：

```text
数据写入时，vhdx 会增大。
删除 Docker 镜像后，Docker 内部空间可以复用。
但是 Windows 看到的 vhdx 文件不会自动缩小。
```

你 commit 时，Docker 内部临时产生了一个大镜像层，撑大了 `docker_data.vhdx`。后来删除 commit 镜像后，Docker 内部空间释放了，但 vhdx 文件外部大小仍然保持膨胀状态。

---

## 14. 当前 Docker 内部占用分析

`docker system df -v` 显示：

```text
v851s:
gloomyghost/yuzukilizard:1.2 镜像：12.5GB
agitated_shtern 容器可写层：21.9GB
vscode volume：1.485GB
合计约 35.9GB

tina-sdk:
registry.cn-hangzhou.aliyuncs.com/cld1994/tina-sdk:5.0-nori 镜像：15.5GB
admiring_lamarr 容器可写层：5.32GB
合计约 20.8GB
```

总计约：

```text
35.9GB + 20.8GB ≈ 56.7GB
```

如果 `docker_data.vhdx` 现在有约 116GB，则多出来的几十 GB 主要是虚拟磁盘膨胀后未 compact。

---

## 15. 不要乱 prune

不要执行：

```powershell
docker container prune
docker system prune -a
docker system prune --volumes
docker volume prune
```

原因：你的重要容器是停止状态：

```text
agitated_shtern    Exited
admiring_lamarr    Exited
```

`docker container prune` 会删除停止容器，可能直接丢失可写层。

`--volumes` 可能删除 `vscode` volume。

可以相对安全执行：

```powershell
docker image prune
docker builder prune
```

但你当前 Build cache 是 0B，所以清理效果有限。

---

## 16. 压缩 docker_data.vhdx 的完整步骤

目标：让膨胀的 `docker_data.vhdx` 缩小，把 Docker 内部已释放的空间还给 Windows。

### 16.1 确认 commit 镜像已删除

```powershell
docker image ls backup-v851s-before-vscode198
```

如果没有输出，表示删除成功。

查看 Docker 内部占用：

```powershell
docker system df -v
```

### 16.2 退出 Docker Desktop

右下角托盘：

```text
Docker Desktop -> Quit Docker Desktop
```

不要只是关闭窗口，要真正退出。

### 16.3 关闭 WSL

打开管理员 PowerShell：

```powershell
wsl --shutdown
```

查看是否还有相关进程：

```powershell
Get-Process *docker*, *wsl*, *vmmem* -ErrorAction SilentlyContinue
```

如果 Docker 相关进程还在：

```powershell
Get-Process "Docker Desktop","com.docker.backend" -ErrorAction SilentlyContinue | Stop-Process -Force
wsl --shutdown
```

### 16.4 找到 docker_data.vhdx

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Docker" -Recurse -Filter "docker_data.vhdx" |
    Select-Object FullName, @{Name="GB";Expression={[math]::Round($_.Length / 1GB, 2)}}
```

如果找不到：

```powershell
Get-ChildItem "$env:USERPROFILE" -Recurse -Filter "docker_data.vhdx" -ErrorAction SilentlyContinue |
    Select-Object FullName, @{Name="GB";Expression={[math]::Round($_.Length / 1GB, 2)}}
```

假设路径为：

```text
C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx
```

后面命令要替换成你的真实路径。

### 16.5 优先用 Optimize-VHD

管理员 PowerShell：

```powershell
Optimize-VHD -Path "C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx" -Mode Full
```

如果提示没有 `Optimize-VHD`，使用 `diskpart`。

### 16.6 使用 diskpart compact

管理员 PowerShell：

```powershell
diskpart
```

进入 `DISKPART>` 后逐行输入：

```text
select vdisk file="C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx"
attach vdisk readonly
compact vdisk
detach vdisk
exit
```

注意：

- 路径必须换成你的真实 `docker_data.vhdx` 路径。
- `compact vdisk` 可能需要几分钟到几十分钟。
- 期间不要启动 Docker Desktop。

### 16.7 检查压缩结果

```powershell
Get-Item "C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx" |
    Select-Object FullName, @{Name="GB";Expression={[math]::Round($_.Length / 1GB, 2)}}
```

然后启动 Docker Desktop，确认数据还在：

```powershell
docker ps -a
docker volume ls
docker image ls gloomyghost/yuzukilizard
docker system df -v
```

### 16.8 合理预期

你的 Docker 内部真实数据大概：

```text
v851s：约 35.9GB
tina-sdk：约 20.8GB
总计：约 56.7GB
```

所以 `docker_data.vhdx` 不可能压到几 GB。合理预期可能是：

```text
从约 116GB 降到约 60GB～70GB 附近
```

具体结果取决于文件系统碎片、Docker 元数据、compact 效果和磁盘状态。

---

## 17. 如果 compact 后仍然很大

重新查看：

```powershell
docker system df -v
```

如果 Docker 内部确实还有大镜像、大容器、大 volume，那么 vhdx 大是正常的。

如果 Docker 内部显示很小，但 vhdx 仍然很大，检查：

```text
1. Docker Desktop 是否真正退出。
2. 是否执行过 wsl --shutdown。
3. 选择的是否是真正的 docker_data.vhdx。
4. compact 过程是否完成。
5. Windows 是否有足够空闲空间。
```

---

## 18. 恢复备份的大致思路

### 18.1 恢复镜像

```powershell
docker load -i "F:\docker-backups\v851s-20260612-173128\backup-v851s-image.tar"
```

### 18.2 恢复 volume

```powershell
docker volume create vscode_restored

docker run --rm `
    -v "vscode_restored:/volume" `
    -v "F:\docker-backups\v851s-20260612-173128:/backup" `
    gloomyghost/yuzukilizard:1.2 `
    sh -lc "tar xzf /backup/vscode-volume.tar.gz -C /volume"
```

### 18.3 恢复 WSL 项目目录

```powershell
wsl -d Ubuntu-20.04 bash -lc "mkdir -p /home/nopiskl/workspace"

wsl -d Ubuntu-20.04 bash -lc "tar xzf /mnt/f/docker-backups/v851s-20260612-173128/v851s-workspace.tar.gz -C /home/nopiskl/workspace"
```

### 18.4 根据 inspect 恢复容器配置

恢复时查看：

```text
container.inspect.json
mounts.txt
```

里面记录原容器的镜像、启动命令、挂载、volume、环境变量、网络配置等。真正恢复时，应根据这两个文件写精确的 `docker run` 命令。

---

## 19. 最安全的后续操作建议

1. 保留备份目录：

```text
F:\docker-backups\v851s-20260612-173128
```

2. 不要删除原容器：

```text
9d8f698a3030 / agitated_shtern
```

3. 不要执行：

```powershell
docker container prune
docker system prune -a
docker system prune --volumes
docker volume prune
```

4. 用 VS Code 便携版连接容器时，优先：

```text
Dev Containers: Attach to Running Container...
```

5. 进入容器后打开真正 SDK 目录，例如：

```text
/root/...
/opt/...
```

6. 如果要回收 Windows 磁盘空间，使用 `docker_data.vhdx` compact，不要手动删除 Docker 文件夹或 vhdx 文件。

---

## 20. 常用命令速查

查看容器：

```powershell
docker ps -a
```

启动目标容器：

```powershell
docker start 9d8f698a3030
```

查看 Docker 空间：

```powershell
docker system df -v
```

查看挂载：

```powershell
docker inspect 9d8f698a3030 --format '{{ range .Mounts }}{{ .Type }}  {{ .Name }}  {{ .Source }} -> {{ .Destination }}{{ println }}{{ end }}'
```

查看容器可写层大小：

```powershell
docker inspect 9d8f698a3030 --size --format "SizeRw={{.SizeRw}} SizeRootFs={{.SizeRootFs}}"
```

删除 commit 备份镜像：

```powershell
docker rmi backup-v851s-before-vscode198:latest
```

查找 `docker_data.vhdx`：

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Docker" -Recurse -Filter "docker_data.vhdx" |
    Select-Object FullName, @{Name="GB";Expression={[math]::Round($_.Length / 1GB, 2)}}
```

压缩 `docker_data.vhdx`：

```powershell
wsl --shutdown
Optimize-VHD -Path "C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx" -Mode Full
```

或使用 diskpart：

```text
select vdisk file="C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx"
attach vdisk readonly
compact vdisk
detach vdisk
exit
```

---

## 21. 最终结论

你的情况可以总结为：

```text
1. v851s 的 WSL 项目目录只是 Dev Container 启动壳，不是 SDK 本体。
2. SDK 主要在 Docker 镜像和容器可写层中，例如 /root、/opt、/usr。
3. backup-v851s-image.tar 是最关键备份，包含原始镜像 + 21.9GB 可写层。
4. vscode-volume.tar.gz 是 /vscode volume 备份，不是可写层。
5. v851s-workspace.tar.gz 很小是正常的，因为项目目录只有 devcontainer.json。
6. 删除 commit 镜像后，Docker 内部空间可能释放，但 docker_data.vhdx 不会自动缩小。
7. 要让 Windows 磁盘空间回来，需要退出 Docker、wsl --shutdown，然后 compact docker_data.vhdx。
8. 后续连接容器时，优先 Attach to Running Container，不要随便 Rebuild 或 prune。
```
