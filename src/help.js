(function () {
  "use strict";

  var CATEGORIES = ["export", "notion", "obsidian", "general"];
  var faqData = null;
  var currentLang = "en";

  function applyProductBrand() {
    var config = globalThis.CHATVAULT_PRODUCT_CONFIG || {};
    var productName = config.productName || "Claude Export";
    document.title = "Help Center — " + productName;
    if (typeof config.applyThemeVars === "function") {
      config.applyThemeVars(document.documentElement);
    }
  }

  function getLang() {
    if (typeof CHATVAULT_I18N !== "undefined" && CHATVAULT_I18N.getLanguage) {
      return CHATVAULT_I18N.getLanguage() || "en";
    }
    return "en";
  }

  function t(key, fallback) {
    if (typeof CHATVAULT_I18N !== "undefined" && CHATVAULT_I18N.t) {
      return CHATVAULT_I18N.t(key, fallback);
    }
    return fallback;
  }

  function translatePlaceholder(node, key, fallback) {
    if (typeof CHATVAULT_I18N !== "undefined" && CHATVAULT_I18N.t) {
      var val = CHATVAULT_I18N.t(key, fallback);
      if (val) node.setAttribute("placeholder", val);
    }
  }

  function resolveUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
      return chrome.runtime.getURL(path);
    }
    return "../" + path;
  }

  async function loadFaq(lang) {
    try {
      var url = resolveUrl("_locales/" + lang + "/help.json");
      var resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    } catch (e) {
      if (lang !== "en") {
        return loadFaq("en");
      }
      return null;
    }
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderFaq(data) {
    var container = document.getElementById("help-content");
    if (!data || !data.categories) {
      container.innerHTML =
        '<div class="help-no-results"><p>' +
        escapeHtml(t("help_load_failed", "Failed to load help content.")) +
        "</p></div>";
      return;
    }

    var html = "";
    data.categories.forEach(function (cat) {
      html += '<section class="help-section" id="cat-' + cat.id + '">';
      html +=
        '<h2 class="help-section-title">' + escapeHtml(cat.title) + "</h2>";
      (cat.items || []).forEach(function (item, idx) {
        var qaId = "qa-" + cat.id + "-" + idx;
        html += '<div class="help-qa" id="' + qaId + '">';
        html +=
          '<div class="help-qa-question" role="button" tabindex="0" aria-expanded="false">';
        html += "<span>" + escapeHtml(item.q) + "</span>";
        html +=
          '<svg class="help-qa-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="6 9 12 15 18 9"></polyline></svg>';
        html += "</div>";
        html += '<div class="help-qa-answer"><div class="help-qa-answer-inner">' +
          item.a +
          "</div></div>";
        html += "</div>";
      });
      html += "</section>";
    });

    container.innerHTML = html;
    bindAccordion();
  }

  function bindAccordion() {
    document.querySelectorAll(".help-qa-question").forEach(function (q) {
      var toggle = function () {
        var qa = q.parentElement;
        var isOpen = qa.classList.toggle("open");
        q.setAttribute("aria-expanded", isOpen ? "true" : "false");
      };
      q.addEventListener("click", toggle);
      q.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  function highlightNav() {
    var hash = (window.location.hash || "#export").replace("#", "");
    if (CATEGORIES.indexOf(hash) === -1) hash = "export";

    document.querySelectorAll(".help-nav-item").forEach(function (item) {
      var isActive = item.getAttribute("data-category") === hash;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-current", isActive ? "true" : "false");
    });

    var target = document.getElementById("cat-" + hash);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function filterFaq(query) {
    query = query.trim().toLowerCase();
    var sections = document.querySelectorAll(".help-section");
    var anyVisible = false;

    if (!query) {
      sections.forEach(function (s) {
        s.style.display = "";
        s.querySelectorAll(".help-qa").forEach(function (qa) {
          qa.classList.remove("hidden");
          restoreQuestion(qa);
        });
      });
      var staleNoResults = document.getElementById("help-no-results-msg");
      if (staleNoResults) staleNoResults.remove();
      return;
    }

    sections.forEach(function (s) {
      var sectionVisible = false;
      s.querySelectorAll(".help-qa").forEach(function (qa) {
        var question = qa.querySelector(".help-qa-question span");
        var answer = qa.querySelector(".help-qa-answer-inner");
        var qText = question ? question.textContent.toLowerCase() : "";
        var aText = answer ? answer.textContent.toLowerCase() : "";
        var match = qText.indexOf(query) !== -1 || aText.indexOf(query) !== -1;
        qa.classList.toggle("hidden", !match);
        if (match) {
          sectionVisible = true;
          highlightMatch(question, query);
          qa.classList.add("open");
          qa.querySelector(".help-qa-question").setAttribute("aria-expanded", "true");
        } else {
          restoreQuestion(qa);
        }
      });
      s.style.display = sectionVisible ? "" : "none";
      if (sectionVisible) anyVisible = true;
    });

    var noResults = document.getElementById("help-no-results-msg");
    if (!anyVisible) {
      if (!noResults) {
        noResults = document.createElement("div");
        noResults.id = "help-no-results-msg";
        noResults.className = "help-no-results";
        noResults.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg><p>' +
          escapeHtml(t("help_no_results", "No matching questions found.")) +
          "</p>";
        document.getElementById("help-content").appendChild(noResults);
      }
    } else if (noResults) {
      noResults.remove();
    }
  }

  function highlightMatch(node, query) {
    if (!node) return;
    var text = node.textContent;
    if (text.indexOf("<") !== -1) return;
    var lower = text.toLowerCase();
    var idx = lower.indexOf(query);
    if (idx === -1) return;
    node.innerHTML =
      escapeHtml(text.slice(0, idx)) +
      "<help-mark>" +
      escapeHtml(text.slice(idx, idx + query.length)) +
      "</help-mark>" +
      escapeHtml(text.slice(idx + query.length));
  }

  function restoreQuestion(qa) {
    var question = qa.querySelector(".help-qa-question span");
    if (question && question.querySelector("help-mark")) {
      question.textContent = question.textContent;
    }
  }

  function initLanguageSelect() {
    var select = document.getElementById("help-language-select");
    if (!select) return;
    var stored = "system";
    if (typeof CHATVAULT_I18N !== "undefined" && CHATVAULT_I18N.getSelectedLanguage) {
      stored = CHATVAULT_I18N.getSelectedLanguage() || "system";
    }
    select.value = stored;
    select.addEventListener("change", function () {
      if (typeof CHATVAULT_I18N !== "undefined" && CHATVAULT_I18N.setLanguage) {
        // setLanguage 内部会派发 chatvault:language-changed 事件，
        // 由下方 globalThis 监听器统一触发 location.reload，无需在此重复 reload。
        CHATVAULT_I18N.setLanguage(select.value);
      }
    });
  }

  function applyStaticTranslations() {
    if (typeof CHATVAULT_I18N !== "undefined" && CHATVAULT_I18N.translateDOM) {
      CHATVAULT_I18N.translateDOM(document.body);
    }
    var searchInput = document.getElementById("help-search-input");
    if (searchInput) {
      translatePlaceholder(searchInput, "help_search_placeholder", "Search questions...");
    }
  }

  async function init() {
    try {
      applyProductBrand();
      if (typeof CHATVAULT_I18N !== "undefined" && CHATVAULT_I18N.ready) {
        await CHATVAULT_I18N.ready();
      }
      currentLang = getLang();
      applyStaticTranslations();
      initLanguageSelect();

      faqData = await loadFaq(currentLang);
      renderFaq(faqData);

      highlightNav();
      window.addEventListener("hashchange", highlightNav);

      var searchInput = document.getElementById("help-search-input");
      if (searchInput) {
        var debounceTimer = null;
        searchInput.addEventListener("input", function () {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(function () {
            filterFaq(searchInput.value);
          }, 200);
        });
      }

      if (typeof globalThis !== "undefined") {
        globalThis.addEventListener("chatvault:language-changed", function () {
          location.reload();
        });
      }
    } catch (err) {
      var container = document.getElementById("help-content");
      if (container) {
        container.innerHTML =
          '<div class="help-no-results"><p>' +
          escapeHtml(String(err && err.message ? err.message : err)) +
          "</p></div>";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
