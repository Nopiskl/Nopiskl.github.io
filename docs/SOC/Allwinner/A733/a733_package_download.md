# A733 构建时包下载分析

这篇文档分析 `rsdk build radxa-a733` 在构建镜像时，A733 相关包是怎样被下载进来的。

重点回答 4 个问题：

1. 构建时到底用了哪些 APT 源？
2. 是谁在真正执行下载？
3. `task-radxa-a733`、`linux-image-radxa-a733`、`u-boot-radxa-a733` 这些包之间是什么关系？
4. 在 Windows 和 Linux 环境里，怎样直接获取这些包的信息和包体？

```admonish info
下面文中的在线仓库示例，已经在 2026-04-17 实际验证过。
```

## 一句话结论

`radxa-a733` 构建时，真正下载包的不是 `rsdk-build` 自己，而是它生成配置后调用的 `bdebstrap/mmdebstrap` 里的 `apt-get`。

A733 至少会同时使用下面两个 Radxa APT 源：

```text
deb https://radxa-repo.github.io/bullseye bullseye main
deb https://radxa-repo.github.io/a733-bullseye a733-bullseye main
```

其中：

- `bullseye` 仓库主要提供通用的 Radxa 包，比如 `task-radxa-a733`、`radxa-firmware`、`radxa-udev`、`rsetup-config-first-boot`。
- `a733-bullseye` 仓库主要提供 A733 SoC 专属包，比如 `u-boot-radxa-a733`、`linux-image-radxa-a733`、`linux-headers-radxa-a733`。

## 1. 构建入口在哪里

构建入口在 `src/libexec/rsdk/rsdk-build`。

这个脚本会先把 Jsonnet 配置生成成 `rootfs.json`，然后把它交给 `bdebstrap`：

```bash
jsonnet "${JSONNET_ARGS[@]}" "$SCRIPT_DIR/../../share/rsdk/build/rootfs.jsonnet" -o "$RSDK_TEMP/rootfs.json"
sudo bdebstrap "${BDEBSTRAP_ARGS[@]}" -c "$RSDK_TEMP/rootfs.json" --name "$OUTPUT" --force
```

对应源码：

- `src/libexec/rsdk/rsdk-build`
- `src/share/rsdk/build/rootfs.jsonnet`

`radxa-a733` 这个产品在 `src/share/rsdk/configs/products.json` 里定义为：

- 产品名：`radxa-a733`
- SoC：`a733`
- 默认 suite：`bullseye`
- 默认 edition：`kde`

也就是说，默认命令：

```bash
rsdk build radxa-a733
```

等价于：

```bash
rsdk build radxa-a733 bullseye kde
```

## 2. rootfs 配置是怎么拼起来的

`rootfs.jsonnet` 会把 4 块内容合并起来：

```jsonnet
distro(...)
+ additional_repos(...)
+ packages(...)
+ cleanup()
```

可以简单理解成：

- `distro(...)`：加 Debian 或 Ubuntu 基础源。
- `additional_repos(...)`：加 Radxa 仓库、本地仓库、`pkgs.json`。
- `packages(...)`：声明要安装哪些包。
- `cleanup()`：构建结束后的清理动作。

所以包下载的核心路径其实是：

1. `rsdk-build` 生成 `rootfs.json`
2. `bdebstrap/mmdebstrap` 读取 `rootfs.json`
3. `apt-get update`
4. `apt-get install` / `apt-get full-upgrade`
5. APT 从 Debian 和 Radxa 仓库下载 `.deb`

## 3. A733 会添加哪些仓库

### 3.1 Debian 基础源

`src/share/rsdk/build/mod/distro.libjsonnet` 会先生成 Debian Bullseye 的基础源，并自动派生出：

- `bullseye`
- `bullseye-updates`
- `bullseye-backports`
- `bullseye-security`

也就是说，基础系统包先从 Debian 官方源来。

### 3.2 A733 的两个 Radxa 源

`src/share/rsdk/build/mod/additional_repos.libjsonnet` 会根据产品 SoC 决定要不要加 SoC 专属仓库。

A733 在 `src/share/rsdk/configs/socs.json` 里属于：

- `soc_family = "allwinner"`
- `soc_specific_repo = ["a527", "a733"]`

所以 `radxa-a733` 构建时会写入下面两个源：

```text
deb https://radxa-repo.github.io/bullseye bullseye main
deb https://radxa-repo.github.io/a733-bullseye a733-bullseye main
```

对应关键源码：

