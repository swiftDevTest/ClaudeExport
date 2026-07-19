(function initChatVaultNotionBackground() {
  "use strict";

  if (globalThis.CHATVAULT_NOTION_BACKGROUND) return;

  const API_VERSION = "2026-03-11";
  const SUPABASE_URL = "https://acgehhqcgreatcjcefub.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GH05KXWPIo42YrorR0OGyQ_XdEWzY8Q";
  const SESSION_KEY = "chatvault_supabase_session";
  const MANUAL_CONFIG_KEY = "chatvault_notion_manual_session_v1";
  const DATABASE_NAME = "chatvault-notion-sync-v2";
  const DATABASE_VERSION = 1;
  const JOB_STORE = "jobs";
  const MAPPING_STORE = "mappings";
  const ALARM_NAME = "chatvault-notion-queue-pump";
  const RETRY_ALARM_NAME = "chatvault-notion-queue-retry";
  const NOTIFICATION_LINKS_KEY = "chatvault_notion_notification_links_v1";
  const PROPERTY_MAPS_KEY = "chatvault_notion_property_maps_v1";
  const MAX_JOB_BYTES = 64 * 1024 * 1024;
  const MAX_MEDIA_ITEMS = 50;
  const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 25000;
  const CONNECTION_SERVICE_TIMEOUT_MS = 15000;
  const TRUSTED_CONTENT_HOSTS = new Set(["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com"]);
  const ALLOWED_MEDIA_TYPES = new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/heic", "image/tiff", "image/bmp"
  ]);
  const ALLOWED_BLOCK_TYPES = new Set([
    "paragraph", "heading_1", "heading_2", "heading_3", "quote", "code", "divider",
    "image", "table", "table_row", "bulleted_list_item", "numbered_list_item",
    "toggle", "callout", "equation"
  ]);
  const rateState = new Map();
  const manualMemory = new Map();
  const activeJobControllers = new Map();
  const schemaCache = new Map();
  const SCHEMA_CACHE_TTL_MS = 2 * 60 * 1000;
  const workspaceLimitCache = new Map();
  const WORKSPACE_LIMIT_CACHE_TTL_MS = 10 * 60 * 1000;
  const FREE_WORKSPACE_SAFE_IMAGE_BYTES = Math.floor(4.5 * 1024 * 1024);
  let databasePromise = null;
  let pumpPromise = null;

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

  function storageGet(area, key) {
    return new Promise((resolve) => {
      const target = chrome.storage && chrome.storage[area];
      if (!target) return resolve(null);
      target.get(key, (result) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(result && result[key] || null);
      });
    });
  }

  function storageSet(area, values) {
    return new Promise((resolve, reject) => {
      const target = chrome.storage && chrome.storage[area];
      if (!target) return resolve();
      target.set(values, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  function storageRemove(area, keys) {
    return new Promise((resolve) => {
      const target = chrome.storage && chrome.storage[area];
      if (!target) return resolve();
      target.remove(keys, resolve);
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(JOB_STORE)) {
          const jobs = db.createObjectStore(JOB_STORE, { keyPath: "id" });
          jobs.createIndex("status", "status", { unique: false });
          jobs.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(MAPPING_STORE)) {
          db.createObjectStore(MAPPING_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open Notion queue database."));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function withStore(storeName, mode, callback) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result;
      try { result = callback(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("Notion queue transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Notion queue transaction aborted."));
    });
  }

  async function getRecord(storeName, key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function putRecord(storeName, value) {
    return withStore(storeName, "readwrite", (store) => store.put(value));
  }

  function deleteRecord(storeName, key) {
    return withStore(storeName, "readwrite", (store) => store.delete(key));
  }

  async function listJobs() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(JOB_STORE, "readonly").objectStore(JOB_STORE).getAll();
      request.onsuccess = () => resolve((request.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
      request.onerror = () => reject(request.error);
    });
  }

  async function listMappings() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(MAPPING_STORE, "readonly").objectStore(MAPPING_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function safeJob(job) {
    return {
      id: job.id,
      title: job.title || "",
      sourceUrl: job.sourceUrl || "",
      platform: job.platform,
      batchId: job.batchId || "",
      batchIndex: Number.isFinite(job.batchIndex) ? job.batchIndex : null,
      batchTotal: Number.isFinite(job.batchTotal) ? job.batchTotal : null,
      status: job.status,
      progress: job.progress || 0,
      warningCount: Array.isArray(job.warnings) ? job.warnings.length : 0,
      warnings: (Array.isArray(job.warnings) ? job.warnings : []).slice(0, 10).map((warning) => ({
        code: String(warning && warning.code || "warning").slice(0, 80),
        detail: safeErrorDetail({ message: warning && warning.detail || "" })
      })),
      errorCode: job.errorCode || "",
      errorMessage: job.errorMessage || "",
      notionPageUrl: resolveNotionPageUrl(job.notionPageUrl, job.notionPageId),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  function clearJobSnapshot(job) {
    job.media = [];
    job.mediaUploads = {};
    job.blockRefs = {};
    job.knownChildren = {};
    job.executionPlan = null;
    job.inFlightOperation = null;
    job.renderPlan = null;
    job.title = "";
    job.sourceUrl = "";
    job.model = "";
    job.settings = {};
    job.propertyMap = {};
    job.warnings = (job.warnings || []).map((warning) => ({
      code: warning && warning.code || "warning",
      detail: ""
    }));
  }

  function byteLength(value) {
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
  }

  async function sha256Text(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function fingerprintPlan(plan) {
    const operations = [];
    for (const operation of plan && plan.operations || []) {
      const entries = [];
      for (const entry of operation.entries || []) {
        entries.push({
          localId: entry.localId,
          mediaRef: entry.mediaRef || null,
          hash: await sha256Text(JSON.stringify({ block: entry.block, mediaRef: entry.mediaRef || null }))
        });
      }
      operations.push({ parentRef: operation.parentRef, entries });
    }
    return { version: 1, operations };
  }

  function randomId(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function mappingKey(snapshot) {
    const destination = snapshot.destination || {};
    const identity = snapshot.alwaysCreate ? snapshot.syncRunId : snapshot.sourceKey;
    return [snapshot.ownerKey || "legacy", destination.connectionId, destination.dataSourceId, identity].join(":");
  }

  function validatePlannedBlock(block, depth) {
    if (!block || block.object !== "block" || !ALLOWED_BLOCK_TYPES.has(block.type) || !block[block.type]) {
      throw new Error("Notion render plan contains an unsupported block.");
    }
    if (depth > 2) throw new Error("Notion render plan nesting exceeds the supported request depth.");
    const children = block[block.type].children;
    if (children !== undefined) {
      if (!Array.isArray(children) || children.length > 100) throw new Error("Notion nested block array is invalid.");
      children.forEach((child) => validatePlannedBlock(child, depth + 1));
    }
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1) throw new Error("Unsupported Notion job snapshot.");
    if (!snapshot.sourceKey || !snapshot.title || !snapshot.destination || !snapshot.renderPlan) {
      throw new Error("Notion job snapshot is incomplete.");
    }
    if (snapshot.alwaysCreate && !snapshot.syncRunId) {
      throw new Error("Notion create job is missing its run identity.");
    }
    if (!snapshot.destination.connectionId || !snapshot.destination.dataSourceId) {
      throw new Error("Notion destination is missing.");
    }
    if (!Array.isArray(snapshot.renderPlan.operations) || !snapshot.renderPlan.operations.length) {
      throw new Error("Notion render plan is empty or invalid.");
    }
    if (snapshot.renderPlan.operations.length > 20000) throw new Error("Notion render plan has too many operations.");
    if (!Array.isArray(snapshot.media) || snapshot.media.length > MAX_MEDIA_ITEMS) {
      throw new Error("Notion media count exceeds the supported limit.");
    }
    const mediaIds = new Set();
    snapshot.media.forEach((media) => {
      if (!media || typeof media.id !== "string" || !media.id || mediaIds.has(media.id)) {
        throw new Error("Notion media identity is invalid or duplicated.");
      }
      mediaIds.add(media.id);
      if (media.error) return;
      if (!ALLOWED_MEDIA_TYPES.has(String(media.mimeType || "").toLowerCase())) {
        throw new Error("Unsupported Notion image MIME type.");
      }
      if (!Number.isFinite(media.byteLength) || media.byteLength > MAX_MEDIA_BYTES) {
        throw new Error("Notion image exceeds the supported size limit.");
      }
      if (typeof media.base64 !== "string") throw new Error("Notion image payload is invalid.");
      const estimatedBytes = Math.floor(media.base64.replace(/=+$/, "").length * 3 / 4);
      if (estimatedBytes > MAX_MEDIA_BYTES || Math.abs(estimatedBytes - media.byteLength) > 2) {
        throw new Error("Notion image payload size does not match its metadata.");
      }
    });
    const availableParents = new Set(["page"]);
    const localIds = new Set();
    const operationIds = new Set();
    snapshot.renderPlan.operations.forEach((operation) => {
      if (!operation || operation.type !== "append_children" || typeof operation.id !== "string" || !operation.id ||
          operationIds.has(operation.id) || typeof operation.parentRef !== "string" || !availableParents.has(operation.parentRef) ||
          !Array.isArray(operation.entries) || !operation.entries.length) {
        throw new Error("Notion render operation is invalid.");
      }
      operationIds.add(operation.id);
      if (operation.entries.length > 100) throw new Error("Notion render operation exceeds the block array limit.");
      if (byteLength({ children: operation.entries.map((entry) => entry && entry.block) }) > 500 * 1024) {
        throw new Error("Notion render operation exceeds the request size limit.");
      }
      operation.entries.forEach((entry) => {
        if (!entry || typeof entry.localId !== "string" || !entry.localId || localIds.has(entry.localId)) {
          throw new Error("Notion render entry is invalid or duplicated.");
        }
        localIds.add(entry.localId);
        validatePlannedBlock(entry.block, 0);
        if (entry.mediaRef) {
          if (entry.block.type !== "image" || !mediaIds.has(entry.mediaRef) ||
              entry.block.image && entry.block.image.file_upload &&
              entry.block.image.file_upload.id !== "__CHATVAULT_MEDIA_PENDING__") {
            throw new Error("Notion image block has an invalid captured media reference.");
          }
        } else if (entry.block.type === "image") {
          throw new Error("Notion image blocks must use a captured native file upload.");
        }
        availableParents.add(entry.localId);
      });
    });
    if (byteLength(snapshot) > MAX_JOB_BYTES) throw new Error("Notion job snapshot is too large.");
  }

  async function enqueueSnapshot(snapshot, options) {
    validateSnapshot(snapshot);
    const key = mappingKey(snapshot);
    const existingJobs = await listJobs();
    const duplicate = snapshot.alwaysCreate ? null : existingJobs.find((job) => job.mappingKey === key && ["held", "pending", "running", "retry_wait"].includes(job.status));
    if (duplicate) return { ...safeJob(duplicate), deduplicated: true };
    const now = Date.now();
    const job = {
      id: randomId("notion_job"),
      mappingKey: key,
      syncRunId: snapshot.syncRunId || "",
      alwaysCreate: Boolean(snapshot.alwaysCreate),
      sourceKey: snapshot.sourceKey,
      ownerKey: snapshot.ownerKey || "legacy",
      sourceRevision: snapshot.sourceRevision || "",
      sourceId: snapshot.sourceId,
      title: snapshot.title,
      sourceUrl: snapshot.sourceUrl,
      platform: snapshot.platform,
      batchId: String(snapshot.batchId || ""),
      batchIndex: snapshot.batchIndex != null && Number.isFinite(Number(snapshot.batchIndex)) ? Number(snapshot.batchIndex) : null,
      batchTotal: snapshot.batchTotal != null && Number.isFinite(Number(snapshot.batchTotal)) ? Number(snapshot.batchTotal) : null,
      model: snapshot.model || "",
      settings: snapshot.settings && typeof snapshot.settings === "object" ? snapshot.settings : {},
      policy: snapshot.alwaysCreate ? "create" : (snapshot.policy || "replace"),
      replaceConfirmedAt: Number(snapshot.replaceConfirmedAt || 0),
      destination: snapshot.destination,
      renderPlan: snapshot.renderPlan,
      media: snapshot.media,
      warnings: snapshot.renderPlan.warnings || [],
      partial: Boolean(snapshot.renderPlan.partial),
      status: options && options.deferStart ? "held" : "pending",
      currentOperation: 0,
      blockRefs: {},
      knownChildren: {},
      mediaUploads: {},
      attempt: 0,
      progress: 0,
      sourceTabId: Number.isInteger(options && options.sourceTabId) ? options.sourceTabId : null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000
    };
    await putRecord(JOB_STORE, job);
    if (job.status === "pending") schedulePump(50);
    broadcastJob(job);
    return { ...safeJob(job), deduplicated: false };
  }

  async function releaseJob(jobId) {
    const job = await getRecord(JOB_STORE, jobId);
    if (!job) throw new Error("Notion job was not found.");
    if (job.status === "held") {
      job.status = "pending";
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      broadcastJob(job);
      schedulePump(20);
    }
    return safeJob(job);
  }

  async function getFreshSupabaseSession(signal) {
    let session = await storageGet("local", SESSION_KEY);
    if (!session || !session.access_token) throw createNotionError("ChatVault sign-in is required.", 401, "chatvault_auth_required");
    const expiresAt = Number(session.expires_at || 0);
    if (expiresAt && expiresAt - Math.floor(Date.now() / 1000) < 180 && session.refresh_token) {
      const { response, text } = await fetchTextWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
        signal
      }, CONNECTION_SERVICE_TIMEOUT_MS);
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch (error) {}
      if (!response.ok) throw createNotionError("ChatVault session refresh failed.", response.status, "chatvault_auth_refresh_failed");
      session = { ...session, ...payload, user: payload.user || session.user };
      await storageSet("local", { [SESSION_KEY]: session });
    }
    return session;
  }

  async function callEdgeFunction(name, options) {
    const session = await getFreshSupabaseSession(options && options.signal);
    const { response, text } = await fetchTextWithTimeout(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: options && options.method || "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json"
      },
      body: options && options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options && options.signal
    }, CONNECTION_SERVICE_TIMEOUT_MS);
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch (error) {}
    if (!response.ok) {
      throw createNotionError(
        payload.error || payload.message || "Notion connection service failed.",
        response.status,
        payload.code || payload.details && payload.details.code || "connection_service_error"
      );
    }
    return payload;
  }

  async function setManualConfig(token, dataSourceId) {
    const normalizedToken = String(token || "").trim();
    const normalizedDataSourceId = String(dataSourceId || "").trim();
    if (!/^((secret|ntn)_[A-Za-z0-9_-]{20,})$/.test(normalizedToken)) throw new Error("Invalid Notion integration token format.");
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(normalizedDataSourceId)) {
      throw new Error("Invalid Notion data source ID.");
    }
    const connectionId = `manual_${(await sha256Text(normalizedToken)).slice(0, 24)}`;
    const record = { token: normalizedToken, connectionId, dataSourceId: normalizedDataSourceId, updatedAt: Date.now() };
    manualMemory.set("manual", record);
    await storageSet("session", { [MANUAL_CONFIG_KEY]: record });
    return { connectionId, dataSourceId: normalizedDataSourceId, workspaceName: "Manual integration" };
  }

  async function migrateLegacyManualConfig(token, databaseId) {
    const normalizedToken = String(token || "").trim();
    const normalizedDatabaseId = String(databaseId || "").trim();
    if (!/^((secret|ntn)_[A-Za-z0-9_-]{20,})$/.test(normalizedToken)) throw new Error("Invalid legacy Notion integration token.");
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(normalizedDatabaseId)) {
      throw new Error("Invalid legacy Notion database ID.");
    }
    const database = await notionRequest("manual_migration", normalizedToken, `/v1/databases/${encodeURIComponent(normalizedDatabaseId)}`, {});
    const dataSource = Array.isArray(database.data_sources) ? database.data_sources[0] : null;
    if (!dataSource || !dataSource.id) throw new Error("The legacy Database did not expose a Data Source. Re-enter the integration in Settings.");
    return setManualConfig(normalizedToken, dataSource.id);
  }

  async function getManualConfig() {
    if (manualMemory.has("manual")) return manualMemory.get("manual");
    const stored = await storageGet("session", MANUAL_CONFIG_KEY);
    if (stored && stored.token) manualMemory.set("manual", stored);
    return stored;
  }

  async function clearManualConfig() {
    manualMemory.delete("manual");
    for (const key of schemaCache.keys()) {
      if (key.startsWith("manual_")) schemaCache.delete(key);
    }
    for (const key of workspaceLimitCache.keys()) {
      if (key.startsWith("manual_")) workspaceLimitCache.delete(key);
    }
    await storageRemove("session", MANUAL_CONFIG_KEY);
  }

  async function cleanupConnectionLocalState(connectionId) {
    for (const key of schemaCache.keys()) {
      if (key.startsWith(`${connectionId}:`)) schemaCache.delete(key);
    }
    workspaceLimitCache.delete(connectionId);
    const jobs = await listJobs();
    for (const job of jobs) {
      if (job.destination?.connectionId === connectionId && !["succeeded", "partial", "cancelled"].includes(job.status)) {
        const controller = activeJobControllers.get(job.id);
        if (controller) controller.abort();
        job.status = "cancelled";
        job.updatedAt = Date.now();
        clearJobSnapshot(job);
        await putRecord(JOB_STORE, job);
      }
    }
    const mappings = await listMappings();
    for (const mapping of mappings) {
      if (mapping.connectionId === connectionId) await deleteRecord(MAPPING_STORE, mapping.key);
    }
    const propertyMaps = await storageGet("local", PROPERTY_MAPS_KEY) || {};
    Object.keys(propertyMaps).forEach((key) => {
      if (key.startsWith(`${connectionId}:`)) delete propertyMaps[key];
    });
    const selectedSources = await storageGet("local", "notion_selected_data_sources") || {};
    delete selectedSources[connectionId];
    const selectedConnection = await storageGet("local", "notion_selected_connection_id");
    await storageSet("local", {
      [PROPERTY_MAPS_KEY]: propertyMaps,
      notion_selected_data_sources: selectedSources,
      ...(selectedConnection === connectionId ? { notion_selected_connection_id: "" } : {})
    });
  }

  async function getNotionToken(connectionId, forceRefresh) {
    if (String(connectionId || "").startsWith("manual_")) {
      const manual = await getManualConfig();
      if (!manual || !manual.token || manual.connectionId !== connectionId) {
        throw createNotionError("Manual Notion token is unavailable. Re-enter it in Settings.", 401, "manual_token_missing");
      }
      return manual.token;
    }
    const payload = await callEdgeFunction("notion-connection-token", {
      body: { connection_id: connectionId, force_refresh: Boolean(forceRefresh) }
    });
    if (!payload.access_token) throw createNotionError("Notion connection token is unavailable.", 401, "notion_reconnect_required");
    return payload.access_token;
  }

  function createNotionError(message, status, code, retryAfter, requestId) {
    const error = new Error(String(message || "Notion request failed."));
    error.status = Number(status || 0);
    error.code = String(code || "notion_error");
    error.retryAfter = Number(retryAfter || 0);
    error.requestId = String(requestId || "").slice(0, 120);
    return error;
  }

  async function fetchTextWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const externalSignal = options && options.signal;
    const abortFromExternal = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || REQUEST_TIMEOUT_MS));
    try {
      const response = await fetch(url, { ...(options || {}), signal: controller.signal });
      const text = await response.text();
      return { response, text };
    } catch (error) {
      if (controller.signal.aborted && !(externalSignal && externalSignal.aborted)) {
        throw createNotionError("Notion connection service timed out.", 0, "connection_service_timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
    }
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        const error = new Error("Notion request was cancelled.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      let timer = null;
      const onAbort = () => {
        clearTimeout(timer);
        const error = new Error("Notion request was cancelled.");
        error.name = "AbortError";
        reject(error);
      };
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function rateLimit(connectionId) {
    const now = Date.now();
    const nextAt = Number(rateState.get(connectionId) || 0);
    if (nextAt > now) await delay(nextAt - now);
    rateState.set(connectionId, Math.max(Date.now(), nextAt) + 340);
  }

  function safeErrorDetail(error) {
    return String(error && error.message || "Notion sync failed.")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/(?:secret|ntn)_[A-Za-z0-9_-]+/gi, "[REDACTED_TOKEN]")
      .replace(/https?:\/\/[^\s]+(?:token|signature|sig)=[^\s&]+/gi, "[REDACTED_URL]")
      .slice(0, 500);
  }

  function userFacingJobError(error) {
    const code = String(error && error.code || "");
    const status = Number(error && error.status || 0);
    if (code === "update_conflict_requires_replace") return "The conversation is not append-only. Choose Replace and sync again.";
    if (code === "replace_confirmation_required") return "The Notion page changed. Confirm Replace and sync again.";
    if (code === "ambiguous_append_result") return "A previous append result was ambiguous. Choose Replace to avoid duplicate blocks.";
    if (/image|file_upload|media/.test(code)) return "A conversation image could not be uploaded to Notion.";
    if (/schema|property|validation/.test(code) || status === 400) return "The selected Data Source or content is not compatible with this sync operation.";
    if (status === 401 || /reconnect|auth|token/.test(code)) return "Reconnect the Notion workspace and try again.";
    if (status === 403 || code === "restricted_resource") return "The Notion connection does not have permission for this page or Data Source.";
    if (status === 404) return "The mapped Notion page or Data Source is unavailable, moved to trash, or no longer shared.";
    if (status === 429 || status === 529) return "Notion is rate-limited or overloaded. Retry later.";
    if (status >= 500 || status === 0) return "A temporary network or Notion service error interrupted the sync.";
    return "Notion sync could not be completed.";
  }

  async function notionRequest(connectionId, token, path, options) {
    const method = options && options.method || "GET";
    const maxAttempts = Number(options && options.maxAttempts || 5);
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      await rateLimit(connectionId);
      const controller = new AbortController();
      const externalSignal = options && options.signal;
      const abortFromExternal = () => controller.abort();
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const headers = {
          Authorization: `Bearer ${token}`,
          "Notion-Version": API_VERSION,
          ...(options && options.json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(options && options.headers || {})
        };
        const response = await fetch(`https://api.notion.com${path}`, {
          method,
          headers,
          body: options && options.formData || (options && options.json !== undefined ? JSON.stringify(options.json) : undefined),
          signal: controller.signal
        });
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch (error) {}
        if (response.ok) return payload;
        const retryAfter = Number(response.headers.get("Retry-After") || 0);
        const error = createNotionError(
          payload.message || `Notion request failed: ${response.status}`,
          response.status,
          payload.code,
          retryAfter,
          payload.request_id || response.headers.get("x-request-id")
        );
        if (response.status === 401) error.code = "notion_reconnect_required";
        if (![409, 429, 500, 502, 503, 504, 529].includes(response.status) || attempt >= maxAttempts) throw error;
        const exponential = Math.min(30000, 750 * Math.pow(2, attempt - 1));
        await delay(Math.max(retryAfter * 1000, exponential) + Math.floor(Math.random() * 350), externalSignal);
      } catch (error) {
        if (externalSignal && externalSignal.aborted) throw error;
        const retryableNetwork = error && (error.name === "AbortError" || error.status === 0 || !error.status);
        if (!retryableNetwork || attempt >= maxAttempts) throw error;
        await delay(Math.min(30000, 750 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 350), externalSignal);
      } finally {
        clearTimeout(timeout);
        if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
      }
    }
    throw createNotionError("Notion retry limit reached.", 0, "retry_limit_reached");
  }

  function jobRequest(job, token, path, options) {
    const active = activeJobControllers.get(job.id);
    return notionRequest(job.destination.connectionId, token, path, {
      ...(options || {}),
      maxAttempts: options && options.maxAttempts || 1,
      signal: active && active.signal
    });
  }

  function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  }

  async function getWorkspaceFileUploadLimit(job, token) {
    const connectionId = String(job && job.destination && job.destination.connectionId || "");
    const cached = workspaceLimitCache.get(connectionId);
    if (cached && Date.now() - cached.cachedAt < WORKSPACE_LIMIT_CACHE_TTL_MS) return cached.limit;
    try {
      const user = await jobRequest(job, token, "/v1/users/me", { maxAttempts: 2 });
      const limit = Math.max(0, Number(user && user.bot && user.bot.workspace_limits && user.bot.workspace_limits.max_file_upload_size_in_bytes || 0));
      if (limit) workspaceLimitCache.set(connectionId, { limit, cachedAt: Date.now() });
      return limit;
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      if ([401, 403].includes(Number(error && error.status || 0))) throw error;
      return 0;
    }
  }

  async function uploadMedia(job, mediaRef, token) {
    let uploadState = job.mediaUploads[mediaRef];
    if (typeof uploadState === "string") return uploadState;
    if (uploadState && uploadState.id && uploadState.status === "uploaded") return uploadState.id;
    const media = (job.media || []).find((item) => item && item.id === mediaRef);
    if (!media || media.error) throw createNotionError("Captured image is unavailable.", 400, "image_capture_failed");
    if (Number(media.byteLength || 0) > FREE_WORKSPACE_SAFE_IMAGE_BYTES) {
      const workspaceLimit = await getWorkspaceFileUploadLimit(job, token);
      if (workspaceLimit && Number(media.byteLength || 0) > workspaceLimit) {
        throw createNotionError("Image exceeds this Notion workspace file limit.", 413, "file_upload_invalid_size");
      }
    }
    if (uploadState && uploadState.id) {
      try {
        const current = await jobRequest(job, token, `/v1/file_uploads/${uploadState.id}`, { maxAttempts: 2 });
        if (current.status === "uploaded") {
          uploadState.status = "uploaded";
          await putRecord(JOB_STORE, job);
          return uploadState.id;
        }
        if (current.status !== "pending") uploadState = null;
      } catch (error) {
        if (Number(error && error.status || 0) === 404) uploadState = null;
        else throw error;
      }
    }
    if (!uploadState) {
      const created = await jobRequest(job, token, "/v1/file_uploads", {
        method: "POST",
        maxAttempts: 2,
        json: { mode: "single_part", filename: media.filename, content_type: media.mimeType }
      });
      if (!created.id) throw createNotionError("Notion did not create a file upload.", 502, "file_upload_create_failed");
      uploadState = { id: created.id, status: created.status || "pending" };
      job.mediaUploads[mediaRef] = uploadState;
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
    }
    const formData = new FormData();
    formData.append("file", base64ToBlob(media.base64, media.mimeType), media.filename);
    const sent = await jobRequest(job, token, `/v1/file_uploads/${uploadState.id}/send`, {
      method: "POST",
      maxAttempts: 2,
      formData
    });
    if (sent.status && sent.status !== "uploaded") throw createNotionError("Notion file upload did not finish.", 502, "file_upload_incomplete");
    uploadState.status = "uploaded";
    job.mediaUploads[mediaRef] = uploadState;
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    return uploadState.id;
  }

  function shouldDegradeMediaUploadError(error) {
    const status = Number(error && error.status || 0);
    const code = String(error && error.code || "");
    if (error && error.name === "AbortError") return false;
    if ([401, 403].includes(status) || /cancel|abort|reconnect|auth|token|restricted_resource/.test(code)) return false;
    return [0, 400, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504, 529].includes(status) ||
      /image|media|file_upload|rate_limit|service_unavailable|timeout/.test(code);
  }

  function unavailableImageCallout(media, reason) {
    const alt = String(media && media.alt || "Image").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "Image";
    const suffix = /size|large|413|limit/i.test(String(reason || ""))
      ? " The image exceeded the active Notion workspace limit."
      : " The image could not be uploaded after bounded retries.";
    return {
      object: "block",
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: `[Image unavailable: ${alt}]${suffix}` } }],
        icon: { emoji: "⚠️" },
        color: "yellow_background"
      }
    };
  }

  function findProperty(properties, names, type) {
    const normalized = names.map((name) => name.toLowerCase());
    return Object.entries(properties || {}).find(([name, property]) => {
      return property && property.type === type && normalized.includes(String(name).toLowerCase());
    });
  }

  function findPropertyByTypes(properties, names, types) {
    for (const type of types) {
      const match = findProperty(properties, names, type);
      if (match) return match;
    }
    return null;
  }

  function findJobProperty(properties, job, semantic, names, types) {
    const mappedId = job && job.propertyMap && job.propertyMap[semantic];
    if (mappedId) {
      const mapped = Object.entries(properties || {}).find(([, property]) => {
        return property && property.id === mappedId && types.includes(property.type);
      });
      if (mapped) return mapped;
    }
    if (!names.length) {
      return Object.entries(properties || {}).find(([, property]) => property && types.includes(property.type)) || null;
    }
    return findPropertyByTypes(properties, names, types);
  }

  function richTextProperty(value) {
    return { rich_text: [{ text: { content: String(value || "").slice(0, 2000) } }] };
  }

  function buildPageProperties(schema, job, status) {
    const properties = schema.properties || {};
    const output = {};
    const title = findJobProperty(properties, job, "title", [], ["title"]);
    if (!title) throw createNotionError("Selected Notion data source has no title property.", 400, "schema_title_missing");
    output[title[0]] = { title: [{ text: { content: String(job.title || "Untitled Conversation").slice(0, 2000) } }] };
    const platform = findJobProperty(properties, job, "platform", ["Platform"], ["select"]);
    if (platform) output[platform[0]] = { select: { name: String(job.platform || "AI").slice(0, 100) } };
    const model = findJobProperty(properties, job, "model", ["Model"], ["select", "rich_text"]);
    if (model && job.model) {
      output[model[0]] = model[1].type === "select"
        ? { select: { name: String(job.model).slice(0, 100) } }
        : richTextProperty(job.model);
    }
    const sourceUrl = findJobProperty(properties, job, "sourceUrl", ["Source URL", "Source Url"], ["url"]);
    if (sourceUrl && job.settings && job.settings.include_source_url && job.sourceUrl && String(job.sourceUrl).length <= 2000) {
      output[sourceUrl[0]] = { url: job.sourceUrl };
    }
    const sourceId = findJobProperty(properties, job, "sourceId", ["Source ID", "Source Id"], ["rich_text"]);
    if (sourceId) output[sourceId[0]] = richTextProperty(job.sourceId || job.sourceKey);
    const syncTime = findJobProperty(properties, job, "syncTime", ["Sync Time", "Synced At"], ["date"]);
    if (syncTime && (!job.settings || job.settings.show_export_time !== false)) {
      output[syncTime[0]] = { date: { start: new Date().toISOString() } };
    }
    const syncStatus = findJobProperty(properties, job, "syncStatus", ["Sync Status"], ["status", "select"]);
    if (syncStatus) {
      output[syncStatus[0]] = syncStatus[1].type === "status"
        ? { status: { name: status } }
        : { select: { name: status } };
    }
    const renderer = findJobProperty(properties, job, "renderer", ["Renderer Version"], ["rich_text"]);
    if (renderer) output[renderer[0]] = richTextProperty(job.renderPlan.rendererVersion || "notion-block-v2");
    return output;
  }

  async function retrieveSchema(job, token) {
    const destinationKey = `${job.destination.connectionId}:${job.destination.dataSourceId}`;
    const cached = schemaCache.get(destinationKey);
    const schema = cached && Date.now() - cached.cachedAt < SCHEMA_CACHE_TTL_MS
      ? cached.schema
      : await jobRequest(job, token, `/v1/data_sources/${encodeURIComponent(job.destination.dataSourceId)}`, {});
    if (!cached || schema !== cached.schema) {
      schemaCache.set(destinationKey, { schema, cachedAt: Date.now() });
    }
    const allMaps = await storageGet("local", PROPERTY_MAPS_KEY) || {};
    const previous = allMaps[destinationKey] || {};
    const definitions = {
      title: { names: [], types: ["title"] },
      platform: { names: ["Platform"], types: ["select"] },
      model: { names: ["Model"], types: ["select", "rich_text"] },
      sourceUrl: { names: ["Source URL", "Source Url"], types: ["url"] },
      sourceId: { names: ["Source ID", "Source Id"], types: ["rich_text"] },
      syncTime: { names: ["Sync Time", "Synced At"], types: ["date"] },
      syncStatus: { names: ["Sync Status"], types: ["status", "select"] },
      renderer: { names: ["Renderer Version"], types: ["rich_text"] }
    };
    job.propertyMap = { ...previous };
    Object.entries(definitions).forEach(([semantic, definition]) => {
      const match = findJobProperty(schema.properties || {}, job, semantic, definition.names, definition.types);
      if (match && match[1] && match[1].id) job.propertyMap[semantic] = match[1].id;
      else delete job.propertyMap[semantic];
    });
    allMaps[destinationKey] = job.propertyMap;
    await storageSet("local", { [PROPERTY_MAPS_KEY]: allMaps });
    return schema;
  }

  async function getRemoteMapping(job) {
    if (String(job.destination.connectionId || "").startsWith("manual_")) return null;
    try {
      const payload = await callEdgeFunction("notion-sync-mapping", {
        body: {
          action: "get",
          connection_id: job.destination.connectionId,
          data_source_id: job.destination.dataSourceId,
          source_key: job.sourceKey
        }
      });
      return payload.mapping || null;
    } catch (error) {
      return null;
    }
  }

  async function saveRemoteMapping(job, mapping) {
    if (String(job.destination.connectionId || "").startsWith("manual_")) return;
    const active = activeJobControllers.get(job.id);
    try {
      await callEdgeFunction("notion-sync-mapping", {
        signal: active && active.signal,
        body: {
          action: "upsert",
          connection_id: job.destination.connectionId,
          data_source_id: job.destination.dataSourceId,
          source_key: job.sourceKey,
          notion_page_id: mapping.notionPageId,
          notion_page_url: mapping.notionPageUrl,
          source_revision: mapping.sourceRevision || "",
          renderer_version: mapping.rendererVersion || job.renderPlan && job.renderPlan.rendererVersion || "notion-block-v2",
          status: mapping.status || "active"
        }
      });
    } catch (error) {
      if (active && active.signal.aborted) throw error;
      job.warnings.push({ code: "mapping_metadata_failed", detail: "Cross-device mapping metadata could not be updated; the local mapping is still available." });
    }
  }

  async function recoverPageBySourceId(job, token) {
    const sourceIdProperty = findJobProperty(job.schema && job.schema.properties, job, "sourceId", ["Source ID", "Source Id"], ["rich_text"]);
    if (!sourceIdProperty) return null;
    const payload = await jobRequest(job, token, `/v1/data_sources/${encodeURIComponent(job.destination.dataSourceId)}/query`, {
      method: "POST",
      json: {
        page_size: 2,
        filter: {
          property: sourceIdProperty[0],
          rich_text: { equals: String(job.sourceId || job.sourceKey).slice(0, 2000) }
        }
      }
    });
    const pages = Array.isArray(payload.results) ? payload.results : [];
    if (pages.length > 1) {
      job.warnings.push({ code: "duplicate_source_pages", detail: "Multiple existing pages use this Source ID; the most recently edited page was selected." });
      pages.sort((a, b) => Date.parse(b.last_edited_time || 0) - Date.parse(a.last_edited_time || 0));
    }
    return pages[0] || null;
  }

  async function validateMappedPage(job, mapping, token) {
    try {
      const page = await jobRequest(job, token, `/v1/pages/${encodeURIComponent(mapping.notionPageId)}`, {});
      if (page.in_trash) {
        mapping.status = "page_in_trash";
        mapping.updatedAt = Date.now();
        await putRecord(MAPPING_STORE, mapping);
        await saveRemoteMapping(job, mapping);
        throw createNotionError("The mapped Notion page is in trash. Restore it or sync with a new destination.", 404, "mapping_page_in_trash");
      }
      return page;
    } catch (error) {
      if (error && error.code === "mapping_page_in_trash") throw error;
      if ([403, 404].includes(Number(error && error.status || 0))) {
        mapping.status = Number(error.status) === 403 ? "permission_lost" : "stale";
        mapping.updatedAt = Date.now();
        await putRecord(MAPPING_STORE, mapping);
        await saveRemoteMapping(job, mapping);
      }
      throw error;
    }
  }

  function entriesByParent(operations) {
    const byParent = new Map();
    (operations || []).forEach((operation) => {
      const entries = byParent.get(operation.parentRef) || [];
      entries.push(...(operation.entries || []));
      byParent.set(operation.parentRef, entries);
    });
    return byParent;
  }

  async function appendOnlyOperations(previousPlan, currentPlan, knownBlockRefs) {
    if (!previousPlan || !currentPlan) return null;
    const previousByParent = entriesByParent(previousPlan.operations);
    const currentFingerprint = await fingerprintPlan(currentPlan);
    const currentByParent = entriesByParent(currentFingerprint.operations);
    for (const [parentRef, previousEntries] of previousByParent.entries()) {
      const currentEntries = currentByParent.get(parentRef) || [];
      if (currentEntries.length < previousEntries.length) return null;
      for (let index = 0; index < previousEntries.length; index += 1) {
        if (previousEntries[index].localId !== currentEntries[index].localId ||
            previousEntries[index].mediaRef !== currentEntries[index].mediaRef ||
            previousEntries[index].hash !== currentEntries[index].hash) return null;
      }
    }

    const consumedByParent = new Map();
    const availableRefs = new Set(["page", ...Object.keys(knownBlockRefs || {})]);
    const delta = [];
    for (const operation of currentPlan.operations || []) {
      const consumed = Number(consumedByParent.get(operation.parentRef) || 0);
      const previousCount = (previousByParent.get(operation.parentRef) || []).length;
      const entries = (operation.entries || []).filter((_entry, index) => consumed + index >= previousCount);
      consumedByParent.set(operation.parentRef, consumed + (operation.entries || []).length);
      if (!entries.length) continue;
      if (!availableRefs.has(operation.parentRef)) return null;
      delta.push({ ...operation, entries });
      entries.forEach((entry) => availableRefs.add(entry.localId));
    }
    return delta;
  }

  async function ensurePage(job, token) {
    if (job.notionPageId) return;
    const schema = await retrieveSchema(job, token);
    job.schema = { id: schema.id, properties: schema.properties || {} };
    if (job.alwaysCreate) {
      const page = await jobRequest(job, token, "/v1/pages", {
        method: "POST",
        json: {
          parent: { type: "data_source_id", data_source_id: job.destination.dataSourceId },
          properties: buildPageProperties(job.schema, job, "Syncing")
        }
      });
      job.notionPageId = page.id;
      job.notionPageUrl = resolveNotionPageUrl(page.url, page.id);
      job.knownChildren = { page: { count: 0, lastId: "" } };
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      return;
    }
    let mapping = await getRecord(MAPPING_STORE, job.mappingKey);
    if (!mapping) {
      const remote = await getRemoteMapping(job);
      if (remote && remote.notion_page_id) {
        mapping = {
          key: job.mappingKey,
          connectionId: job.destination.connectionId,
          dataSourceId: job.destination.dataSourceId,
          sourceKey: job.sourceKey,
          notionPageId: remote.notion_page_id,
          notionPageUrl: remote.notion_page_url || "",
          sourceRevision: remote.source_revision || "",
          rendererVersion: remote.renderer_version || "",
          status: remote.status || "active",
          createdAt: Date.parse(remote.created_at || "") || Date.now(),
          updatedAt: Date.parse(remote.updated_at || "") || Date.now()
        };
        await putRecord(MAPPING_STORE, mapping);
      }
    }
    if (!mapping) {
      const recoveredPage = await recoverPageBySourceId(job, token);
      if (recoveredPage && recoveredPage.id) {
        mapping = {
          key: job.mappingKey,
          connectionId: job.destination.connectionId,
          dataSourceId: job.destination.dataSourceId,
          sourceKey: job.sourceKey,
          notionPageId: recoveredPage.id,
          notionPageUrl: resolveNotionPageUrl(recoveredPage.url, recoveredPage.id),
          lastEditedTime: recoveredPage.last_edited_time || "",
          sourceRevision: "",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        await putRecord(MAPPING_STORE, mapping);
      }
    }
    const mappedPage = mapping ? await validateMappedPage(job, mapping, token) : null;
    if (mapping && mappedPage) {
      const resolvedPageUrl = resolveNotionPageUrl(mappedPage.url || mapping.notionPageUrl, mappedPage.id || mapping.notionPageId);
      if (resolvedPageUrl && mapping.notionPageUrl !== resolvedPageUrl) {
        mapping.notionPageUrl = resolvedPageUrl;
        mapping.updatedAt = Date.now();
        await putRecord(MAPPING_STORE, mapping);
        await saveRemoteMapping(job, mapping);
      }
    }
    if (mapping && job.policy === "skip") {
      job.notionPageId = mapping.notionPageId;
      job.notionPageUrl = mapping.notionPageUrl;
      job.status = "succeeded";
      job.progress = 100;
      clearJobSnapshot(job);
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      return;
    }
    if (mapping && ["replace", "update"].includes(job.policy)) {
      job.notionPageId = mapping.notionPageId;
      job.notionPageUrl = mapping.notionPageUrl;
      if (job.policy === "update" && mapping.sourceRevision === job.sourceRevision) {
        job.status = "succeeded";
        job.progress = 100;
        clearJobSnapshot(job);
        job.updatedAt = Date.now();
        await putRecord(JOB_STORE, job);
        return;
      }
      if (job.policy === "update") {
        const delta = await appendOnlyOperations(mapping.planFingerprint, job.renderPlan, mapping.blockRefs);
        if (delta) {
          job.executionPlan = delta;
          job.blockRefs = { ...(mapping.blockRefs || {}) };
          job.updatedAt = Date.now();
          await putRecord(JOB_STORE, job);
          return;
        }
        throw createNotionError(
          "Existing content changed, was removed, or changed order. Choose Replace to rebuild the mapped page.",
          400,
          "update_conflict_requires_replace"
        );
      }
      if (mapping.lastEditedTime && mappedPage && mappedPage.last_edited_time &&
          mapping.lastEditedTime !== mappedPage.last_edited_time && !job.replaceConfirmedAt) {
        throw createNotionError(
          "The mapped Notion page changed after the last sync. Confirm Replace again before overwriting managed content.",
          400,
          "replace_confirmation_required"
        );
      }
      job.executionPlan = null;
      job.currentOperation = 0;
      job.blockRefs = {};
      job.knownChildren = { page: { count: 0, lastId: "" } };
      job.mediaUploads = {};
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      await jobRequest(job, token, `/v1/pages/${job.notionPageId}`, {
        method: "PATCH",
        json: {
          erase_content: true,
          properties: buildPageProperties(job.schema, job, "Syncing")
        }
      });
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      return;
    }
    const page = await jobRequest(job, token, "/v1/pages", {
      method: "POST",
      json: {
        parent: { type: "data_source_id", data_source_id: job.destination.dataSourceId },
        properties: buildPageProperties(job.schema, job, "Syncing")
      }
    });
    job.notionPageId = page.id;
    job.notionPageUrl = resolveNotionPageUrl(page.url, page.id);
    job.knownChildren = { page: { count: 0, lastId: "" } };
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    const createdMapping = {
      key: job.mappingKey,
      connectionId: job.destination.connectionId,
      dataSourceId: job.destination.dataSourceId,
      sourceKey: job.sourceKey,
      notionPageId: page.id,
      notionPageUrl: resolveNotionPageUrl(page.url, page.id),
      lastEditedTime: page.last_edited_time || "",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await putRecord(MAPPING_STORE, createdMapping);
    await saveRemoteMapping(job, createdMapping);
  }

  function richTextSignature(items) {
    return (Array.isArray(items) ? items : []).map((item) => {
      if (item && item.type === "equation") return { type: "equation", expression: item.equation && item.equation.expression || "" };
      const annotations = item && item.annotations || {};
      return {
        type: "text",
        content: item && item.text && item.text.content || item && item.plain_text || "",
        link: item && item.text && item.text.link && item.text.link.url || item && item.href || "",
        annotations: {
          bold: Boolean(annotations.bold), italic: Boolean(annotations.italic),
          strikethrough: Boolean(annotations.strikethrough), underline: Boolean(annotations.underline),
          code: Boolean(annotations.code), color: annotations.color || "default"
        }
      };
    });
  }

  function blockSignature(block) {
    const type = block && block.type || "";
    const value = block && block[type] || {};
    const signature = { type };
    if (["paragraph", "heading_1", "heading_2", "heading_3", "quote", "bulleted_list_item", "numbered_list_item", "toggle", "callout"].includes(type)) {
      signature.richText = richTextSignature(value.rich_text);
      signature.color = value.color || "default";
      if (type === "callout") signature.icon = value.icon && (value.icon.emoji || value.icon.type) || "";
    } else if (type === "code") {
      signature.richText = richTextSignature(value.rich_text);
      signature.language = value.language || "plain text";
    } else if (type === "equation") {
      signature.expression = value.expression || "";
    } else if (type === "image") {
      signature.caption = richTextSignature(value.caption);
    } else if (type === "table") {
      signature.width = value.table_width;
      signature.columnHeader = Boolean(value.has_column_header);
      signature.rowHeader = Boolean(value.has_row_header);
    } else if (type === "table_row") {
      signature.cells = (value.cells || []).map(richTextSignature);
    }
    return JSON.stringify(signature);
  }

  async function retrieveAllChildren(job, parentId, token) {
    const children = [];
    let cursor = null;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const payload = await jobRequest(job, token, `/v1/blocks/${encodeURIComponent(parentId)}/children?${query.toString()}`, {});
      children.push(...(payload.results || []));
      cursor = payload.has_more ? payload.next_cursor : null;
    } while (cursor);
    return children;
  }

  async function reconcileInFlightOperation(job, operations, token) {
    const state = job.inFlightOperation;
    if (!state) return;
    const operation = operations[state.index];
    if (!operation || operation.id !== state.operationId) {
      throw createNotionError("The saved Notion checkpoint no longer matches this render plan.", 400, "checkpoint_plan_mismatch");
    }
    const children = await retrieveAllChildren(job, state.parentId, token);
    const sameBeforeState = children.length === state.beforeCount &&
      (state.beforeLastId ? children.at(-1) && children.at(-1).id === state.beforeLastId : children.length === 0);
    if (sameBeforeState) {
      job.inFlightOperation = null;
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      return;
    }
    const beforeLastIndex = state.beforeLastId
      ? children.findIndex((child) => child.id === state.beforeLastId)
      : -1;
    if (state.beforeLastId && beforeLastIndex < 0) {
      throw createNotionError(
        "The parent block changed while recovering a previous append. Choose Replace to avoid duplicate content.",
        400,
        "ambiguous_append_result"
      );
    }
    const searchStart = beforeLastIndex >= 0 ? beforeLastIndex + 1 : 0;
    let matchedAt = -1;
    for (let index = searchStart; index <= children.length - state.signatures.length; index += 1) {
      const matches = state.signatures.every((signature, offset) => blockSignature(children[index + offset]) === signature);
      if (matches) { matchedAt = index; break; }
    }
    if (matchedAt < 0) {
      throw createNotionError(
        "A previous append request had an ambiguous result. Choose Replace to rebuild safely instead of risking duplicate blocks.",
        400,
        "ambiguous_append_result"
      );
    }
    operation.entries.forEach((entry, index) => {
      const child = children[matchedAt + index];
      if (child && child.id) {
        job.blockRefs[entry.localId] = child.id;
        job.knownChildren = job.knownChildren || {};
        job.knownChildren[entry.localId] = { count: 0, lastId: "" };
      }
    });
    job.knownChildren = job.knownChildren || {};
    job.knownChildren[operation.parentRef] = {
      count: children.length,
      lastId: children.at(-1) && children.at(-1).id || ""
    };
    job.currentOperation = state.index + 1;
    job.inFlightOperation = null;
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
  }

  async function executeOperation(job, operation, operationIndex, token) {
    const parentId = operation.parentRef === "page" ? job.notionPageId : job.blockRefs[operation.parentRef];
    if (!parentId) throw createNotionError("Notion render plan parent is unresolved.", 400, "render_parent_missing");
    const blocks = [];
    for (const entry of operation.entries) {
      const block = JSON.parse(JSON.stringify(entry.block));
      if (entry.mediaRef) {
        try {
          const uploadId = await uploadMedia(job, entry.mediaRef, token);
          block.image.type = "file_upload";
          block.image.file_upload = { id: uploadId };
        } catch (error) {
          if (!shouldDegradeMediaUploadError(error)) throw error;
          job.partial = true;
          const media = (job.media || []).find((item) => item && item.id === entry.mediaRef);
          job.warnings.push({
            code: "image_upload_failed",
            detail: `The image "${String(media && media.alt || "Image").slice(0, 120)}" could not be uploaded after bounded retries, so a visible placeholder was inserted.`
          });
          delete job.mediaUploads[entry.mediaRef];
          blocks.push(unavailableImageCallout(media, error && (error.code || error.message)));
          continue;
        }
      }
      blocks.push(block);
    }
    job.knownChildren = job.knownChildren || {};
    const knownState = job.knownChildren[operation.parentRef];
    const beforeChildren = knownState && Number.isInteger(knownState.count)
      ? null
      : await retrieveAllChildren(job, parentId, token);
    const beforeCount = beforeChildren ? beforeChildren.length : knownState.count;
    const beforeLastId = beforeChildren
      ? beforeChildren.at(-1) && beforeChildren.at(-1).id || ""
      : String(knownState.lastId || "");
    job.inFlightOperation = {
      index: operationIndex,
      operationId: operation.id,
      parentId,
      beforeCount,
      beforeLastId,
      signatures: blocks.map(blockSignature)
    };
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    let response;
    try {
      response = await jobRequest(job, token, `/v1/blocks/${parentId}/children`, {
        method: "PATCH",
        json: { children: blocks }
      });
    } catch (error) {
      if ([400, 401, 403, 404, 409, 429, 529].includes(Number(error && error.status || 0))) {
        job.inFlightOperation = null;
        job.updatedAt = Date.now();
        await putRecord(JOB_STORE, job);
      }
      throw error;
    }
    const results = response.results || [];
    operation.entries.forEach((entry, index) => {
      if (results[index] && results[index].id) {
        job.blockRefs[entry.localId] = results[index].id;
        job.knownChildren[entry.localId] = { count: 0, lastId: "" };
      }
    });
    job.knownChildren[operation.parentRef] = {
      count: beforeCount + results.length,
      lastId: results.at(-1) && results.at(-1).id || beforeLastId
    };
  }

  async function finalizeJob(job, token) {
    let finalizedPage = null;
    if (job.schema) {
      finalizedPage = await jobRequest(job, token, `/v1/pages/${job.notionPageId}`, {
        method: "PATCH",
        json: { properties: buildPageProperties(job.schema, job, job.partial ? "Partial" : "Synced") }
      });
    }
    if (!job.alwaysCreate) {
      const planFingerprint = await fingerprintPlan(job.renderPlan);
      const completedMapping = {
        key: job.mappingKey,
        connectionId: job.destination.connectionId,
        dataSourceId: job.destination.dataSourceId,
        sourceKey: job.sourceKey,
        notionPageId: job.notionPageId,
        notionPageUrl: job.notionPageUrl,
        lastEditedTime: finalizedPage && finalizedPage.last_edited_time || "",
        sourceRevision: job.sourceRevision || "",
        rendererVersion: job.renderPlan.rendererVersion,
        planFingerprint,
        blockRefs: { ...(job.blockRefs || {}) },
        status: "active",
        createdAt: job.createdAt,
        updatedAt: Date.now()
      };
      await putRecord(MAPPING_STORE, completedMapping);
      await saveRemoteMapping(job, completedMapping);
    }
    job.status = job.partial ? "partial" : "succeeded";
    job.progress = 100;
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    broadcastJob(job);
    await notifyJob(job);
    clearJobSnapshot(job);
    await putRecord(JOB_STORE, job);
  }

  async function processJob(job) {
    if (job.status === "cancelled") return;
    const jobController = new AbortController();
    activeJobControllers.set(job.id, jobController);
    job.status = "running";
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    broadcastJob(job);
    try {
      const token = await getNotionToken(job.destination.connectionId);
      await ensurePage(job, token);
      if (job.status === "succeeded") {
        broadcastJob(job);
        await notifyJob(job);
        return;
      }
      const operations = Array.isArray(job.executionPlan) ? job.executionPlan : job.renderPlan.operations || [];
      await reconcileInFlightOperation(job, operations, token);
      while (job.currentOperation < operations.length) {
        const latest = await getRecord(JOB_STORE, job.id);
        if (!latest || latest.status === "cancelled") return;
        await executeOperation(job, operations[job.currentOperation], job.currentOperation, token);
        job.currentOperation += 1;
        job.inFlightOperation = null;
        job.progress = operations.length ? Math.min(98, Math.round(job.currentOperation / operations.length * 95)) : 95;
        job.updatedAt = Date.now();
        await putRecord(JOB_STORE, job);
        broadcastJob(job);
      }
      job.progress = 98;
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      broadcastJob(job);
      await finalizeJob(job, token);
    } catch (error) {
      const latest = await getRecord(JOB_STORE, job.id);
      if (jobController.signal.aborted || latest && latest.status === "cancelled") return;
      if (Number(error && error.status || 0) === 401 &&
          !String(job.destination.connectionId || "").startsWith("manual_") &&
          !job.authRefreshAttempted) {
        job.authRefreshAttempted = true;
        try {
          await getNotionToken(job.destination.connectionId, true);
          job.status = "pending";
          job.updatedAt = Date.now();
          await putRecord(JOB_STORE, job);
          broadcastJob(job);
          schedulePump(20);
          return;
        } catch (refreshError) {
          error = refreshError;
        }
      }
      job.attempt = Number(job.attempt || 0) + 1;
      const retryable = [0, 409, 429, 500, 502, 503, 504, 529].includes(Number(error && error.status || 0));
      const retryDelay = Math.max(
        Number(error && error.retryAfter || 0) * 1000,
        Math.min(15 * 60 * 1000, 2000 * Math.pow(2, job.attempt))
      ) + Math.floor(Math.random() * 500);
      job.totalRetryWaitMs = Number(job.totalRetryWaitMs || 0) + retryDelay;
      if (retryable && job.attempt < 5 && job.totalRetryWaitMs <= 30 * 60 * 1000) {
        job.status = "retry_wait";
        job.nextAttemptAt = Date.now() + retryDelay;
        job.errorCode = error.code || "retryable_error";
        job.errorMessage = userFacingJobError(error);
        job.errorRequestId = String(error && error.requestId || "").slice(0, 120);
        schedulePumpAt(job.nextAttemptAt);
      } else {
        job.status = "failed";
        job.errorCode = error.code || "notion_sync_failed";
        job.errorMessage = userFacingJobError(error);
        job.errorRequestId = String(error && error.requestId || "").slice(0, 120);
        await notifyJob(job);
      }
      job.updatedAt = Date.now();
      await putRecord(JOB_STORE, job);
      broadcastJob(job);
    } finally {
      activeJobControllers.delete(job.id);
    }
  }

  async function pump() {
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      const jobs = await listJobs();
      const now = Date.now();
      for (const job of jobs.reverse()) {
        if (job.status === "running" && now - Number(job.updatedAt || 0) > 60000) {
          job.status = "pending";
          await putRecord(JOB_STORE, job);
        }
        if (job.status === "pending" || job.status === "retry_wait" && Number(job.nextAttemptAt || 0) <= now) {
          await processJob(job);
        }
      }
      await cleanupExpiredJobs();
    })().finally(() => { pumpPromise = null; });
    return pumpPromise;
  }

  async function cleanupExpiredJobs() {
    const jobs = await listJobs();
    const now = Date.now();
    let retainedCompleted = 0;
    for (const job of jobs) {
      if (job.status === "held" && now - Number(job.updatedAt || 0) > 10 * 60 * 1000) {
        await deleteRecord(JOB_STORE, job.id);
        continue;
      }
      if (["failed", "cancelled"].includes(job.status) && Number(job.expiresAt || 0) < now) {
        await deleteRecord(JOB_STORE, job.id);
        continue;
      }
      if (["succeeded", "partial"].includes(job.status)) {
        retainedCompleted += 1;
        const olderThanThirtyDays = now - Number(job.updatedAt || 0) > 30 * 24 * 60 * 60 * 1000;
        if (retainedCompleted > 50 || olderThanThirtyDays) await deleteRecord(JOB_STORE, job.id);
      }
    }
  }

  function schedulePump(delayMs) {
    setTimeout(() => { pump().catch(() => {}); }, Math.max(0, Number(delayMs || 0)));
  }

  function schedulePumpAt(timestamp) {
    if (!chrome.alarms) return;
    const when = Math.max(Date.now() + 1000, timestamp);
    chrome.alarms.get(RETRY_ALARM_NAME, (alarm) => {
      if (!alarm || Number(alarm.scheduledTime || Infinity) > when) {
        chrome.alarms.create(RETRY_ALARM_NAME, { when });
      }
    });
  }

  function broadcastJob(job) {
    const payload = { type: "CHATVAULT_NOTION_JOB_STATUS", job: safeJob(job) };
    try {
      chrome.runtime.sendMessage(payload, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {}
    if (Number.isInteger(job && job.sourceTabId) && chrome.tabs && typeof chrome.tabs.sendMessage === "function") {
      try {
        chrome.tabs.sendMessage(job.sourceTabId, payload, () => {
          void chrome.runtime.lastError;
        });
      } catch (error) {}
    }
  }

  async function notifyJob(job) {
    if (!chrome.notifications) return;
    const notificationId = `chatvault-notion-${job.id}`;
    const message = job.status === "failed"
      ? `Notion sync failed (${job.errorCode || "sync_error"}). Open ChatVault for details.`
      : job.status === "partial"
        ? "Notion sync completed with warnings."
        : "Notion sync completed.";
    const notionPageUrl = resolveNotionPageUrl(job.notionPageUrl, job.notionPageId);
    if (notionPageUrl) {
      const links = await storageGet("local", NOTIFICATION_LINKS_KEY) || {};
      links[notificationId] = notionPageUrl;
      await storageSet("local", { [NOTIFICATION_LINKS_KEY]: links });
    }
    try {
      await chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("images/store-icon-128.png"),
        title: "ChatVault → Notion",
        message
      });
    } catch (error) {
      // Desktop notifications are optional and must never turn a completed
      // Notion job into an unhandled rejection or failed sync.
    }
  }

  async function listConnections() {
    const manual = await getManualConfig();
    const output = [];
    if (manual && manual.token && manual.connectionId) {
      output.push({ id: manual.connectionId, workspace_name: "Manual integration", mode: "manual", data_source_id: manual.dataSourceId });
    }
    try {
      const payload = await callEdgeFunction("notion-connection-token", { method: "GET" });
      (payload.connections || []).forEach((connection) => output.push({ ...connection, mode: "oauth" }));
    } catch (error) {
      if (!output.length && error.status !== 401) throw error;
    }
    return output;
  }

  async function searchDataSources(connectionId) {
    const token = await getNotionToken(connectionId);
    const results = [];
    let cursor = null;
    do {
      const payload = await notionRequest(connectionId, token, "/v1/search", {
        method: "POST",
        json: {
          filter: { property: "object", value: "data_source" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {})
        }
      });
      (payload.results || []).forEach((item) => {
        results.push({
          id: item.id,
          databaseId: item.parent && item.parent.database_id || "",
          title: (item.title || []).map((part) => part.plain_text || part.text && part.text.content || "").join("") || "Untitled data source"
        });
      });
      cursor = payload.has_more ? payload.next_cursor : null;
    } while (cursor);
    return results;
  }

  function notionObjectTitle(item) {
    const direct = Array.isArray(item && item.title) ? item.title : [];
    if (direct.length) {
      return direct.map((part) => part.plain_text || part.text && part.text.content || "").join("") || "Untitled";
    }
    const titleProperty = Object.values(item && item.properties || {}).find((property) => property && property.type === "title");
    return (titleProperty && titleProperty.title || [])
      .map((part) => part.plain_text || part.text && part.text.content || "")
      .join("") || "Untitled page";
  }

  async function searchPages(connectionId) {
    const token = await getNotionToken(connectionId);
    const results = [];
    let cursor = null;
    do {
      const payload = await notionRequest(connectionId, token, "/v1/search", {
        method: "POST",
        json: {
          filter: { property: "object", value: "page" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {})
        }
      });
      (payload.results || []).forEach((item) => {
        if (!item || !item.id || item.in_trash) return;
        results.push({ id: item.id, title: notionObjectTitle(item) });
      });
      cursor = payload.has_more ? payload.next_cursor : null;
    } while (cursor);
    return results;
  }

  async function createChatVaultDatabase(connectionId, parentPageId, title) {
    const normalizedParent = String(parentPageId || "").trim();
    const normalizedTitle = String(title || "ChatVault Conversations").trim().slice(0, 120) || "ChatVault Conversations";
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(normalizedParent)) {
      throw createNotionError("Select a valid Notion parent page.", 400, "invalid_parent_page");
    }
    const token = await getNotionToken(connectionId);
    const created = await notionRequest(connectionId, token, "/v1/databases", {
      method: "POST",
      json: {
        parent: { type: "page_id", page_id: normalizedParent },
        title: [{ type: "text", text: { content: normalizedTitle } }],
        initial_data_source: {
          properties: {
            Name: { type: "title", title: {} },
            Platform: { type: "select", select: {} },
            Model: { type: "select", select: {} },
            "Source URL": { type: "url", url: {} },
            Tags: { type: "multi_select", multi_select: {} },
            "Sync Time": { type: "date", date: {} },
            "Source ID": { type: "rich_text", rich_text: {} },
            "Sync Status": { type: "select", select: {} },
            "Renderer Version": { type: "rich_text", rich_text: {} }
          }
        }
      }
    });
    let dataSource = Array.isArray(created.data_sources) ? created.data_sources[0] : null;
    if (!dataSource && created.id) {
      const retrieved = await notionRequest(connectionId, token, `/v1/databases/${encodeURIComponent(created.id)}`, {});
      dataSource = Array.isArray(retrieved.data_sources) ? retrieved.data_sources[0] : null;
    }
    if (!created.id || !dataSource || !dataSource.id) {
      throw createNotionError("Notion created the database but did not return its initial Data Source.", 502, "data_source_create_incomplete");
    }
    return {
      databaseId: created.id,
      dataSourceId: dataSource.id,
      title: dataSource.name || normalizedTitle,
      url: created.url || ""
    };
  }

  async function startOAuth() {
    if (!chrome.identity || typeof chrome.identity.launchWebAuthFlow !== "function") throw new Error("Chrome identity API is unavailable.");
    const finalRedirectUri = chrome.identity.getRedirectURL("notion");
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const flowVerifier = Array.from(verifierBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const flowChallenge = await sha256Text(flowVerifier);
    const started = await callEdgeFunction("notion-oauth-start", {
      body: { final_redirect_uri: finalRedirectUri, flow_challenge: flowChallenge }
    });
    if (!started.authorization_url) throw new Error("Notion OAuth start did not return an authorization URL.");
    const finalUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: started.authorization_url, interactive: true }, (redirectUrl) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(redirectUrl);
      });
    });
    const resultUrl = new URL(finalUrl);
    const resultCode = resultUrl.searchParams.get("result_code");
    if (!resultCode) throw new Error(resultUrl.searchParams.get("error") || "Notion OAuth callback was incomplete.");
    return callEdgeFunction("notion-connection-token", {
      body: { result_code: resultCode, flow_verifier: flowVerifier, action: "complete_oauth" }
    });
  }

  async function disconnectConnection(connectionId) {
    if (String(connectionId || "").startsWith("manual_")) {
      await clearManualConfig();
      await cleanupConnectionLocalState(connectionId);
      return { ok: true };
    }
    const result = await callEdgeFunction("notion-revoke", { body: { connection_id: connectionId } });
    await cleanupConnectionLocalState(connectionId);
    return result;
  }

  async function cancelJob(jobId) {
    const job = await getRecord(JOB_STORE, jobId);
    if (!job) throw new Error("Notion job was not found.");
    if (["succeeded", "partial", "failed"].includes(job.status)) return safeJob(job);
    job.status = "cancelled";
    const controller = activeJobControllers.get(jobId);
    if (controller) controller.abort();
    clearJobSnapshot(job);
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    broadcastJob(job);
    return safeJob(job);
  }

  async function retryJob(jobId) {
    const job = await getRecord(JOB_STORE, jobId);
    if (!job || job.status !== "failed") throw new Error("Only failed Notion jobs can be retried.");
    job.status = "pending";
    job.errorCode = "";
    job.errorMessage = "";
    job.errorRequestId = "";
    job.attempt = 0;
    job.totalRetryWaitMs = 0;
    job.authRefreshAttempted = false;
    job.updatedAt = Date.now();
    await putRecord(JOB_STORE, job);
    schedulePump(20);
    return safeJob(job);
  }

  async function clearJob(jobId) {
    const job = await getRecord(JOB_STORE, jobId);
    if (!job) return { id: jobId, status: "cleared" };
    const controller = activeJobControllers.get(jobId);
    if (controller) controller.abort();
    clearJobSnapshot(job);
    await deleteRecord(JOB_STORE, jobId);
    return { id: jobId, status: "cleared" };
  }

  function normalizeNotionPageUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const hostname = url.hostname.toLowerCase();
      const trustedHost = hostname === "notion.so" || hostname.endsWith(".notion.so") ||
        hostname === "notion.site" || hostname.endsWith(".notion.site");
      return url.protocol === "https:" && trustedHost ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function resolveNotionPageUrl(value, pageId) {
    const normalized = normalizeNotionPageUrl(value);
    if (normalized) return normalized;
    const compactPageId = String(pageId || "").replace(/-/g, "");
    return /^[a-f0-9]{32}$/i.test(compactPageId)
      ? `https://www.notion.so/${compactPageId}`
      : "";
  }

  async function handleMessage(message, sender) {
    switch (message.type) {
      case "CHATVAULT_NOTION_ENQUEUE":
        return { ok: true, job: await enqueueSnapshot(message.snapshot, {
          deferStart: Boolean(message.deferStart),
          sourceTabId: sender && sender.tab && sender.tab.id
        }) };
      case "CHATVAULT_NOTION_RELEASE_JOB":
        return { ok: true, job: await releaseJob(message.jobId) };
      case "CHATVAULT_NOTION_LIST_JOBS":
        return { ok: true, jobs: (await listJobs()).map(safeJob) };
      case "CHATVAULT_NOTION_CANCEL_JOB":
        return { ok: true, job: await cancelJob(message.jobId) };
      case "CHATVAULT_NOTION_RETRY_JOB":
        return { ok: true, job: await retryJob(message.jobId) };
      case "CHATVAULT_NOTION_CLEAR_JOB":
        return { ok: true, job: await clearJob(message.jobId) };
      case "CHATVAULT_NOTION_SET_MANUAL_CONFIG":
        return { ok: true, connection: await setManualConfig(message.token, message.dataSourceId) };
      case "CHATVAULT_NOTION_MIGRATE_MANUAL_CONFIG":
        return { ok: true, connection: await migrateLegacyManualConfig(message.token, message.databaseId) };
      case "CHATVAULT_NOTION_CLEAR_MANUAL_CONFIG":
        await clearManualConfig(); return { ok: true };
      case "CHATVAULT_NOTION_LIST_CONNECTIONS":
        return { ok: true, connections: await listConnections() };
      case "CHATVAULT_NOTION_SEARCH_DATA_SOURCES":
        return { ok: true, dataSources: await searchDataSources(message.connectionId) };
      case "CHATVAULT_NOTION_SEARCH_PAGES":
        return { ok: true, pages: await searchPages(message.connectionId) };
      case "CHATVAULT_NOTION_CREATE_DATABASE":
        return { ok: true, destination: await createChatVaultDatabase(message.connectionId, message.parentPageId, message.title) };
      case "CHATVAULT_NOTION_START_OAUTH":
        return { ok: true, result: await startOAuth() };
      case "CHATVAULT_NOTION_DISCONNECT":
        return { ok: true, result: await disconnectConnection(message.connectionId) };
      case "CHATVAULT_NOTION_OPEN_PAGE": {
        const url = normalizeNotionPageUrl(message.url);
        if (!url) throw createNotionError("Invalid Notion page URL.", 400, "invalid_notion_page_url");
        await chrome.tabs.create({ url });
        return { ok: true };
      }
      default:
        return null;
    }
  }

  const MESSAGE_TYPES = new Set([
    "CHATVAULT_NOTION_ENQUEUE", "CHATVAULT_NOTION_RELEASE_JOB", "CHATVAULT_NOTION_LIST_JOBS", "CHATVAULT_NOTION_CANCEL_JOB",
    "CHATVAULT_NOTION_RETRY_JOB", "CHATVAULT_NOTION_CLEAR_JOB", "CHATVAULT_NOTION_SET_MANUAL_CONFIG",
    "CHATVAULT_NOTION_MIGRATE_MANUAL_CONFIG",
    "CHATVAULT_NOTION_CLEAR_MANUAL_CONFIG", "CHATVAULT_NOTION_LIST_CONNECTIONS",
    "CHATVAULT_NOTION_SEARCH_DATA_SOURCES", "CHATVAULT_NOTION_SEARCH_PAGES",
    "CHATVAULT_NOTION_CREATE_DATABASE", "CHATVAULT_NOTION_START_OAUTH", "CHATVAULT_NOTION_DISCONNECT",
    "CHATVAULT_NOTION_OPEN_PAGE"
  ]);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !MESSAGE_TYPES.has(message.type)) return false;
    if (!isTrustedSender(sender)) {
      sendResponse({ ok: false, error: "SecurityError: Untrusted Notion message sender." });
      return false;
    }
    handleMessage(message, sender).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: safeErrorDetail(error), code: error.code || "notion_background_error" });
    });
    return true;
  });

  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && [ALARM_NAME, RETRY_ALARM_NAME].includes(alarm.name)) pump().catch(() => {});
    });
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
  if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => pump().catch(() => {}));
  if (chrome.runtime.onInstalled) chrome.runtime.onInstalled.addListener(() => pump().catch(() => {}));
  if (chrome.notifications && chrome.notifications.onClicked) {
    chrome.notifications.onClicked.addListener(async (notificationId) => {
      if (!notificationId.startsWith("chatvault-notion-")) return;
      const links = await storageGet("local", NOTIFICATION_LINKS_KEY) || {};
      const url = links[notificationId];
      if (url) chrome.tabs.create({ url });
      delete links[notificationId];
      await storageSet("local", { [NOTIFICATION_LINKS_KEY]: links });
      chrome.notifications.clear(notificationId);
    });
  }

  globalThis.CHATVAULT_NOTION_BACKGROUND = {
    enqueueSnapshot,
    listJobs,
    pump,
    searchDataSources,
    _test: {
      validateSnapshot, mappingKey, buildPageProperties, safeErrorDetail, fingerprintPlan,
      appendOnlyOperations, shouldDegradeMediaUploadError, resolveNotionPageUrl, safeJob
    }
  };

  schedulePump(100);
})();
