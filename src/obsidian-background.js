(function initChatVaultObsidianBackground() {
  "use strict";

  if (globalThis.CHATVAULT_OBSIDIAN_BACKGROUND) return;

  const DATABASE_NAME = "chatvault-obsidian-sync-v1";
  const DATABASE_VERSION = 1;
  const VAULT_STORE = "vault";
  const JOB_STORE = "jobs";
  const HISTORY_STORE = "history";
  const ACTIVE_VAULT_KEY = "active";
  const CONFIG_KEY = "chatvault_obsidian_config_v1";
  // 历史问题：STALE_JOB_MS=24h，SW 崩溃后 job 卡在 writing 状态 24 小时，
  // 用户期间无法启动新同步（job_conflict）。配合 alarms 周期清理降到 10min，
  // SW 异常终止后用户最长等待 12min（2min alarm 周期 + 10min stale 阈值）即可恢复。
  const STALE_JOB_MS = 10 * 60 * 1000;
  const STALE_CLEANUP_ALARM = "chatvault-obsidian-stale-cleanup";
  const STALE_CLEANUP_PERIOD_MIN = 2;
  const HISTORY_LIMIT = 20;
  const MAX_CHUNK_BYTES = 768 * 1024;
  const MAX_ASSET_BYTES = 8 * 1024 * 1024;
  const MAX_ASSETS = 50;
  const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
  const TRUSTED_CONTENT_HOSTS = new Set(["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com"]);
  const ALLOWED_MEDIA_TYPES = new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/bmp", "image/tiff"
  ]);
  let databasePromise = null;
  let mutationQueue = Promise.resolve();

  function isTrustedSender(sender) {
    if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
    const senderUrl = sender && (sender.url || sender.tab && sender.tab.url) || "";
    if (!senderUrl) return sender && sender.id === chrome.runtime.id;
    try {
      const url = new URL(senderUrl);
      if (url.protocol === "chrome-extension:") return url.hostname === chrome.runtime.id;
      return url.protocol === "https:" && TRUSTED_CONTENT_HOSTS.has(url.hostname.toLowerCase());
    } catch (error) {
      return false;
    }
  }

  function safeError(error) {
    const message = String(error && error.message || error || "Obsidian operation failed.")
      .replace(/(bearer|token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .slice(0, 500);
    return message || "Obsidian operation failed.";
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
      request.onerror = () => reject(request.error || new Error("Could not open Obsidian storage."));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function getRecord(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read Obsidian storage."));
    });
  }

  async function getAllRecords(storeName) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("Could not list Obsidian storage."));
    });
  }

  async function putRecord(storeName, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not update Obsidian storage."));
    });
  }

  async function deleteRecord(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not delete Obsidian storage."));
    });
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(result && result[key] || null);
      });
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(value, () => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve();
      });
    });
  }

  function normalizeRelativePath(value, options) {
    const source = String(value || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
    if (!source) throw new Error("Obsidian path is empty.");
    if (source.length > 500 || source.includes("\0")) throw new Error("Obsidian path is invalid.");
    const segments = source.split("/");
    for (const segment of segments) {
      if (!segment || segment === "." || segment === ".." || /[<>:"|?*\x00-\x1f]/.test(segment)) {
        throw new Error("Obsidian path contains an unsupported segment.");
      }
      if (segment.toLowerCase() === ".obsidian") throw new Error("Writing into .obsidian is not allowed.");
    }
    if (options && options.extension && !source.toLowerCase().endsWith(options.extension)) {
      throw new Error(`Obsidian path must end with ${options.extension}.`);
    }
    return segments.join("/");
  }

  function normalizeDirectoryPath(value) {
    const source = String(value || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
    if (!source) return "";
    if (source.length > 500 || source.includes("\0")) throw new Error("Obsidian directory path is invalid.");
    const segments = source.split("/");
    for (const segment of segments) {
      if (!segment || segment === "." || segment === ".." || /[<>:"|?*\x00-\x1f]/.test(segment)) {
        throw new Error("Obsidian directory path contains an unsupported segment.");
      }
      if (segment.toLowerCase() === ".obsidian") throw new Error("Writing into .obsidian is not allowed.");
    }
    return segments.join("/");
  }

  function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const isLegacyDefault = Number(source.version || 1) < 2 &&
      String(source.notesRoot || "") === "ChatVault" &&
      String(source.assetsRoot || "") === "ChatVault/assets";
    const hasLegacyNotesRoot = typeof source.notesRoot === "string" && Boolean(source.notesRoot.trim());
    const configured = !isLegacyDefault && (source.configured === true || source.notesDirectoryConfigured === true || hasLegacyNotesRoot);
    const notesRoot = configured ? normalizeDirectoryPath(source.notesRoot) : "";
    const requestedAssetsRoot = normalizeDirectoryPath(source.assetsRoot);
    const assetsRootCustom = configured && (
      source.assetsRootCustom === true || Boolean(requestedAssetsRoot && requestedAssetsRoot !== notesRoot)
    );
    return {
      version: 2,
      configured,
      notesRoot,
      assetsRoot: assetsRootCustom ? requestedAssetsRoot : notesRoot,
      assetsRootCustom
    };
  }

  async function getVaultRecord() {
    const record = await getRecord(VAULT_STORE, ACTIVE_VAULT_KEY);
    return record && record.handle ? record : null;
  }

  async function getPermissionState(handle) {
    if (!handle || typeof handle.queryPermission !== "function") return "unsupported";
    let timeout = null;
    try {
      const queryPromise = handle.queryPermission({ mode: "readwrite" });
      const timeoutPromise = new Promise((resolve) => {
        timeout = setTimeout(() => resolve("denied"), 1000);
      });
      return await Promise.race([queryPromise, timeoutPromise]);
    } catch (error) {
      return "denied";
    } finally {
      clearTimeout(timeout);
    }
  }

  async function requireWritableVault() {
    const record = await getVaultRecord();
    if (!record || !record.handle) {
      const error = new Error("Connect an Obsidian Vault first.");
      error.code = "vault_missing";
      throw error;
    }
    const permission = await getPermissionState(record.handle);
    if (permission !== "granted") {
      const error = new Error("Obsidian Vault permission must be granted again.");
      error.code = "permission_required";
      throw error;
    }
    return record;
  }

  async function getDirectoryByPath(root, relativePath, create) {
    let current = root;
    const normalized = normalizeDirectoryPath(relativePath);
    if (!normalized) return current;
    for (const segment of normalized.split("/")) {
      current = await current.getDirectoryHandle(segment, { create: Boolean(create) });
    }
    return current;
  }

  async function detectObsidianVault(handle) {
    try {
      await handle.getDirectoryHandle(".obsidian", { create: false });
      return true;
    } catch (error) {
      return false;
    }
  }

  async function getFileByPath(root, relativePath, create) {
    const normalized = normalizeRelativePath(relativePath);
    const parts = normalized.split("/");
    const filename = parts.pop();
    let parent = root;
    if (parts.length) parent = await getDirectoryByPath(root, parts.join("/"), create);
    return { parent, filename, handle: await parent.getFileHandle(filename, { create: Boolean(create) }) };
  }

  async function removeFileIfPresent(root, relativePath) {
    try {
      const target = await getFileByPath(root, relativePath, false);
      await target.parent.removeEntry(target.filename);
    } catch (error) {
      if (error && error.name !== "NotFoundError") throw error;
    }
  }

  function decodeBase64(value) {
    const source = String(value || "");
    if (!source || source.length > Math.ceil(MAX_CHUNK_BYTES * 4 / 3) + 16) throw new Error("Obsidian asset chunk is invalid.");
    const binary = atob(source);
    if (binary.length > MAX_CHUNK_BYTES) throw new Error("Obsidian asset chunk is too large.");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function validateAssetChunkState(existing, offset, chunkLength, byteLength) {
    const expectedOffset = existing ? Number(existing.written || 0) : 0;
    if (offset !== expectedOffset) throw new Error("Obsidian asset chunk offset is invalid.");
    if (offset + chunkLength > byteLength) throw new Error("Obsidian asset chunk exceeds the declared size.");
    return offset + chunkLength;
  }

  function validateFinalizeAssetState(job, stats) {
    const completedAssets = Object.keys(job.completedAssets || {}).length;
    const rawDeclaredFailures = Number(stats.failedImages || 0);
    const declaredFailures = Number.isInteger(rawDeclaredFailures) && rawDeclaredFailures >= 0
      ? Math.min(MAX_ASSETS, rawDeclaredFailures)
      : 0;
    const incompleteAssets = Object.keys(job.assets || {}).filter((assetId) => !job.completedAssets?.[assetId]);
    if (incompleteAssets.length > declaredFailures || completedAssets + declaredFailures < job.expectedAssets) {
      throw new Error("Obsidian assets have not finished processing.");
    }
    return { completedAssets, declaredFailures, incompleteAssets };
  }

  function noteOwnsSourceKey(bytes, sourceKey) {
    if (!bytes || !/^[a-f0-9]{64}$/i.test(String(sourceKey || ""))) return false;
    const text = new TextDecoder().decode(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    const header = text.slice(0, 64 * 1024);
    const key = String(sourceKey).toLowerCase();
    return header.includes(`chatvault_id: "${key}"`) || header.includes(`chatvault_source_key: "${key}"`);
  }

  function safeJob(job) {
    return {
      id: job.id,
      batchId: job.batchId || "",
      title: job.title,
      scope: job.scope,
      status: job.status,
      noteRelativePath: job.noteRelativePath,
      assetsDirectory: job.assetsDirectory,
      completedAssets: Object.keys(job.completedAssets || {}).length,
      expectedAssets: job.expectedAssets || 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  async function removeDirectoryIfPresent(root, relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const parts = normalized.split("/");
    const name = parts.pop();
    let parent = root;
    try {
      if (parts.length) parent = await getDirectoryByPath(root, parts.join("/"), false);
      await parent.removeEntry(name, { recursive: true });
    } catch (error) {
      if (error && error.name !== "NotFoundError") throw error;
    }
  }

  async function abortJob(jobId, options) {
    const job = await getRecord(JOB_STORE, String(jobId || ""));
    if (!job) return null;
    try {
      const vault = await requireWritableVault();
      if (job.assetsDirectory) await removeDirectoryIfPresent(vault.handle, job.assetsDirectory);
    } catch (error) {
      if (!(options && options.bestEffort)) throw error;
    }
    await deleteRecord(JOB_STORE, job.id);
    if (options && options.record) {
      await addHistory({
        id: `${job.id}:${Date.now()}`,
        createdAt: Date.now(),
        noteRelativePath: job.noteRelativePath,
        scope: job.scope,
        status: options.status === "failed" ? "failed" : "cancelled",
        savedImages: Object.keys(job.completedAssets || {}).length,
        warningCodes: options.warningCode ? [String(options.warningCode).slice(0, 80)] : []
      });
    }
    const finalStatus = options && options.status === "failed" ? "failed" : "cancelled";
    return safeJob({ ...job, status: finalStatus, updatedAt: Date.now() });
  }

  async function cleanupStaleJobs() {
    const jobs = await getAllRecords(JOB_STORE);
    const stale = jobs.filter((job) => Date.now() - Number(job.updatedAt || job.createdAt || 0) > STALE_JOB_MS);
    for (const job of stale) await abortJob(job.id, { bestEffort: true });
  }

  async function addHistory(entry) {
    await putRecord(HISTORY_STORE, entry);
    const history = (await getAllRecords(HISTORY_STORE)).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    for (const oldEntry of history.slice(HISTORY_LIMIT)) await deleteRecord(HISTORY_STORE, oldEntry.id);
  }

  async function beginJob(payload) {
    const vault = await requireWritableVault();
    const config = normalizeConfig(await storageGet(CONFIG_KEY));
    if (!config.configured) {
      const configError = new Error("Choose an Obsidian note folder before syncing.");
      configError.code = "directories_missing";
      throw configError;
    }
    try {
      await Promise.all([
        getDirectoryByPath(vault.handle, config.notesRoot, false),
        getDirectoryByPath(vault.handle, config.assetsRoot, false)
      ]);
    } catch (error) {
      const directoryError = new Error("Obsidian note or asset folder is missing. Open Vault settings to repair it.");
      directoryError.code = "directories_missing";
      throw directoryError;
    }
    await cleanupStaleJobs();
    const activeJobs = await getAllRecords(JOB_STORE);
    if (activeJobs.length) {
      const error = new Error("Another Obsidian sync is already writing to this Vault.");
      error.code = "job_conflict";
      throw error;
    }
    const id = String(payload && payload.jobId || "");
    if (!/^obsidian_[a-z0-9_-]{8,120}$/i.test(id)) throw new Error("Obsidian job identity is invalid.");
    const noteRelativePath = normalizeRelativePath(payload.noteRelativePath, { extension: ".md" });
    const sourceKey = String(payload.sourceKey || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sourceKey)) throw new Error("Obsidian source identity is invalid.");
    const assetsDirectory = normalizeRelativePath(payload.assetsDirectory);
    const expectedAssets = Number(payload.expectedAssets || 0);
    if (!Number.isInteger(expectedAssets) || expectedAssets < 0 || expectedAssets > MAX_ASSETS) {
      throw new Error("Obsidian expected asset count is invalid.");
    }
    if (expectedAssets) await getDirectoryByPath(vault.handle, assetsDirectory, true);
    const now = Date.now();
    const job = {
      id,
      batchId: String(payload.batchId || "").slice(0, 160),
      title: String(payload.title || "AI Chat Export").slice(0, 300),
      platform: String(payload.platform || "unknown").slice(0, 40),
      sourceKey,
      scope: payload.scope === "selected" ? "selected" : "conversation",
      noteRelativePath,
      assetsDirectory,
      expectedAssets,
      assets: {},
      completedAssets: {},
      status: "writing",
      createdAt: now,
      updatedAt: now
    };
    await putRecord(JOB_STORE, job);
    return safeJob(job);
  }

  async function writeAssetChunk(payload) {
    const vault = await requireWritableVault();
    const job = await getRecord(JOB_STORE, String(payload.jobId || ""));
    if (!job || job.status !== "writing") throw new Error("Obsidian job is not active.");
    const asset = payload.asset && typeof payload.asset === "object" ? payload.asset : {};
    const assetId = String(asset.id || "");
    if (!/^asset_[a-z0-9_-]{1,80}$/i.test(assetId)) throw new Error("Obsidian asset identity is invalid.");
    const relativePath = normalizeRelativePath(asset.relativePath);
    if (!relativePath.startsWith(job.assetsDirectory + "/")) throw new Error("Obsidian asset path is outside the task directory.");
    const mimeType = String(asset.mimeType || "").toLowerCase();
    if (!ALLOWED_MEDIA_TYPES.has(mimeType)) throw new Error("Obsidian asset type is not supported.");
    const byteLength = Number(asset.byteLength || 0);
    if (!Number.isFinite(byteLength) || byteLength <= 0 || byteLength > MAX_ASSET_BYTES) throw new Error("Obsidian asset size is invalid.");
    const expectedHash = String(asset.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Obsidian asset hash is invalid.");
    const offset = Number(payload.offset || 0);
    const existing = job.assets[assetId] || null;
    const bytes = decodeBase64(payload.base64);
    const nextOffset = validateAssetChunkState(existing, offset, bytes.byteLength, byteLength);
    const target = await getFileByPath(vault.handle, relativePath, true);
    const writable = await target.handle.createWritable({ keepExistingData: offset > 0 });
    try {
      if (offset > 0) await writable.seek(offset);
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (ignored) {}
      throw error;
    }
    job.assets[assetId] = { id: assetId, relativePath, mimeType, byteLength, sha256: expectedHash, written: nextOffset };
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    return { written: job.assets[assetId].written, byteLength };
  }

  async function completeAsset(payload) {
    const vault = await requireWritableVault();
    const job = await getRecord(JOB_STORE, String(payload.jobId || ""));
    if (!job || job.status !== "writing") throw new Error("Obsidian job is not active.");
    const assetId = String(payload.assetId || "");
    const asset = job.assets[assetId];
    if (!asset || asset.written !== asset.byteLength) throw new Error("Obsidian asset is incomplete.");
    const target = await getFileByPath(vault.handle, asset.relativePath, false);
    const file = await target.handle.getFile();
    if (file.size !== asset.byteLength) throw new Error("Obsidian asset size verification failed.");
    const hash = await sha256Hex(await file.arrayBuffer());
    if (hash !== asset.sha256) throw new Error("Obsidian asset integrity verification failed.");
    job.completedAssets[assetId] = { relativePath: asset.relativePath, byteLength: asset.byteLength, mimeType: asset.mimeType };
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    return { assetId, relativePath: asset.relativePath };
  }

  async function finalizeJob(payload) {
    const vault = await requireWritableVault();
    const job = await getRecord(JOB_STORE, String(payload.jobId || ""));
    if (!job || job.status !== "writing") throw new Error("Obsidian job is not active.");
    const markdown = String(payload.markdown || "");
    const markdownBytes = new TextEncoder().encode(markdown);
    if (!markdown.trim() || markdownBytes.byteLength > MAX_MARKDOWN_BYTES) throw new Error("Obsidian Markdown is empty or too large.");
    const stats = payload.stats && typeof payload.stats === "object" ? payload.stats : {};
    const assetState = validateFinalizeAssetState(job, stats);
    for (const assetId of assetState.incompleteAssets) {
      const asset = job.assets?.[assetId];
      if (asset?.relativePath) await removeFileIfPresent(vault.handle, asset.relativePath);
    }
    let previousNoteBytes = null;
    try {
      const previous = await getFileByPath(vault.handle, job.noteRelativePath, false);
      previousNoteBytes = await (await previous.handle.getFile()).arrayBuffer();
      if (!noteOwnsSourceKey(previousNoteBytes, job.sourceKey)) {
        const conflictError = new Error("A different note already exists at the generated Obsidian path.");
        conflictError.code = "note_conflict";
        throw conflictError;
      }
    } catch (error) {
      if (error && error.name !== "NotFoundError") throw error;
    }
    const target = await getFileByPath(vault.handle, job.noteRelativePath, true);
    const writable = await target.handle.createWritable();
    try {
      await writable.write(markdownBytes);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (ignored) {}
      if (previousNoteBytes) {
        try {
          const restoreWritable = await target.handle.createWritable();
          await restoreWritable.write(previousNoteBytes);
          await restoreWritable.close();
        } catch (ignored) {}
      } else {
        try { await target.parent.removeEntry(target.filename); } catch (ignored) {}
      }
      throw error;
    }
    const warnings = (Array.isArray(payload.warnings) ? payload.warnings : []).slice(0, 50).map((warning) => ({
      code: String(warning && warning.code || "warning").slice(0, 80),
      detail: String(warning && warning.detail || "").slice(0, 300)
    }));
    const result = {
      id: job.id,
      batchId: job.batchId,
      status: warnings.length ? "partial" : "succeeded",
      title: job.title,
      scope: job.scope,
      noteRelativePath: job.noteRelativePath,
      vaultName: String(vault.handle.name || "Obsidian Vault").slice(0, 200),
      canOpenInObsidian: await detectObsidianVault(vault.handle),
      savedImages: Math.max(0, Number(stats.savedImages || Object.keys(job.completedAssets).length)),
      compressedImages: Math.max(0, Number(stats.compressedImages || 0)),
      skippedImages: Math.max(0, Number(stats.skippedImages || 0)),
      failedImages: Math.max(0, Number(stats.failedImages || 0)),
      warningCount: warnings.length,
      warnings,
      createdAt: Date.now()
    };
    try {
      await addHistory({
        id: job.id,
        createdAt: result.createdAt,
        noteRelativePath: result.noteRelativePath,
        scope: result.scope,
        status: result.status,
        savedImages: result.savedImages,
        canOpenInObsidian: result.canOpenInObsidian,
        warningCodes: warnings.map((warning) => warning.code)
      });
      await deleteRecord(JOB_STORE, job.id);
      return result;
    } catch (error) {
      try { await target.parent.removeEntry(target.filename); } catch (ignored) {}
      throw error;
    }
  }

  async function getStatus() {
    const record = await getVaultRecord();
    const config = normalizeConfig(await storageGet(CONFIG_KEY));
    if (!record) return { connected: false, permission: "missing", directoriesValid: false, vaultDetected: false, config, activeJob: null };
    const permission = await getPermissionState(record.handle);
    if (permission === "granted") await cleanupStaleJobs();
    let directoriesValid = false;
    let vaultDetected = false;
    if (permission === "granted") {
      vaultDetected = await detectObsidianVault(record.handle);
    }
    if (permission === "granted" && config.configured) {
      try {
        await Promise.all([
          getDirectoryByPath(record.handle, config.notesRoot, false),
          getDirectoryByPath(record.handle, config.assetsRoot, false)
        ]);
        directoriesValid = true;
      } catch (error) {
        directoriesValid = false;
      }
    }
    const jobs = await getAllRecords(JOB_STORE);
    return {
      connected: true,
      permission,
      directoriesValid,
      vaultDetected,
      vaultName: String(record.handle.name || "Obsidian Vault").slice(0, 200),
      config,
      activeJob: jobs.length ? safeJob(jobs.sort((a, b) => b.updatedAt - a.updatedAt)[0]) : null
    };
  }

  async function disconnect() {
    const jobs = await getAllRecords(JOB_STORE);
    for (const job of jobs) await abortJob(job.id, { bestEffort: true });
    await deleteRecord(VAULT_STORE, ACTIVE_VAULT_KEY);
    const config = normalizeConfig(null);
    await storageSet({ [CONFIG_KEY]: config });
    return { connected: false, permission: "missing", directoriesValid: false, vaultDetected: false, config, activeJob: null };
  }

  function enqueueMutation(fn) {
    const next = mutationQueue.then(fn, fn);
    mutationQueue = next.catch(() => {});
    return next;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string" || !message.type.startsWith("CHATVAULT_OBSIDIAN_")) return false;
    if (!isTrustedSender(sender)) {
      sendResponse({ ok: false, error: "SecurityError: Untrusted Obsidian message sender." });
      return false;
    }
    const run = async () => {
      switch (message.type) {
        case "CHATVAULT_OBSIDIAN_GET_STATUS": return getStatus();
        case "CHATVAULT_OBSIDIAN_GET_HISTORY": {
          const history = (await getAllRecords(HISTORY_STORE)).sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_LIMIT);
          return { history };
        }
        case "CHATVAULT_OBSIDIAN_BEGIN": return enqueueMutation(() => beginJob(message.payload || {}));
        case "CHATVAULT_OBSIDIAN_WRITE_ASSET_CHUNK": return enqueueMutation(() => writeAssetChunk(message.payload || {}));
        case "CHATVAULT_OBSIDIAN_COMPLETE_ASSET": return enqueueMutation(() => completeAsset(message.payload || {}));
        case "CHATVAULT_OBSIDIAN_FINALIZE": return enqueueMutation(() => finalizeJob(message.payload || {}));
        case "CHATVAULT_OBSIDIAN_ABORT": return enqueueMutation(() => abortJob(message.jobId, {
          bestEffort: true,
          record: Boolean(message.record),
          status: message.status,
          warningCode: message.warningCode
        }));
        case "CHATVAULT_OBSIDIAN_DISCONNECT": return enqueueMutation(disconnect);
        case "CHATVAULT_OBSIDIAN_OPEN_SETTINGS": {
          const returnTabId = Number(sender && sender.tab && sender.tab.id || message.returnTabId || 0);
          const query = Number.isInteger(returnTabId) && returnTabId > 0 ? `?returnTabId=${returnTabId}` : "";
          // 当调用方（如批量导出弹窗）请求在后台打开时，不抢占当前标签焦点，
          // 避免批量导出视图被切走。
          const openInBackground = Boolean(message && message.background);
          const tab = await chrome.tabs.create({
            url: chrome.runtime.getURL(`src/obsidian-settings.html${query}`),
            active: !openInBackground
          });
          return { opened: true, tabId: tab && tab.id || null };
        }
        case "CHATVAULT_OBSIDIAN_OPEN_NOTE": {
          const vault = await getVaultRecord();
          if (!vault?.handle) throw new Error("Connect an Obsidian Vault first.");
          const vaultName = String(vault.handle.name || "").slice(0, 200);
          const notePath = normalizeRelativePath(message.noteRelativePath, { extension: ".md" }).replace(/\.md$/i, "");
          if (!vaultName) throw new Error("Obsidian Vault name is missing.");
          if (!await detectObsidianVault(vault.handle)) {
            const openError = new Error("The selected folder is not an initialized Obsidian Vault. Choose the actual Vault root in settings.");
            openError.code = "vault_not_registered";
            throw openError;
          }
          const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(notePath)}`;
          await chrome.tabs.create({ url });
          return { opened: true };
        }
        default: throw new Error("Unsupported Obsidian operation.");
      }
    };
    run().then((data) => sendResponse({ ok: true, ...(data && typeof data === "object" ? data : { result: data }) }))
      .catch((error) => sendResponse({ ok: false, code: error && error.code || "obsidian_error", error: safeError(error) }));
    return true;
  });

  // 周期清理 stale job：SW 在 writeAssetChunk 中途崩溃后，job 卡在 "writing"
  // 状态，新的 beginJob 会因 job_conflict 失败。alarms 周期触发 cleanupStaleJobs
  // 让卡死的 job 在 10min 后自动 abort，恢复用户同步能力。
  try {
    chrome.alarms.create(STALE_CLEANUP_ALARM, { periodInMinutes: STALE_CLEANUP_PERIOD_MIN });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== STALE_CLEANUP_ALARM) return;
      enqueueMutation(cleanupStaleJobs).catch(() => {});
    });
  } catch (error) {
    // alarms API 不可用时（如旧版本 Chrome），退化为不周期清理，仍依赖 beginJob 时调用
  }

  // SW 重启时立即清理一次，避免 SW 被 Chrome 回收后遗留的 stale job
  try {
    if (chrome.runtime.onStartup) {
      chrome.runtime.onStartup.addListener(() => {
        enqueueMutation(cleanupStaleJobs).catch(() => {});
      });
    }
  } catch (error) {}

  globalThis.CHATVAULT_OBSIDIAN_BACKGROUND = Object.freeze({
    databaseName: DATABASE_NAME,
    configKey: CONFIG_KEY,
    _test: Object.freeze({
      normalizeRelativePath,
      normalizeDirectoryPath,
      normalizeConfig,
      decodeBase64,
      sha256Hex,
      safeError,
      validateAssetChunkState,
      validateFinalizeAssetState,
      noteOwnsSourceKey
    })
  });
})();
