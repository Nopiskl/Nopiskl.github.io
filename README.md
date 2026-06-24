# Nopiskl Personal GitHub Blog Demo

这是一个可以直接放到 GitHub Pages 的纯静态个人博客 demo。它包含首页封面、文章卡片、分类筛选、阅读区、短札和关于区，不依赖构建工具。

## 文件结构

```text
.
├── index.html
├── assets/
│   ├── nopiskl-hero.png
│   ├── script.js
│   └── styles.css
├── .nojekyll
└── README.md
```

## 本地预览

直接在浏览器打开 `index.html` 即可。如果你更想用本地服务预览，可以在目录中运行：

```bash
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

## 发布到 GitHub Pages

1. 创建仓库，例如 `Nopiskl.github.io`。
2. 把当前目录内容提交并推送到仓库默认分支。
3. 在仓库的 Pages 设置中选择从默认分支根目录发布。

如果仓库名是 `Nopiskl.github.io`，发布地址通常会是：

```text
https://Nopiskl.github.io
```

## 后续可扩展

- 把文章内容拆成 Markdown。
- 加入归档、标签页和全文搜索。
- 使用 GitHub Actions 自动构建和部署。
- 增加 RSS、站点地图和 Open Graph 分享图。
