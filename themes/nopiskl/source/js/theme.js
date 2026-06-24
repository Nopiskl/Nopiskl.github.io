(function () {
  const nav = document.querySelector("[data-nav]");
  const navToggle = document.querySelector("[data-nav-toggle]");
  const progress = document.querySelector("[data-progress]");
  const docContent = document.querySelector("[data-doc-content]");
  const docToc = document.querySelector("[data-doc-toc]");
  const docsSidebar = document.querySelector(".docs-sidebar");

  if (navToggle && nav) {
    navToggle.addEventListener("click", () => nav.classList.toggle("is-open"));
  }

  if (progress) {
    const updateProgress = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const value = max <= 0 ? 0 : Math.min(1, window.scrollY / max);
      progress.style.transform = `scaleX(${value})`;
    };

    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
  }

  if (docsSidebar) {
    const keepKey = "nopiskl.docsSidebarKeepOpenUntil";
    const root = document.documentElement;
    const retainedFromBootstrap = root.classList.contains("docs-sidebar-retained");
    let sidebarNavigationPending = false;
    let keepUntil = 0;

    try {
      keepUntil = Number(window.sessionStorage.getItem(keepKey) || 0);
    } catch (error) {
      keepUntil = 0;
    }

    if (retainedFromBootstrap || keepUntil > Date.now()) {
      docsSidebar.classList.add("is-retained");
      try {
        window.sessionStorage.removeItem(keepKey);
      } catch (error) {}

      window.requestAnimationFrame(() => {
        root.classList.remove("docs-sidebar-retained");
      });
    } else {
      root.classList.remove("docs-sidebar-retained");
    }

    docsSidebar.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link) return;

      try {
        const nextUrl = new URL(link.href, window.location.href);
        if (nextUrl.origin === window.location.origin && nextUrl.pathname.startsWith("/docs/")) {
          sidebarNavigationPending = true;
          window.sessionStorage.setItem(keepKey, String(Date.now() + 7000));
        }
      } catch (error) {
        sidebarNavigationPending = false;
      }
    });

    docsSidebar.addEventListener("mouseleave", () => {
      docsSidebar.classList.remove("is-retained");
      if (!sidebarNavigationPending) {
        try {
          window.sessionStorage.removeItem(keepKey);
        } catch (error) {}
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        sidebarNavigationPending = false;
        docsSidebar.classList.remove("is-retained");
        try {
          window.sessionStorage.removeItem(keepKey);
        } catch (error) {}
      }
    });
  }

  if (docContent && docToc) {
    const usedIds = new Set();
    const slugify = (value) => {
      const base = value
        .trim()
        .normalize("NFKC")
        .replace(/['"`]/g, "")
        .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "section";
      let id = base;
      let index = 2;

      while (usedIds.has(id) || document.getElementById(id)) {
        id = `${base}-${index}`;
        index += 1;
      }

      usedIds.add(id);
      return id;
    };

    const headings = Array.from(docContent.querySelectorAll("h2, h3, h4"));
    headings.forEach((heading) => {
      if (!heading.id) heading.id = slugify(heading.textContent || "");
    });

    if (headings.length) {
      const fragment = document.createDocumentFragment();

      headings.forEach((heading) => {
        const link = document.createElement("a");
        link.href = `#${heading.id}`;
        link.textContent = heading.textContent || "";
        link.className = `toc-${heading.tagName.toLowerCase()}`;
        fragment.appendChild(link);
      });

      docToc.appendChild(fragment);
    } else {
      docToc.parentElement.hidden = true;
    }
  }
})();