```jsonnet
echo deb %(radxa_url)s%(product_soc)s-%(suite)s %(product_soc)s-%(suite)s main > "$1/etc/apt/sources.list.d/80-radxa-%(product_soc)s.list"

echo deb %(radxa_url)s%(suite)s %(suite)s main > "$1/etc/apt/sources.list.d/70-radxa.list"
```

## 4. 真正执行下载的是谁

真正执行下载的是 `mmdebstrap` 阶段里的 APT。

`additional_repos.libjsonnet` 会在 hook 里执行：

```sh
APT_CONFIG="$MMDEBSTRAP_APT_CONFIG" \
apt-get update -oDPkg::Chroot-Directory="$1"
```

然后 `core.libjsonnet` 继续执行多次安装：

```sh
apt-get install ... gcc rsetup radxa-bootutils python-is-python3 initramfs-tools zstd
apt-get install ... %(firmware)s-%(firmware_override)s linux-headers-%(linux_override)s
apt-get install ... linux-image-%(linux_override)s
apt-get install ... %(recommends)s task-%(product)s
apt-get full-upgrade ...
```

对 `radxa-a733` 代入默认值后，关键包会变成：

- `u-boot-radxa-a733`
- `linux-headers-radxa-a733`
- `linux-image-radxa-a733`
- `task-radxa-a733`

## 5. A733 的包是怎样一级级被拉进来的

这一段最关键。

很多人第一次看会以为：

- 下载了 `linux-image-radxa-a733`
- 就等于下载了真正的内核

但实际上，`linux-image-radxa-a733` 本身是一个很小的元包，真正的大文件是它依赖到的底层内核包。

### 5.1 从主仓库 `bullseye` 进来的包

在线仓库验证结果：

#### `task-radxa-a733`

```text
Package: task-radxa-a733
Version: 0.4.44
Depends: radxa-system-config, radxa-system-config-kernel-cmdline-ttyas0, radxa-system-config-aic8800-usb-dkms
Recommends: task-a733
Filename: pool/main/r/radxa-profiles/task-radxa-a733_0.4.44_all.deb
```

说明：

- `task-radxa-a733` 是主入口元包。
- 它自己不大，主要作用是把 A733 需要的配置包和 vendor 任务包串起来。
- 它推荐安装 `task-a733`。

#### `task-a733`

```text
Package: task-a733
Version: 0.2.8
Depends: task-allwinner, task-a733-camera, task-a733-xorg, img-bxm-dkms
Recommends: task-a733-vpu
Filename: pool/main/a/allwinner-profiles/task-a733_0.2.8_all.deb
```

说明：

- `task-a733` 才是 Allwinner A733 的 vendor 栈入口。
- 它继续把显示、相机、驱动等组件拉进来。
- `img-bxm-dkms` 这样的驱动包，也是在这条链上被带进来的。

#### 其他通用 Radxa 包

```text
Package: radxa-firmware
Version: 0.2.29
Filename: pool/main/r/radxa-firmware/radxa-firmware_0.2.29_all.deb
```

```text
Package: radxa-udev
Version: 0.1.4
Filename: pool/main/r/radxa-udev/radxa-udev_0.1.4_all.deb
```

```text
Package: rsetup-config-first-boot
Version: 0.4.27
Depends: rsetup (= 0.4.27), btrfs-progs
Filename: pool/main/r/rsetup/rsetup-config-first-boot_0.4.27_all.deb
```

### 5.2 从专属仓库 `a733-bullseye` 进来的包

#### `u-boot-radxa-a733`

```text
Package: u-boot-radxa-a733
Version: 2018.07-15
Depends: u-boot-aw2501
Filename: pool/main/u/u-boot-aw2501/u-boot-radxa-a733_2018.07-15_all.deb
```

#### `u-boot-aw2501`

```text
Package: u-boot-aw2501
Version: 2018.07-15
Filename: pool/main/u/u-boot-aw2501/u-boot-aw2501_2018.07-15_all.deb
Size: 1030928
```

说明：

- `u-boot-radxa-a733` 是元包。
- 真正带有 U-Boot 内容的是 `u-boot-aw2501`。

#### `linux-headers-radxa-a733`

```text
Package: linux-headers-radxa-a733
Version: 5.15.147-18
Depends: linux-headers-5.15.147-18-a733
Filename: pool/main/l/linux-a733/linux-headers-radxa-a733_5.15.147-18_all.deb
```

#### `linux-headers-5.15.147-18-a733`

