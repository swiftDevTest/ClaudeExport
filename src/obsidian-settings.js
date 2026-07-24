(function initObsidianSettingsPage() {
  "use strict";

  const DATABASE_NAME = "chatvault-obsidian-sync-v1";
  const DATABASE_VERSION = 1;
  const VAULT_STORE = "vault";
  const JOB_STORE = "jobs";
  const HISTORY_STORE = "history";
  const CONFIG_KEY = "chatvault_obsidian_config_v1";
  const i18n = globalThis.CHATVAULT_I18N;
  let databasePromise = null;
  let selectedHandle = null;
  let vaultPermissionGranted = false;
  let currentVaultName = "";
  let currentVaultDetected = false;
  let notesRoot = "";
  let assetsRoot = "";
  let notesDirectorySelected = false;
  let assetsRootCustom = false;

  const elements = {};

  function t(key, fallback, ...args) {
    return i18n && typeof i18n.t === "function" ? i18n.t(key, fallback, ...args) : fallback;
  }

  function applyStaticI18n() {
    document.title = `${t("obsidian_settings_title", "Connect Obsidian Vault")} - AI Chat Export`;
    i18n?.translateDOM?.();
    document.getElementById("obsidian-notes-root")?.setAttribute("placeholder", t("obsidian_settings_notes_placeholder", "Choose a notes folder inside the Vault"));
    document.getElementById("obsidian-assets-root")?.setAttribute("placeholder", t("obsidian_settings_assets_placeholder", "Uses the notes folder when not set"));
    document.getElementById("obsidian-language-select")?.setAttribute("aria-label", t("popup_language_title", "Interface Language"));
    const systemOption = document.querySelector('#obsidian-language-select option[value="system"]');
    if (systemOption) systemOption.textContent = t("popup_language_system", "System Default");
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE, { keyPath: "key" });
        if (!db.objectStoreNames.contains(JOB_STORE)) {
          const jobs = db.createObjectStore(JOB_STORE, { keyPath: "id" });
          jobs.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          const history = db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
          history.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(t("obsidian_settings_storage_failed", "Could not open Obsidian local storage.")));
    });
    return databasePromise;
  }

  async function getVaultRecord() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(VAULT_STORE, "readonly").objectStore(VAULT_STORE).get("active");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveVaultHandle(handle) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE, "readwrite");
      tx.objectStore(VAULT_STORE).put({ key: "active", handle, updatedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error(t("obsidian_settings_save_permission_failed", "Could not save Vault permission.")));
    });
  }

  function runtimeMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response || !response.ok) return reject(new Error(response && response.error || t("obsidian_settings_request_failed", "Obsidian request failed.")));
        resolve(response);
      });
    });
  }

  function normalizePath(value) {
    const source = String(value || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
    if (!source) return "";
    const segments = source.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".obsidian" || /[<>:"|?*\x00-\x1f]/.test(segment))) {
      throw new Error(t("obsidian_settings_invalid_path", "Folders must use a safe path inside the Vault and cannot contain .., .obsidian, or invalid system characters."));
    }
    return segments.join("/");
  }

  async function getDirectory(root, relativePath, create) {
    let current = root;
    const normalized = normalizePath(relativePath);
    if (!normalized) return current;
    for (const segment of normalized.split("/")) {
      current = await current.getDirectoryHandle(segment, { create: Boolean(create) });
    }
    return current;
  }

  function displayDirectoryPath(relativePath) {
    return relativePath ? relativePath : t("obsidian_vault_root", "Vault root");
  }

  function queryVaultPermission(handle, options = {}) {
    if (!handle || typeof handle.queryPermission !== "function") return Promise.resolve("denied");
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1000;
    const retries = Math.max(0, Number.isFinite(options.retries) ? options.retries : 1);
    return (async () => {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        let timeout = null;
        try {
          const result = await Promise.race([
            handle.queryPermission({ mode: "readwrite" }).catch(() => "denied"),
            new Promise((resolve) => { timeout = setTimeout(() => resolve("__timeout__"), timeoutMs); })
          ]);
          clearTimeout(timeout);
          if (result === "__timeout__") {
            // Timeout means the query has not resolved yet, not that permission
            // was denied. Retry once before falling back to "prompt" so the UI
            // does not wrongly tell the user to reauthorize a freshly granted
            // Vault (Service Worker cold-start can make queryPermission slow).
            if (attempt < retries) continue;
            return "prompt";
          }
          return result;
        } catch (error) {
          clearTimeout(timeout);
          return "denied";
        }
      }
      return "prompt";
    })();
  }

  function joinPreviewPath(root, leaf) {
    return [root, leaf].filter(Boolean).join("/");
  }

  async function ensureVaultPermission(handle, request) {
    if (!handle) return "missing";
    let permission = await queryVaultPermission(handle);
    if (permission !== "granted" && request && typeof handle.requestPermission === "function") {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    return permission;
  }

  async function getActiveVaultHandle(options = {}) {
    const handle = selectedHandle || (await getVaultRecord())?.handle || null;
    if (!handle) throw new Error(t("obsidian_settings_choose_root_first", "Choose your Obsidian Vault folder first."));
    const permission = await ensureVaultPermission(handle, options.requestPermission === true);
    if (permission !== "granted") throw new Error(t("obsidian_settings_permission_denied", "Vault write permission was not granted. Reauthorize the Vault and try again."));
    selectedHandle = handle;
    return handle;
  }

  async function chooseDirectoryWithinVault(pickerId) {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error(t("obsidian_settings_picker_unsupported", "This Chrome version does not support folder access. Update Chrome and try again."));
    }
    // showDirectoryPicker must be invoked synchronously from the click event.
    // Awaiting queryPermission first consumes Chrome's transient user activation
    // and makes the native picker appear to do nothing.
    const root = selectedHandle;
    if (!root) throw new Error(t("obsidian_settings_choose_root_first", "Choose your Obsidian Vault folder first."));
    const language = i18n?.getLanguage?.() || "en";
    setResult(/^zh(?:_|-|$)/i.test(language) ? "正在打开文件夹选择器..." : "Opening the folder chooser...", "");
    const pickerPromise = window.showDirectoryPicker({ id: pickerId, mode: "readwrite", startIn: root });
    const picked = await pickerPromise;
    if (typeof root.resolve !== "function") throw new Error(t("obsidian_settings_resolve_unsupported", "This Chrome version cannot confirm whether the selected folder is inside the Vault."));
    const segments = await root.resolve(picked);
    if (!Array.isArray(segments)) throw new Error(t("obsidian_settings_folder_outside", "Choose a folder inside the current Vault."));
    return normalizePath(segments.join("/"));
  }

  async function detectObsidianDirectory(handle) {
    try {
      await handle.getDirectoryHandle(".obsidian", { create: false });
      return true;
    } catch (error) {
      return false;
    }
  }

  function setStep(step) {
    document.querySelectorAll(".obsidian-settings-step").forEach((item) => {
      const active = Number(item.dataset.step) === step;
      item.classList.toggle("is-active", active);
      item.hidden = !active;
    });
  }

  function renderSetupStage(step) {
    const vaultReady = Boolean(selectedHandle && vaultPermissionGranted);
    elements.vaultStage.hidden = vaultReady;
    elements.foldersStage.hidden = !vaultReady;
    elements.historySection.hidden = !vaultReady;
    setStep(Number.isInteger(step) ? step : vaultReady ? (notesDirectorySelected ? 3 : 2) : 1);
  }

  function setResult(message, type) {
    elements.result.textContent = message || "";
    elements.result.className = `obsidian-settings-result${type ? ` is-${type}` : ""}`;
  }

  function updatePreview() {
    elements.notesRoot.value = notesDirectorySelected ? displayDirectoryPath(notesRoot) : "";
    elements.assetsRoot.value = assetsRootCustom ? displayDirectoryPath(assetsRoot) : "";
    elements.clearAssets.hidden = !assetsRootCustom;
    elements.preview.textContent = notesDirectorySelected
      ? joinPreviewPath(notesRoot, `${t("obsidian_settings_preview_title", "Conversation title")}.md`)
      : t("obsidian_settings_preview_empty", "Choose a notes folder to preview the path");
    const effectiveAssetsRoot = assetsRootCustom ? assetsRoot : notesRoot;
    elements.assetsPreview.textContent = notesDirectorySelected
      ? joinPreviewPath(effectiveAssetsRoot, `${t("obsidian_settings_preview_title", "Conversation title")}-assets/run/001-image.webp`)
      : "";
    elements.save.disabled = !selectedHandle || !notesDirectorySelected;
    renderSetupStage();
  }

  function requireVaultBeforeFolderChoice() {
    if (selectedHandle && vaultPermissionGranted) return true;
    setStep(1);
    setResult(t("obsidian_settings_choose_root_first", "Choose your Obsidian Vault folder first."), "error");
    const chooseVaultButton = document.getElementById("obsidian-choose-vault");
    chooseVaultButton?.focus();
    chooseVaultButton?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    return false;
  }

  async function chooseVault() {
    if (typeof window.showDirectoryPicker !== "function") {
      setResult(t("obsidian_settings_picker_unsupported", "This Chrome version does not support folder access. Update Chrome and try again."), "error");
      return;
    }
    try {
      selectedHandle = await window.showDirectoryPicker({ id: "chatvault-obsidian-vault", mode: "readwrite", startIn: "documents" });
      vaultPermissionGranted = true;
      await saveVaultHandle(selectedHandle);
      await new Promise((resolve, reject) => chrome.storage.local.set({
        [CONFIG_KEY]: { version: 2, configured: false, notesRoot: "", assetsRoot: "", assetsRootCustom: false, updatedAt: Date.now() }
      }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
      currentVaultName = selectedHandle.name || "Obsidian Vault";
      notesRoot = "";
      assetsRoot = "";
      notesDirectorySelected = false;
      assetsRootCustom = false;
      elements.vaultName.textContent = selectedHandle.name || "Obsidian Vault";
      elements.vaultStatus.textContent = t("obsidian_settings_vault_authorized", "Vault access is ready. Choose a notes folder next.");
      const isObsidian = await detectObsidianDirectory(selectedHandle);
      currentVaultDetected = isObsidian;
      if (isObsidian) {
        elements.warning.hidden = true;
        elements.warning.textContent = "";
      } else {
        elements.warning.hidden = false;
        elements.warning.textContent = t("obsidian_not_a_vault", "The selected folder does not look like an Obsidian Vault (no .obsidian directory). You can still use it, but opening notes in Obsidian may not work.");
      }
      setResult("", "");
      updatePreview();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setResult(error && error.message || t("obsidian_settings_choose_vault_failed", "Could not choose the Vault."), "error");
    }
  }

  async function chooseNotesDirectory() {
    if (!requireVaultBeforeFolderChoice()) return;
    try {
      notesRoot = await chooseDirectoryWithinVault("chatvault-obsidian-notes");
      notesDirectorySelected = true;
      if (!assetsRootCustom) assetsRoot = notesRoot;
      setStep(2);
      setResult("", "");
      updatePreview();
    } catch (error) {
      if (error?.name === "AbortError") return;
      setResult(error?.message || t("obsidian_settings_choose_notes_failed", "Could not choose the notes folder."), "error");
    }
  }

  async function chooseAssetsDirectory() {
    if (!requireVaultBeforeFolderChoice()) return;
    try {
      assetsRoot = await chooseDirectoryWithinVault("chatvault-obsidian-assets");
      assetsRootCustom = true;
      setResult("", "");
      updatePreview();
    } catch (error) {
      if (error?.name === "AbortError") return;
      setResult(error?.message || t("obsidian_settings_choose_assets_failed", "Could not choose the assets folder."), "error");
    }
  }

  function clearAssetsDirectory() {
    assetsRootCustom = false;
    assetsRoot = notesRoot;
    setResult("", "");
    updatePreview();
  }

  async function verifyAndSave() {
    let handle;
    let verified = false;
    elements.save.disabled = true;
    elements.save.textContent = t("obsidian_settings_verifying", "Verifying...");
    setStep(3);
    let testDirectory = null;
    let testName = "";
    let testWritable = null;
    try {
      handle = await getActiveVaultHandle({ requestPermission: true });
      vaultPermissionGranted = true;
      renderSetupStage(3);
      if (!notesDirectorySelected) throw new Error(t("obsidian_settings_choose_notes_first", "Choose a notes folder first."));
      const normalizedNotesRoot = normalizePath(notesRoot);
      const normalizedAssetsRoot = assetsRootCustom ? normalizePath(assetsRoot) : normalizedNotesRoot;
      testDirectory = await getDirectory(handle, normalizedNotesRoot, false);
      testName = `.chatvault-write-test-${Date.now().toString(36)}.tmp`;
      const testHandle = await testDirectory.getFileHandle(testName, { create: true });
      testWritable = await testHandle.createWritable();
      await testWritable.write(new TextEncoder().encode("ChatVault Obsidian write test"));
      await testWritable.close();
      testWritable = null;
      await testDirectory.removeEntry(testName);
      testName = "";
      await getDirectory(handle, normalizedAssetsRoot, false);
      await saveVaultHandle(handle);
      await new Promise((resolve, reject) => chrome.storage.local.set({
        [CONFIG_KEY]: {
          version: 2,
          configured: true,
          notesDirectoryConfigured: true,
          notesRoot: normalizedNotesRoot,
          assetsRoot: normalizedAssetsRoot,
          assetsRootCustom,
          updatedAt: Date.now()
        }
      }, () => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
      selectedHandle = handle;
      currentVaultName = handle.name || "Obsidian Vault";
      elements.vaultName.textContent = handle.name || "Obsidian Vault";
      elements.vaultStatus.textContent = t("obsidian_settings_ready", "Connection and folders are ready for single or batch sync.");
      currentVaultDetected = await detectObsidianDirectory(handle);
      elements.warning.hidden = true;
      elements.warning.textContent = "";
      elements.disconnect.hidden = false;
      setResult(t("obsidian_settings_saved", "Vault verified. Returning to the conversation..."), "success");
      verified = true;
    } catch (error) {
      setResult(error && error.message || t("obsidian_settings_verify_failed", "Vault write verification failed."), "error");
    } finally {
      if (testWritable) {
        try { await testWritable.abort(); } catch (error) {}
      }
      if (testDirectory && testName) {
        try { await testDirectory.removeEntry(testName); } catch (error) {}
      }
      elements.save.disabled = !selectedHandle || !notesDirectorySelected;
      elements.save.textContent = t("obsidian_settings_verify_save", "Verify and save");
    }
    if (verified) returnToConversation();
  }

  async function disconnect() {
    try {
      await runtimeMessage({ type: "CHATVAULT_OBSIDIAN_DISCONNECT" });
      selectedHandle = null;
      vaultPermissionGranted = false;
      currentVaultName = "";
      currentVaultDetected = false;
      notesRoot = "";
      assetsRoot = "";
      notesDirectorySelected = false;
      assetsRootCustom = false;
      elements.vaultName.textContent = t("obsidian_settings_not_selected", "Not selected");
      elements.vaultStatus.textContent = t("obsidian_settings_choose_root", "Choose the folder you use as your Obsidian Vault.");
      elements.disconnect.hidden = true;
      elements.save.disabled = true;
      elements.warning.hidden = true;
      updatePreview();
      setResult(t("obsidian_disconnected", "Obsidian disconnected. Existing files were kept."), "success");
    } catch (error) {
      setResult(error.message || t("obsidian_disconnect_failed", "Could not disconnect Obsidian."), "error");
    }
  }

  function formatTime(value) {
    const language = i18n?.getLanguage?.();
    const locale = language ? language.replace("_", "-") : undefined;
    try { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
    catch (error) { return new Date(value).toLocaleString(); }
  }

  async function loadHistory() {
    try {
      const response = await runtimeMessage({ type: "CHATVAULT_OBSIDIAN_GET_HISTORY" });
      const history = Array.isArray(response.history) ? response.history : [];
      elements.history.innerHTML = "";
      if (!history.length) {
        const empty = document.createElement("div");
        empty.className = "obsidian-settings-empty";
        empty.textContent = t("obsidian_settings_no_history", "No Obsidian sync history yet.");
        elements.history.appendChild(empty);
        return;
      }
      history.forEach((entry) => {
        const row = document.createElement("div");
        row.className = "obsidian-settings-history-item";
        const info = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = entry.noteRelativePath || entry.title || "Obsidian note";
        const meta = document.createElement("span");
        const statusLabel = entry.status === "partial"
          ? t("obsidian_status_partial", "Warnings")
          : entry.status === "failed"
            ? t("obsidian_status_failed_short", "Failed")
            : entry.status === "cancelled"
              ? t("obsidian_status_cancelled_short", "Cancelled")
              : t("obsidian_status_success", "Success");
        meta.textContent = `${formatTime(entry.createdAt)} | ${statusLabel} | ${t("obsidian_settings_image_count", "$1 images", entry.savedImages || 0)}`;
        info.append(title, meta);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "obsidian-history-open";
        open.textContent = t("content_open", "Open");
        open.addEventListener("click", () => runtimeMessage({
          type: "CHATVAULT_OBSIDIAN_OPEN_NOTE",
          vaultName: currentVaultName || selectedHandle?.name || "",
          noteRelativePath: entry.noteRelativePath
        }).catch((error) => setResult(error.message, "error")));
        if ((entry.status === "succeeded" || entry.status === "partial") && currentVaultDetected) row.append(info, open);
        else row.append(info);
        elements.history.appendChild(row);
      });
    } catch (error) {
      const empty = document.createElement("div");
      empty.className = "obsidian-settings-empty";
      empty.textContent = error.message || t("obsidian_settings_history_failed", "Could not load sync history.");
      elements.history.replaceChildren(empty);
    }
  }

  async function hydrate() {
    const [record, config] = await Promise.all([
      getVaultRecord().catch(() => null),
      new Promise((resolve) => chrome.storage.local.get(CONFIG_KEY, (result) => resolve(result && result[CONFIG_KEY] || null)))
    ]);
    if (config) {
      const isLegacyDefault = Number(config.version || 1) < 2 &&
        String(config.notesRoot || "") === "ChatVault" &&
        String(config.assetsRoot || "") === "ChatVault/assets";
      const legacyConfigured = typeof config.notesRoot === "string" && Boolean(config.notesRoot.trim());
      notesDirectorySelected = !isLegacyDefault && (config.configured === true || config.notesDirectoryConfigured === true || legacyConfigured);
      notesRoot = notesDirectorySelected ? normalizePath(config.notesRoot) : "";
      const configuredAssetsRoot = normalizePath(config.assetsRoot);
      assetsRootCustom = notesDirectorySelected && (
        config.assetsRootCustom === true || Boolean(configuredAssetsRoot && configuredAssetsRoot !== notesRoot)
      );
      assetsRoot = assetsRootCustom ? configuredAssetsRoot : notesRoot;
    }
    if (record && record.handle) {
      selectedHandle = record.handle;
      currentVaultName = record.handle.name || "Obsidian Vault";
      elements.vaultName.textContent = record.handle.name || "Obsidian Vault";
      const permission = await queryVaultPermission(record.handle);
      vaultPermissionGranted = permission === "granted";
      elements.vaultStatus.textContent = permission === "granted"
        ? t("obsidian_settings_connection_ready", "Connection is ready.")
        : permission === "prompt"
          ? t("obsidian_permission_checking", "Checking Vault permission...")
          : t("obsidian_permission_required", "Vault permission must be granted again.");
      elements.disconnect.hidden = false;
      if (permission === "granted") {
        const isObsidian = await detectObsidianDirectory(record.handle);
        currentVaultDetected = isObsidian;
        elements.warning.hidden = true;
        elements.warning.textContent = "";
      } else if (permission === "prompt" && elements.warning) {
        // Surface a non-blocking hint so the user knows a retry may resolve it.
        elements.warning.hidden = false;
        elements.warning.textContent = t("obsidian_permission_check_hint", "Permission check timed out. Click \"Verify and save\" to retry.");
      }
    }
    updatePreview();
    await loadHistory();
  }

  function returnToConversation() {
    const tabId = Number(new URLSearchParams(location.search).get("returnTabId"));
    if (Number.isInteger(tabId) && tabId > 0) {
      chrome.tabs.update(tabId, { active: true }, () => window.close());
    } else {
      window.close();
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    if (i18n && typeof i18n.ready === "function") await i18n.ready();
    applyStaticI18n();
    elements.vaultName = document.getElementById("obsidian-vault-name");
    elements.vaultStatus = document.getElementById("obsidian-vault-status");
    elements.warning = document.getElementById("obsidian-vault-warning");
    elements.vaultStage = document.getElementById("obsidian-vault-stage");
    elements.foldersStage = document.getElementById("obsidian-folders-stage");
    elements.historySection = document.getElementById("obsidian-history-section");
    elements.notesRoot = document.getElementById("obsidian-notes-root");
    elements.assetsRoot = document.getElementById("obsidian-assets-root");
    elements.clearAssets = document.getElementById("obsidian-clear-assets");
    elements.preview = document.getElementById("obsidian-path-preview");
    elements.assetsPreview = document.getElementById("obsidian-assets-preview");
    elements.save = document.getElementById("obsidian-save");
    elements.disconnect = document.getElementById("obsidian-disconnect");
    elements.result = document.getElementById("obsidian-save-result");
    elements.history = document.getElementById("obsidian-history-list");
    const languageSelect = document.getElementById("obsidian-language-select");
    if (languageSelect && i18n) {
      languageSelect.value = i18n.getSelectedLanguage?.() || "system";
      languageSelect.addEventListener("change", async () => {
        languageSelect.disabled = true;
        try {
          await i18n.setLanguage(languageSelect.value);
          location.reload();
        } catch (error) {
          languageSelect.disabled = false;
          setResult(error?.message || t("popup_language_change_failed", "Could not change language."), "error");
        }
      });
    }
    document.getElementById("obsidian-choose-vault").addEventListener("click", chooseVault);
    document.getElementById("obsidian-choose-notes").addEventListener("click", chooseNotesDirectory);
    document.getElementById("obsidian-choose-assets").addEventListener("click", chooseAssetsDirectory);
    elements.clearAssets.addEventListener("click", clearAssetsDirectory);
    elements.save.addEventListener("click", verifyAndSave);
    elements.disconnect.addEventListener("click", disconnect);
    document.getElementById("obsidian-return-button").addEventListener("click", returnToConversation);
    document.getElementById("obsidian-refresh-history").addEventListener("click", loadHistory);
    hydrate().catch((error) => setResult(error.message || t("obsidian_settings_init_failed", "Could not initialize Obsidian settings."), "error"));
  });
})();
