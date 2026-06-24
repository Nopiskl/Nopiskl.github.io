(function () {
  const nav = document.querySelector("[data-nav]");
  const navToggle = document.querySelector("[data-nav-toggle]");

  if (navToggle && nav) {
    navToggle.addEventListener("click", () => nav.classList.toggle("is-open"));
  }
})();
