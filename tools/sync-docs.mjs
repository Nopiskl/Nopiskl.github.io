import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_ROOT = path.join(ROOT, "docs");
const SOURCE_ROOT = path.join(ROOT, "source");
const GENERATED_DOCS_ROOT = path.join(SOURCE_ROOT, "docs");
const DATA_DIR = path.join(SOURCE_ROOT, "_data");
const DATA_FILE = path.join(DATA_DIR, "docs.json");
const ASSET_ROOT = path.join(SOURCE_ROOT, "docs-assets");
const MARKER = ".generated-by-nopiskl-docs";

const markdownExts = new Set([".md", ".markdown", ".mdown"]);
const previewPageExts = new Set([".pdf", ".docx"]);
const skippedNames = new Set([".DS_Store", "Thumbs.db"]);
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

const usedRoutes = new Map();

function slash(value) {
  return value.split(path.sep).join("/");
}

function relativeFromDocs(file) {
  return slash(path.relative(DOCS_ROOT, file));
}

function sha(value, length = 8) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, length);
}

function slugSegment(value, fallback = "section") {
  const special = String(value).trim().toLowerCase();
  if (special === "c++") return "cpp";
  if (special === "c#") return "csharp";

  const normalized = String(value)
    .normalize("NFKC")
    .replace(/['"`]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return normalized || fallback;
}

function uniqueRoute(baseRoute, ownerKey) {
  const normalized = baseRoute.endsWith("/") ? baseRoute : `${baseRoute}/`;
  const existing = usedRoutes.get(normalized);

  if (!existing || existing === ownerKey) {
    usedRoutes.set(normalized, ownerKey);
    return normalized;
  }

  const withoutSlash = normalized.replace(/\/$/, "");
  const candidate = `${withoutSlash}-${sha(ownerKey, 6)}/`;
  usedRoutes.set(candidate, ownerKey);
  return candidate;
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function titleFromFilename(file) {
  return path.basename(file, path.extname(file)).replace(/[_-]+/g, " ").trim();
}

function stripFrontMatter(content) {
  if (!content.startsWith("---\n")) {
    return content;
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return content;
  }

  return content.slice(end + 4).replace(/^\n+/, "");
}

function removeLeadingH1(body) {
  const lines = body.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);

  if (firstContentIndex >= 0 && /^#\s+/.test(lines[firstContentIndex])) {
    lines.splice(firstContentIndex, 1);
    while (lines[firstContentIndex] === "") {
      lines.splice(firstContentIndex, 1);
    }
  }

  return lines.join("\n").trimStart();
}

function languageFromFenceInfo(info) {
  const value = String(info || '').trim();
  if (!value) return '';

  const firstToken = value.split(/\s+/)[0].toLowerCase();
  const known = new Set([
    'bash',
    'c',
    'cpp',
    'css',
    'diff',
    'dts',
    'html',
    'ini',
    'javascript',
    'json',
    'makefile',
    'markdown',
    'mermaid',
    'python',
    'rust',
    'sh',
    'shell',
    'text',
    'typescript',
    'yaml',
    'yml',
  ]);

  if (known.has(firstToken)) return firstToken === 'text' ? 'plaintext' : firstToken;

  const pathLike = value.toLowerCase();
  if (/\.(?:c|h)(?::\d+)?$/.test(pathLike)) return 'c';
  if (/\.(?:cc|cpp|cxx|hpp|hh)(?::\d+)?$/.test(pathLike)) return 'cpp';
  if (/\.rs(?::\d+)?$/.test(pathLike)) return 'rust';
  if (/\.(?:patch|diff)(?::\d+)?$/.test(pathLike)) return 'diff';
  if (/\.(?:sh|bash)(?::\d+)?$/.test(pathLike)) return 'bash';
  if (/\.(?:dts|dtsi)(?::\d+)?$/.test(pathLike)) return 'dts';
  if (/\.(?:yml|yaml)(?::\d+)?$/.test(pathLike)) return 'yaml';
  if (/cmakelists\.txt$|\.cmake(?::\d+)?$/.test(pathLike)) return 'cmake';

  return value;
}

function normalizeCodeFenceInfo(body) {
  return body.replace(/^(`{3,}|~{3,})([^\n]*)$/gm, (line, fence, info) => {
    const language = languageFromFenceInfo(info);
    return language ? `${fence}${language}` : fence;
  });
}

function charCount(markdown) {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, " ");
  const text = withoutCode
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+]\([^)]+\)/g, " ")
    .replace(/[`*_>#|[\]()-]/g, " ");
  const zh = text.match(/[\p{Script=Han}]/gu)?.length || 0;
  const words = text.replace(/[\p{Script=Han}]/gu, " ").match(/[A-Za-z0-9_]+/g)?.length || 0;
  return zh + words;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resetGeneratedDir(dir) {
  if (await exists(dir)) {
    const marker = path.join(dir, MARKER);
    if (!(await exists(marker))) {
      throw new Error(`Refusing to overwrite non-generated directory: ${path.relative(ROOT, dir)}`);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, MARKER), "Generated by tools/sync-docs.mjs\n");
}

async function walk(dir) {
  if (!(await exists(dir))) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  entries.sort((a, b) => collator.compare(a.name, b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".") || skippedNames.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

async function walkDirectories(dir) {
  if (!(await exists(dir))) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const directories = [];

  entries.sort((a, b) => collator.compare(a.name, b.name));

  for (const entry of entries) {
    if (entry.name.startsWith(".") || skippedNames.has(entry.name)) continue;
    if (!entry.isDirectory()) continue;

    const fullPath = path.join(dir, entry.name);
    directories.push(fullPath, ...(await walkDirectories(fullPath)));
  }

  return directories;
}

function makeDirNode(key) {
  const segments = key ? key.split("/") : [];
  const slugSegments = segments.map((segment) => slugSegment(segment));
  const route = uniqueRoute(`/docs/${slugSegments.join("/")}`, `dir:${key}`);

  return {
    type: "directory",
    key,
    title: segments.at(-1) || "文档",
    url: key ? route : "/docs/",
    source: key ? `docs/${key}` : "docs",
    depth: segments.length,
    dirs: [],
    docs: [],
    attachments: [],
    directCount: 0,
    count: 0,
    attachmentCount: 0,
    breadcrumbs: [],
  };
}

function ensureDirectory(map, key) {
  if (map.has(key)) return map.get(key);

  const node = makeDirNode(key);
  map.set(key, node);

  if (key) {
    const parentKey = key.split("/").slice(0, -1).join("/");
    const parent = ensureDirectory(map, parentKey);
    parent.dirs.push(node);
  }

  return node;
}

function breadcrumbsForDir(map, key) {
  const breadcrumbs = [{ title: "文档", url: "/docs/", key: "" }];
  if (!key) return breadcrumbs;

  const parts = key.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const currentKey = parts.slice(0, index + 1).join("/");
    const node = map.get(currentKey);
    if (node) {
      breadcrumbs.push({ title: node.title, url: node.url, key: currentKey });
    }
  }

  return breadcrumbs;
}

function docRoute(dirKey, title, ownerKey) {
  const dirSegments = dirKey ? dirKey.split("/").map((segment) => slugSegment(segment)) : [];
  const docSlug = slugSegment(title, "article");
  return uniqueRoute(`/docs/${[...dirSegments, docSlug].join("/")}`, `doc:${ownerKey}`);
}

function attachmentRoute(dirKey, title, ownerKey) {
  const dirSegments = dirKey ? dirKey.split("/").map((segment) => slugSegment(segment)) : [];
  const attachmentSlug = `${slugSegment(title, "attachment")}-attachment`;
  return uniqueRoute(`/docs/${[...dirSegments, attachmentSlug].join("/")}`, `attachment:${ownerKey}`);
}

function attachmentViewerRoute(dirKey, title, ownerKey) {
  const dirSegments = dirKey ? dirKey.split("/").map((segment) => slugSegment(segment)) : [];
  const attachmentSlug = `${slugSegment(title, "attachment")}-viewer`;
  return uniqueRoute(`/docs/${[...dirSegments, attachmentSlug].join("/")}`, `attachment-viewer:${ownerKey}`);
}

function assetRoute(relFile) {
  const ext = path.extname(relFile);
  const stem = relFile.slice(0, -ext.length);
  const segments = slash(stem).split("/").map((segment) => slugSegment(segment, "file"));
  const filename = `${segments.pop() || "file"}-${sha(relFile, 8)}${ext.toLowerCase()}`;
  return slash(path.join("docs-assets", "files", ...segments, filename));
}

async function copyFileToSource(sourceFile, sourceRelativeTarget) {
  const target = path.join(SOURCE_ROOT, sourceRelativeTarget);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(sourceFile, target);
  return `/${sourceRelativeTarget}`;
}

function isExternalTarget(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
}

function normalizeMarkdownImageTarget(rawTarget) {
  let target = rawTarget.trim();
  target = target.replace(/^<|>$/g, "");

  const titled = target.match(/^(.+?)(?:\s+["'][^"']+["'])$/);
  if (titled) target = titled[1].trim();

  return target;
}

async function rewriteLocalImages(body, sourceFile, docId) {
  const replacements = [];
  const markdownImagePattern = /!\[([^\]]*)]\(([^)]+)\)/g;
  const htmlImagePattern = /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi;

  for (const match of body.matchAll(markdownImagePattern)) {
    const target = normalizeMarkdownImageTarget(match[2]);
    if (isExternalTarget(target)) continue;

    const decodedTarget = decodeURIComponent(target);
    const imageFile = path.resolve(path.dirname(sourceFile), decodedTarget);
    if (!imageFile.startsWith(DOCS_ROOT) || !(await exists(imageFile))) continue;

    const ext = path.extname(imageFile);
    const imageName = `${slugSegment(path.basename(imageFile, ext), "image")}-${sha(`${sourceFile}:${target}`, 6)}${ext.toLowerCase()}`;
    const sourceRelativeTarget = slash(path.join("docs-assets", "images", docId, imageName));
    const publicUrl = await copyFileToSource(imageFile, sourceRelativeTarget);
    replacements.push({ from: match[0], to: `![${match[1]}](${publicUrl})` });
  }

  for (const match of body.matchAll(htmlImagePattern)) {
    const target = match[3].trim();
    if (isExternalTarget(target)) continue;

    const decodedTarget = decodeURIComponent(target);
    const imageFile = path.resolve(path.dirname(sourceFile), decodedTarget);
    if (!imageFile.startsWith(DOCS_ROOT) || !(await exists(imageFile))) continue;

    const ext = path.extname(imageFile);
    const imageName = `${slugSegment(path.basename(imageFile, ext), "image")}-${sha(`${sourceFile}:${target}`, 6)}${ext.toLowerCase()}`;
    const sourceRelativeTarget = slash(path.join("docs-assets", "images", docId, imageName));
    const publicUrl = await copyFileToSource(imageFile, sourceRelativeTarget);
    replacements.push({ from: match[0], to: `<img${match[1]}src=${match[2]}${publicUrl}${match[2]}${match[4]}>` });
  }

  return replacements.reduce((result, replacement) => result.replace(replacement.from, replacement.to), body);
}

function serializeTree(node) {
  return {
    type: node.type,
    key: node.key,
    title: node.title,
    url: node.url,
    source: node.source,
    depth: node.depth,
    directCount: node.directCount,
    count: node.count,
    attachmentCount: node.attachmentCount,
    breadcrumbs: node.breadcrumbs,
    dirs: node.dirs.map(serializeTree),
    docs: node.docs,
    attachments: node.attachments,
  };
}

function summarizeDir(node) {
  return {
    type: node.type,
    key: node.key,
    title: node.title,
    url: node.url,
    source: node.source,
    depth: node.depth,
    directCount: node.directCount,
    count: node.count,
    attachmentCount: node.attachmentCount,
    breadcrumbs: node.breadcrumbs,
    dirs: node.dirs.map((child) => ({
      key: child.key,
      title: child.title,
      url: child.url,
      source: child.source,
      directCount: child.directCount,
      count: child.count,
      attachmentCount: child.attachmentCount,
    })),
    docs: node.docs,
    attachments: node.attachments,
  };
}

async function writeDirectoryPage(node) {
  const target = node.key
    ? path.join(GENERATED_DOCS_ROOT, ...node.url.replace(/^\/docs\/?/, "").split("/").filter(Boolean), "index.md")
    : path.join(GENERATED_DOCS_ROOT, "index.md");

  const title = node.key ? `${node.title} · 文档` : "文档";
  const content = `---\nlayout: docs\ntitle: ${yamlString(title)}\ndir_key: ${yamlString(node.key)}\n---\n`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function writeDocPage(doc, body) {
  const target = path.join(GENERATED_DOCS_ROOT, ...doc.url.replace(/^\/docs\/?/, "").split("/").filter(Boolean), "index.md");
  const content = `---\nlayout: doc\ntitle: ${yamlString(doc.title)}\ndoc_key: ${yamlString(doc.key)}\ndoc_source: ${yamlString(doc.source)}\ndoc_updated: ${yamlString(doc.updated)}\ndoc_chars: ${doc.chars}\n---\n\n${body}\n`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function writeAttachmentPage(attachment) {
  const target = path.join(GENERATED_DOCS_ROOT, ...attachment.url.replace(/^\/docs\/?/, "").split("/").filter(Boolean), "index.md");
  const content = `---\nlayout: attachment\ntitle: ${yamlString(attachment.title)}\nattachment_key: ${yamlString(attachment.key)}\n---\n`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function writeAttachmentViewerPage(attachment) {
  const target = path.join(GENERATED_DOCS_ROOT, ...attachment.viewerUrl.replace(/^\/docs\/?/, "").split("/").filter(Boolean), "index.md");
  const content = `---\nlayout: attachment-viewer\ntitle: ${yamlString(`${attachment.title} · 全页预览`)}\nattachment_key: ${yamlString(attachment.key)}\n---\n`;

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function main() {
  await resetGeneratedDir(GENERATED_DOCS_ROOT);
  await resetGeneratedDir(ASSET_ROOT);
  await fs.mkdir(DATA_DIR, { recursive: true });

  const dirMap = new Map();
  const rootNode = ensureDirectory(dirMap, "");
  const directoriesOnDisk = await walkDirectories(DOCS_ROOT);
  for (const directory of directoriesOnDisk) {
    ensureDirectory(dirMap, relativeFromDocs(directory));
  }

  const files = await walk(DOCS_ROOT);
  const documents = [];
  const attachments = [];

  for (const file of files) {
    const rel = relativeFromDocs(file);
    const ext = path.extname(file).toLowerCase();
    const dirKey = slash(path.dirname(rel)) === "." ? "" : slash(path.dirname(rel));
    const dirNode = ensureDirectory(dirMap, dirKey);
    const stat = await fs.stat(file);

    if (markdownExts.has(ext)) {
      const raw = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      const rawBody = stripFrontMatter(raw);
      const title = titleFromFilename(file);
      const key = rel;
      const url = docRoute(dirKey, title, key);
      const id = sha(key, 10);
      const bodyWithoutH1 = normalizeCodeFenceInfo(removeLeadingH1(rawBody));
      const body = await rewriteLocalImages(bodyWithoutH1, file, id);
      const doc = {
        type: "document",
        key,
        id,
        title,
        url,
        source: `docs/${rel}`,
        dirKey,
        updated: formatDate(stat.mtime),
        chars: charCount(body),
        breadcrumbs: [],
      };

      documents.push(doc);
      dirNode.docs.push(doc);
      await writeDocPage(doc, body);
    } else {
      const publicUrl = await copyFileToSource(file, assetRoute(rel));
      const title = titleFromFilename(file);
      const previewKind = ext === ".pdf" ? "pdf" : ext === ".docx" ? "docx" : "";
      const hasPreviewPage = previewPageExts.has(ext);
      const attachment = {
        type: "attachment",
        key: rel,
        title,
        ext: ext.replace(/^\./, "").toUpperCase() || "FILE",
        url: hasPreviewPage ? attachmentRoute(dirKey, title, rel) : publicUrl,
        viewerUrl: hasPreviewPage ? attachmentViewerRoute(dirKey, title, rel) : "",
        downloadUrl: publicUrl,
        previewKind,
        hasPreviewPage,
        source: `docs/${rel}`,
        dirKey,
        size: stat.size,
        updated: formatDate(stat.mtime),
      };

      attachments.push(attachment);
      dirNode.attachments.push(attachment);
    }
  }

  for (const node of dirMap.values()) {
    node.dirs.sort((a, b) => collator.compare(a.title, b.title));
    node.docs.sort((a, b) => collator.compare(a.title, b.title));
    node.attachments.sort((a, b) => collator.compare(a.title, b.title));
  }

  const finalize = (node) => {
    node.directCount = node.docs.length;
    node.count = node.directCount;
    node.attachmentCount = node.attachments.length;

    for (const child of node.dirs) {
      finalize(child);
      node.count += child.count;
      node.attachmentCount += child.attachmentCount;
    }
  };

  finalize(rootNode);

  for (const node of dirMap.values()) {
    node.breadcrumbs = breadcrumbsForDir(dirMap, node.key);
  }

  for (const doc of documents) {
    doc.breadcrumbs = breadcrumbsForDir(dirMap, doc.dirKey);
  }

  for (const attachment of attachments) {
    attachment.breadcrumbs = breadcrumbsForDir(dirMap, attachment.dirKey);
  }

  documents.sort((a, b) => collator.compare(a.source, b.source));
  attachments.sort((a, b) => collator.compare(a.source, b.source));

  for (const node of dirMap.values()) {
    await writeDirectoryPage(node);
  }

  for (const attachment of attachments) {
    if (attachment.hasPreviewPage) {
      await writeAttachmentPage(attachment);
      await writeAttachmentViewerPage(attachment);
    }
  }

  const directories = {};
  for (const [key, node] of dirMap) {
    directories[key] = summarizeDir(node);
  }

  const data = {
    generatedAt: new Date().toISOString(),
    root: "/docs/",
    stats: {
      documents: documents.length,
      directories: dirMap.size,
      attachments: attachments.length,
    },
    tree: serializeTree(rootNode),
    directories,
    documents,
    attachments,
  };

  await fs.writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Synced ${documents.length} docs and ${attachments.length} attachments from docs/.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
