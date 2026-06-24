const articles = {
  "github-pages": {
    meta: "2026.06.24 · Engineering · 4 min read",
    title: "从零搭一个 GitHub Pages 个人博客",
    body: [
      "一个好的个人博客 demo 不需要一上来就引入复杂框架。先把首页、文章列表、阅读体验和部署路径做扎实，后续再补 Markdown 管线、评论、订阅和主题切换，会更稳。",
      "当前版本采用纯静态文件结构，适合直接放到 GitHub Pages。视觉上用一张自定义封面图建立识别度，内容区则保持克制，方便以后替换为真实文章。",
      "下一步可以把文章拆成 Markdown 文件，再用 Actions 或静态站点生成器自动构建。等内容规模变大时，标签、归档和全文搜索才会真正有价值。"
    ]
  },
  "debug-journal": {
    meta: "2026.06.19 · Systems · 5 min read",
    title: "把调试过程写成可搜索的知识库",
    body: [
      "调试最容易丢失的不是最终答案，而是沿途排除过的路径。把假设、证据和失败尝试留下来，能让下一次排查少走很多弯路。",
      "我通常把每次问题定位拆成三段：现象是什么、已经排除了什么、最后为什么解决。这样的记录结构既适合人读，也适合之后做检索。",
      "如果一条调试笔记未来可能帮到别人，它就值得从临时日志升级成博客文章。"
    ]
  },
  "small-tools": {
    meta: "2026.06.12 · Product · 3 min read",
    title: "小工具如何避免越做越重",
    body: [
      "小工具的优势在于轻，问题也常常出在继续加功能。每次新增能力之前，都应该问它是否让核心动作更短、更清楚、更可靠。",
      "我喜欢给 side project 留一个明确边界：不追求覆盖所有场景，只把一个具体任务处理得舒服。这个边界会让维护成本一直可控。",
      "当用户需要绕过工具才能完成真实工作时，才说明工具该扩展了。"
    ]
  },
  "personal-home": {
    meta: "2026.06.02 · Notes · 4 min read",
    title: "个人主页不必像简历",
    body: [
      "简历回答的是过去做过什么，个人主页还可以回答现在关心什么。它不必像列表一样完整，却应该像地图一样有方向感。",
      "我希望主页能放下三类东西：已经完成的项目、仍在研究的问题，以及一小段足够具体的自我介绍。这样访客能快速判断是否想继续交流。",
      "作品集展示结果，博客展示思考过程。两者放在一起，个人主页才更立体。"
    ]
  }
};

const filterButtons = document.querySelectorAll(".filter-button");
const postCards = document.querySelectorAll(".post-card");
const readButtons = document.querySelectorAll(".read-post");
const readerMeta = document.querySelector("#reader-meta");
const readerTitle = document.querySelector("#reader-title");
const readerBody = document.querySelector("#reader-body");
const reader = document.querySelector("#reader");

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;

    filterButtons.forEach((item) => {
      item.classList.toggle("is-active", item === button);
      item.setAttribute("aria-pressed", String(item === button));
    });

    postCards.forEach((card) => {
      const tags = card.dataset.tags.split(" ");
      card.classList.toggle("is-hidden", filter !== "all" && !tags.includes(filter));
    });
  });
});

readButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const article = articles[button.dataset.post];

    if (!article) {
      return;
    }

    readerMeta.textContent = article.meta;
    readerTitle.textContent = article.title;
    readerBody.innerHTML = article.body.map((paragraph) => `<p>${paragraph}</p>`).join("");
    reader.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});