```text
Package: linux-headers-5.15.147-18-a733
Version: 5.15.147-18
Filename: pool/main/l/linux-upstream/linux-headers-5.15.147-18-a733_5.15.147-18_arm64.deb
Size: 7760724
```

说明：

- `linux-headers-radxa-a733` 是元包。
- 真正的头文件大包是 `linux-headers-5.15.147-18-a733`。

#### `linux-image-radxa-a733`

```text
Package: linux-image-radxa-a733
Version: 5.15.147-18
Depends: radxa-overlays-dkms, linux-image-5.15.147-18-a733
Filename: pool/main/l/linux-a733/linux-image-radxa-a733_5.15.147-18_all.deb
```

#### `linux-image-5.15.147-18-a733`

```text
Package: linux-image-5.15.147-18-a733
Version: 5.15.147-18
Filename: pool/main/l/linux-upstream/linux-image-5.15.147-18-a733_5.15.147-18_arm64.deb
Size: 18915388
```

说明：

- `linux-image-radxa-a733` 也是元包。
- 真正的大内核包是 `linux-image-5.15.147-18-a733`。
- 它还会顺带依赖 `radxa-overlays-dkms`。

## 6. 下载链条总结

把上面合起来，可以得到一条更直观的链：

```text
rsdk build radxa-a733
-> rsdk-build 生成 rootfs.json
-> bdebstrap/mmdebstrap 执行 apt-get
-> 从 bullseye 和 a733-bullseye 两个 Radxa 源取包
-> 安装 task-radxa-a733
-> task-radxa-a733 推荐 task-a733
-> task-a733 继续拉入 A733 的显示/相机/驱动栈
-> 同时安装 linux-image-radxa-a733 / linux-headers-radxa-a733 / u-boot-radxa-a733
-> 这些元包再依赖到真正的大包
   - linux-image-5.15.147-18-a733
   - linux-headers-5.15.147-18-a733
   - u-boot-aw2501
```

## 7. `pkgs.json` 是干什么的

`additional_repos.libjsonnet` 里还有下面这些动作：

```jsonnet
wget -O "$1/etc/rsdk/80-radxa-a733.pkgs.json" ...
wget -O "$1/etc/rsdk/70-radxa.pkgs.json" ...
curl -L -o "$1/etc/radxa_apt_snapshot" ...
```

它们的作用是把仓库元数据快照放进镜像里，便于追溯和复现。

需要注意：

- `pkgs.json` 不是实际 `.deb` 包体。
- 真正的 `.deb` 下载，仍然是 APT 根据 `Packages` / `Release` 索引完成的。

## 8. Windows 和 Linux 里怎样直接获取这些包

这一节只讲最直接、最容易复现的方法。

### 8.1 先拿索引文件

#### Linux

```bash
curl -L -o bullseye.Packages \
  https://radxa-repo.github.io/bullseye/dists/bullseye/main/binary-arm64/Packages

curl -L -o a733-bullseye.Packages \
  https://radxa-repo.github.io/a733-bullseye/dists/a733-bullseye/main/binary-arm64/Packages
```

#### Windows PowerShell

```powershell
curl.exe -L -o bullseye.Packages `
  "https://radxa-repo.github.io/bullseye/dists/bullseye/main/binary-arm64/Packages"

curl.exe -L -o a733-bullseye.Packages `
  "https://radxa-repo.github.io/a733-bullseye/dists/a733-bullseye/main/binary-arm64/Packages"
```

### 8.2 查某个包的完整信息

#### Linux

查询 `linux-image-radxa-a733`：

```bash
sed -n '/^Package: linux-image-radxa-a733$/,/^$/p' a733-bullseye.Packages
```

查询 `task-radxa-a733`：

```bash
sed -n '/^Package: task-radxa-a733$/,/^$/p' bullseye.Packages
```

#### Windows PowerShell

```powershell
$lines = Get-Content .\a733-bullseye.Packages
$capture = $false
foreach ($line in $lines) {
  if ($line -match '^Package: linux-image-radxa-a733$') { $capture = $true }
  if ($capture) { $line }
  if ($capture -and $line -eq '') { break }
}
```

```powershell
$lines = Get-Content .\bullseye.Packages
$capture = $false
foreach ($line in $lines) {
  if ($line -match '^Package: task-radxa-a733$') { $capture = $true }
  if ($capture) { $line }
  if ($capture -and $line -eq '') { break }
}
```

### 8.3 按 `Filename` 直接下载 `.deb`

APT 索引里最重要的字段就是 `Filename`。

