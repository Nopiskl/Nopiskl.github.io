(function () {
  const root = document.querySelector("[data-docx-preview]");
  if (!root) return;

  const output = root.querySelector("[data-docx-output]");
  const status = root.querySelector("[data-docx-status]");
  const docxUrl = root.dataset.docxUrl;
  const size = Number(root.dataset.docxSize || 0);
  const largeFileThreshold = 20 * 1024 * 1024;

  const setStatus = (title, detail, state) => {
    if (!status) return;
    status.className = `docx-preview-status${state ? ` is-${state}` : ""}`;
    status.replaceChildren();

    const titleElement = document.createElement("strong");
    titleElement.textContent = title;
    const detailElement = document.createElement("span");
    detailElement.textContent = detail;

    status.append(titleElement, detailElement);
  };

  const formatBytes = (value) => {
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const number = value / Math.pow(1024, index);
    return `${number.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const fail = (message) => {
    root.classList.add("is-failed");
    setStatus("DOCX 预览失败", `${message} 可以先使用右上角按钮下载原件。`, "error");
  };

  if (!docxUrl || !output) {
    fail("缺少 DOCX 文件地址。");
    return;
  }

  if (!window.JSZip || !window.docx || typeof window.docx.renderAsync !== "function") {
    fail("预览脚本没有正确加载。");
    return;
  }

  const loadingDetail = size > largeFileThreshold
    ? `文件约 ${formatBytes(size)}，浏览器端解析可能需要一些时间。`
    : "正在下载并解析文档内容。";
  setStatus("正在加载 DOCX", loadingDetail, "loading");

  fetch(docxUrl, { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.blob();
    })
    .then((blob) => {
      setStatus("正在渲染 DOCX", "正在把 Word 文档转换为网页预览。", "loading");
      return window.docx.renderAsync(blob, output, null, {
        className: "docx",
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        experimental: true,
      });
    })
    .then(() => {
      root.classList.add("is-loaded");
      setStatus("DOCX 预览已生成", "如果图片、表格或复杂排版有偏差，请下载原件查看。", "ready");
    })
    .catch((error) => {
      fail(error && error.message ? error.message : "未知错误。");
    });
})();
