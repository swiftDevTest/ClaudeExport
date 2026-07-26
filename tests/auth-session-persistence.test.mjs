import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const authSource = await readFile(new URL("../src/supabase-auth.js", import.meta.url), "utf8");
const SESSION_KEY = authSource.includes('const SESSION_KEY = "chatvault_supabase_session"')
  ? "chatvault_supabase_session"
  : "test.supabase_session.v1";

function createJwt(expiresAt) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: expiresAt })}.signature`;
}

function createSession(refreshToken, expiresInSeconds, user = { id: "user-1", email: "user@example.com" }) {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return {
    access_token: createJwt(expiresAt),
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    user
  };
}

function createStorage(initialSession) {
  const values = {
    [SESSION_KEY]: structuredClone(initialSession)
  };

  return {
    values,
    api: {
      get(keys, callback) {
        const requested = Array.isArray(keys) ? keys : [keys];
        callback(Object.fromEntries(requested.map((key) => [key, values[key]])));
      },
      set(updates, callback) {
        Object.assign(values, structuredClone(updates));
        callback?.();
      },
      remove(keys, callback) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete values[key];
        }
        callback?.();
      }
    }
  };
}

function loadAuth(storage, onMessage) {
  const apiCalls = [];
  const context = {
    AbortController,
    TextDecoder,
    Uint8Array,
    URL,
    URLSearchParams,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    chrome: {
      runtime: {
        id: "test-extension",
        lastError: null,
        sendMessage(message, callback) {
          onMessage(message, callback, context.chrome.runtime);
        }
      },
      storage: {
        local: storage.api
      }
    },
    console,
    crypto: webcrypto,
    history: {
      replaceState() {}
    },
    setTimeout,
    clearTimeout,
    window: {
      location: {
        hash: "",
        href: "chrome-extension://test-extension/popup.html",
        pathname: "/popup.html",
        search: ""
      }
    },
    CHATVAULT_PRODUCT_CONFIG: {
      storageKey(name) {
        return `test.${name}`;
      }
    },
    CHATVAULT_SUPABASE_CONFIG: {},
    CHATVAULT_SUPABASE_API: {
      async request(path) {
        apiCalls.push(path);
        if (path === "/auth/v1/user") {
          return { id: "user-1", email: "user@example.com" };
        }
        return null;
      }
    }
  };
  context.globalThis = context;

  vm.runInNewContext(authSource, context, { filename: "supabase-auth.js" });
  return {
    apiCalls,
    auth: context.CHATVAULT_SUPABASE_AUTH
  };
}

test("a newly issued one-hour session is not refreshed immediately", async () => {
  const storage = createStorage(createSession("refresh-0", 3500));
  let refreshRequests = 0;
  const { auth } = loadAuth(storage, () => {
    refreshRequests += 1;
  });

  const session = await auth.getSession({ skipUserRefresh: true });

  assert.equal(session.refresh_token, "refresh-0");
  assert.equal(refreshRequests, 0);
});

test("a delayed refresh result cannot overwrite a newer rotated token", async () => {
  const storage = createStorage(createSession("refresh-0", -10));
  const { auth } = loadAuth(storage, (message, callback) => {
    assert.equal(message.type, "CHATVAULT_SUPABASE_REFRESH_SESSION");
    setTimeout(() => callback({ ok: true, session: createSession("refresh-1", 3600) }), 30);
  });

  const pending = auth.getSession({ skipUserRefresh: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  storage.values[SESSION_KEY] = createSession("refresh-2", 3600);

  const session = await pending;

  assert.equal(session.refresh_token, "refresh-2");
  assert.equal(storage.values[SESSION_KEY].refresh_token, "refresh-2");
});

test("an invalid stale refresh token does not clear a newer session", async () => {
  const storage = createStorage(createSession("refresh-0", -10));
  const { auth } = loadAuth(storage, (message, callback) => {
    assert.equal(message.type, "CHATVAULT_SUPABASE_REFRESH_SESSION");
    setTimeout(() => callback({
      ok: false,
      error: "Invalid Refresh Token: Refresh Token Not Found",
      status: 400
    }), 30);
  });

  const pending = auth.getSession({ skipUserRefresh: true, allowStaleOnError: false });
  await new Promise((resolve) => setTimeout(resolve, 5));
  storage.values[SESSION_KEY] = createSession("refresh-1", 3600);

  const session = await pending;

  assert.equal(session.refresh_token, "refresh-1");
  assert.equal(storage.values[SESSION_KEY].refresh_token, "refresh-1");
});

test("a temporary background failure keeps the stored login and never refreshes directly", async () => {
  const storage = createStorage(createSession("refresh-0", -10));
  const { auth, apiCalls } = loadAuth(storage, (_message, callback, runtime) => {
    runtime.lastError = { message: "Service worker restarted" };
    callback();
    runtime.lastError = null;
  });

  const session = await auth.getSession({ skipUserRefresh: true, allowStaleOnError: true });

  assert.equal(session.refresh_token, "refresh-0");
  assert.equal(storage.values[SESSION_KEY].refresh_token, "refresh-0");
  assert.equal(apiCalls.some((path) => path.includes("grant_type=refresh_token")), false);
});

test("sign out revokes only this product session", async () => {
  const storage = createStorage(createSession("refresh-0", 3600));
  const { auth, apiCalls } = loadAuth(storage, () => {});

  await auth.signOut();

  assert.equal(storage.values[SESSION_KEY], null);
  assert.equal(apiCalls.includes("/auth/v1/logout?scope=local"), true);
});