只要把：

- 仓库根地址
- 加上 `Filename`

拼起来，就是最终可下载的 `.deb` URL。

#### 例 1：下载 `task-radxa-a733`

包信息里给出的 `Filename` 是：

```text
pool/main/r/radxa-profiles/task-radxa-a733_0.4.44_all.deb
```

所以完整 URL 是：

```text
https://radxa-repo.github.io/bullseye/pool/main/r/radxa-profiles/task-radxa-a733_0.4.44_all.deb
```

Linux：

```bash
wget https://radxa-repo.github.io/bullseye/pool/main/r/radxa-profiles/task-radxa-a733_0.4.44_all.deb
```

Windows PowerShell：

```powershell
curl.exe -L -o task-radxa-a733_0.4.44_all.deb `
  "https://radxa-repo.github.io/bullseye/pool/main/r/radxa-profiles/task-radxa-a733_0.4.44_all.deb"
```

#### 例 2：下载 `linux-image-radxa-a733`

元包 URL：

```text
https://radxa-repo.github.io/a733-bullseye/pool/main/l/linux-a733/linux-image-radxa-a733_5.15.147-18_all.deb
```

Linux：

```bash
wget https://radxa-repo.github.io/a733-bullseye/pool/main/l/linux-a733/linux-image-radxa-a733_5.15.147-18_all.deb
```

Windows PowerShell：

```powershell
curl.exe -L -o linux-image-radxa-a733_5.15.147-18_all.deb `
  "https://radxa-repo.github.io/a733-bullseye/pool/main/l/linux-a733/linux-image-radxa-a733_5.15.147-18_all.deb"
```

#### 例 3：下载真正的大内核包

真正的大内核包 URL：

```text
https://radxa-repo.github.io/a733-bullseye/pool/main/l/linux-upstream/linux-image-5.15.147-18-a733_5.15.147-18_arm64.deb
```

Linux：

```bash
wget https://radxa-repo.github.io/a733-bullseye/pool/main/l/linux-upstream/linux-image-5.15.147-18-a733_5.15.147-18_arm64.deb
```

Windows PowerShell：

```powershell
curl.exe -L -o linux-image-5.15.147-18-a733_5.15.147-18_arm64.deb `
  "https://radxa-repo.github.io/a733-bullseye/pool/main/l/linux-upstream/linux-image-5.15.147-18-a733_5.15.147-18_arm64.deb"
```

#### 例 4：下载真正的 U-Boot 包

真正带 U-Boot 内容的是：

```text
https://radxa-repo.github.io/a733-bullseye/pool/main/u/u-boot-aw2501/u-boot-aw2501_2018.07-15_all.deb
```

Linux：

```bash
wget https://radxa-repo.github.io/a733-bullseye/pool/main/u/u-boot-aw2501/u-boot-aw2501_2018.07-15_all.deb
```

Windows PowerShell：

```powershell
curl.exe -L -o u-boot-aw2501_2018.07-15_all.deb `
  "https://radxa-repo.github.io/a733-bullseye/pool/main/u/u-boot-aw2501/u-boot-aw2501_2018.07-15_all.deb"
```

## 9. 如果你想自己复现 A733 的下载过程

建议按下面顺序排查：

1. 先看 `src/libexec/rsdk/rsdk-build`，确认构建参数。
2. 再看 `src/share/rsdk/build/rootfs.jsonnet`，确认配置拼装入口。
3. 看 `src/share/rsdk/build/mod/additional_repos.libjsonnet`，确认仓库源。
4. 看 `src/share/rsdk/build/mod/packages/categories/core.libjsonnet`，确认真正执行的 `apt-get install`。
5. 最后去在线仓库查 `Packages` 和 `Filename`，确认每个包实际来自哪个仓库。

## 10. 本文引用的关键源码位置

- `src/libexec/rsdk/rsdk-build`
- `src/share/rsdk/build/rootfs.jsonnet`
- `src/share/rsdk/build/mod/distro.libjsonnet`
- `src/share/rsdk/build/mod/additional_repos.libjsonnet`
- `src/share/rsdk/build/mod/packages/categories/core.libjsonnet`
- `src/share/rsdk/configs/products.json`
- `src/share/rsdk/configs/socs.json`

如果后续 A733 的仓库版本变了，最稳妥的办法仍然是：

1. 先看构建脚本里写入了哪些 APT 源。
2. 再到对应仓库的 `Packages` 文件里查 `Filename`。
3. 最后再拼完整下载 URL。
