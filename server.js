/**
 * KAC8 WhatsApp Gateway — production-hardened whatsapp-web.js + Express
 *
 * Deploy on wa.kac8.codes (separate from Next.js).
 * Matches store env: WHATSAPP_API_URL=https://wa.kac8.codes/send
 *
 * Endpoints:
 *   GET  /health, /status, /qr
 *   GET  /groups
 *   POST /send          { phone|number|to, message|text }
 *   POST /send/group    { group|jid|to, message|text }
 */

import express from "express";
import QRCode from "qrcode";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "whatsapp-web.js";

const { Client, LocalAuth } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load ~/kac8-wa-server/.env when not injected by systemd EnvironmentFile */
function loadDotEnv() {
  for (const name of [".env", ".env.local"]) {
    const envPath = path.join(__dirname, name);
    if (!fs.existsSync(envPath)) continue;
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/);
      if (!m) continue;
      const key = m[1];
      let val = (m[2] ?? "").trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    console.log(`[wa-gateway] loaded env from ${envPath}`);
    break;
  }
}

loadDotEnv();

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_TOKEN = (process.env.API_TOKEN ?? process.env.WHATSAPP_API_TOKEN ?? "").trim();

const DATA_PATH = path.resolve(
  process.env.WWEBJS_DATA_PATH ?? path.join(__dirname, ".wwebjs_auth"),
);
const CACHE_PATH = path.resolve(
  process.env.WWEBJS_CACHE_PATH ?? path.join(__dirname, ".wwebjs_cache"),
);
const USER_DATA_DIR = process.env.PUPPETEER_USER_DATA_DIR
  ? path.resolve(process.env.PUPPETEER_USER_DATA_DIR)
  : undefined;

const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 8 * 60 * 1000);
const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS ?? 5000);
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS ?? 120_000);

for (const dir of [DATA_PATH, CACHE_PATH, USER_DATA_DIR].filter(Boolean)) {
  fs.mkdirSync(dir, { recursive: true });
}

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--hide-scrollbars",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-default-browser-check",
  "--window-size=1280,720",
];

// Optional on very small VPS (256–512 MB): uncomment if Chromium still OOMs
// PUPPETEER_ARGS.push("--single-process");

// ─── Client state ─────────────────────────────────────────────────────────────

/** @type {import('whatsapp-web.js').Client | null} */
let client = null;
let clientGen = 0;
let reconnectAttempt = 0;
let reconnectTimer = null;
let readyTimer = null;
let initInFlight = false;

let lastQr = "";
let lastQrAt = 0;
let waState = "BOOTING";
let isReady = false;
let lastError = null;
let lastReadyAt = null;
let authenticatedAt = null;

function setState(next) {
  waState = next;
  console.log(`[wa-gateway] state → ${next}`);
}

function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}

function scheduleReadyWatchdog() {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (!isReady) {
      console.error(
        `[wa-gateway] READY timeout after ${READY_TIMEOUT_MS}ms (stuck syncing?) — restarting client`,
      );
      lastError = "ready_timeout_syncing";
      restartClient("ready_timeout");
    }
  }, READY_TIMEOUT_MS);
}

function backoffMs() {
  const ms = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
  return ms + Math.floor(Math.random() * 1000);
}

async function destroyClient() {
  const c = client;
  client = null;
  isReady = false;
  if (!c) return;
  try {
    c.removeAllListeners();
    await c.destroy();
  } catch (err) {
    console.warn("[wa-gateway] destroy error:", err?.message ?? err);
  }
}

async function restartClient(reason) {
  if (initInFlight) return;
  clearTimers();
  console.warn(`[wa-gateway] restart scheduled (${reason})`);
  await destroyClient();
  const delay = backoffMs();
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initClient().catch((err) => {
      console.error("[wa-gateway] re-init failed:", err);
      restartClient("init_failed");
    });
  }, delay);
}

async function initClient() {
  if (initInFlight) return;
  initInFlight = true;
  clearTimers();
  await destroyClient();

  const gen = ++clientGen;
  setState("INITIALIZING");
  lastError = null;
  isReady = false;
  authenticatedAt = null;

  const webVersion = process.env.WWEBJS_WEB_VERSION?.trim();

  const puppeteer = {
    headless: true,
    args: PUPPETEER_ARGS,
    ...(USER_DATA_DIR ? { userDataDir: USER_DATA_DIR } : {}),
  };

  const options = {
    authStrategy: new LocalAuth({
      clientId: "kac8-store",
      dataPath: DATA_PATH,
    }),
    puppeteer,
    ...(webVersion ? { webVersion } : {}),
  };

  console.log("[wa-gateway] initializing client", {
    dataPath: DATA_PATH,
    cachePath: CACHE_PATH,
    userDataDir: USER_DATA_DIR ?? "(default)",
  });

  const c = new Client(options);
  client = c;

  c.on("qr", (qr) => {
    if (gen !== clientGen) return;
    lastQr = qr;
    lastQrAt = Date.now();
    setState("QR");
    console.log("[wa-gateway] QR updated — scan at GET /qr");
  });

  c.on("authenticated", () => {
    if (gen !== clientGen) return;
    authenticatedAt = Date.now();
    setState("AUTHENTICATED");
    console.log("[wa-gateway] authenticated — waiting for ready/sync");
    scheduleReadyWatchdog();
  });

  c.on("auth_failure", (msg) => {
    if (gen !== clientGen) return;
    lastError = `auth_failure:${msg}`;
    setState("AUTH_FAILURE");
    console.error("[wa-gateway] auth_failure:", msg);
    restartClient("auth_failure");
  });

  c.on("ready", () => {
    if (gen !== clientGen) return;
    clearTimers();
    isReady = true;
    lastReadyAt = Date.now();
    reconnectAttempt = 0;
    lastQr = "";
    setState("READY");
    console.log("[wa-gateway] READY — session persisted at", DATA_PATH);
  });

  c.on("change_state", (state) => {
    if (gen !== clientGen) return;
    console.log("[wa-gateway] change_state:", state);
    if (state === "CONFLICT" || state === "UNPAIRED" || state === "UNLAUNCHED") {
      lastError = `bad_state:${state}`;
      restartClient(`state_${state}`);
    }
  });

  c.on("disconnected", (reason) => {
    if (gen !== clientGen) return;
    isReady = false;
    lastError = `disconnected:${reason}`;
    setState("DISCONNECTED");
    console.warn("[wa-gateway] disconnected:", reason);
    restartClient("disconnected");
  });

  c.on("loading_screen", (percent, message) => {
    if (gen !== clientGen) return;
    setState(`LOADING_${percent ?? 0}`);
    if (percent >= 99) scheduleReadyWatchdog();
    console.log(`[wa-gateway] loading ${percent}% — ${message ?? ""}`);
  });

  try {
    await c.initialize();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error("[wa-gateway] initialize threw:", lastError);
    if (gen === clientGen) restartClient("initialize_throw");
  } finally {
    initInFlight = false;
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "64kb" }));

function requireToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(503).json({
      success: false,
      reason: "API_TOKEN not configured on gateway",
    });
  }
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.apikey;
  if (token !== API_TOKEN) {
    return res.status(401).json({ success: false, reason: "Unauthorized" });
  }
  next();
}

function clientStatus() {
  return {
    success: true,
    ready: isReady,
    state: waState,
    authenticatedAt,
    lastReadyAt,
    lastQrAt: lastQrAt || null,
    lastError,
    dataPath: DATA_PATH,
    reconnectAttempt,
  };
}

function notReadyResponse(res) {
  return res.status(503).json({
    success: false,
    reason: "Client not ready",
    state: waState,
    hint:
      waState.startsWith("QR") || waState === "QR"
        ? "Scan QR at /qr"
        : "Session syncing or reconnecting — check GET /status",
    ...clientStatus(),
  });
}

function pickMessage(body) {
  return String(body?.message ?? body?.text ?? "").trim();
}

/** Individual contact — never returns a group JID. */
function pickPhone(body) {
  const raw = body?.phone ?? body?.number ?? body?.to ?? "";
  const s = String(raw).trim();
  if (!s) return null;
  if (s.endsWith("@g.us")) return null;
  if (s.endsWith("@c.us")) {
    const n = s.slice(0, -5).replace(/\D/g, "");
    return n.length >= 8 && n.length <= 15 ? n : null;
  }
  const digits = s.replace(/[^\d+]/g, "");
  if (!/^\+?\d{8,15}$/.test(digits)) return null;
  return digits.startsWith("+") ? digits.slice(1) : digits;
}

/** Group JID — only from explicit group fields (never from `phone`). */
function pickGroupJid(body) {
  const raw = body?.group ?? body?.jid ?? "";
  let s = String(raw).trim();
  if (!s) {
    const to = String(body?.to ?? "").trim();
    if (to.endsWith("@g.us")) s = to;
  }
  if (!s) return null;
  if (s.endsWith("@g.us")) return s;
  const digits = s.replace(/\D/g, "");
  // WhatsApp group IDs are typically 18–22 digits; phones are ≤15.
  if (digits.length >= 16 && digits.length <= 25) return `${digits}@g.us`;
  return null;
}

function toContactJid(phoneDigits) {
  return `${phoneDigits}@c.us`;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...clientStatus() });
});

app.get("/status", (_req, res) => {
  res.json(clientStatus());
});

app.get("/qr", async (_req, res) => {
  if (isReady) {
    return res.type("html").send(
      "<html><body style='font-family:sans-serif;background:#111;color:#eee;padding:2rem'>" +
        "<h2>✅ WhatsApp connected</h2><p>Session is ready. No QR needed.</p>" +
        `<p><a href="/status" style="color:#7dc857">/status</a></p></body></html>`,
    );
  }
  if (!lastQr) {
    return res.type("html").send(
      "<html><body style='font-family:sans-serif;background:#111;color:#eee;padding:2rem'>" +
        `<h2>Waiting for QR…</h2><p>State: ${waState}</p>` +
        "<p>Refresh in a few seconds.</p>" +
        `<p><a href="/status" style="color:#7dc857">/status</a></p></body></html>`,
    );
  }
  const dataUrl = await QRCode.toDataURL(lastQr, { margin: 2, width: 320 });
  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>KAC8 WA QR</title>
<meta http-equiv="refresh" content="15"></head>
<body style="font-family:sans-serif;background:#111;color:#eee;padding:2rem;text-align:center">
<h2>Scan with WhatsApp</h2>
<p>State: ${waState}</p>
<img src="${dataUrl}" alt="QR" style="border-radius:12px;background:#fff;padding:12px"/>
<p style="opacity:.6;font-size:14px">Page auto-refreshes every 15s</p>
<p><a href="/status" style="color:#7dc857">JSON status</a></p>
</body></html>`);
});

app.get("/groups", requireToken, async (_req, res) => {
  if (!isReady || !client) return notReadyResponse(res);
  try {
    const chats = await client.getChats();
    const groups = chats
      .filter((c) => c.isGroup)
      .map((c) => ({
        id: c.id._serialized,
        jid: c.id._serialized,
        name: c.name ?? "(unnamed)",
      }));
    res.json({ success: true, groups });
  } catch (err) {
    res.status(500).json({
      success: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

async function sendText(jid, message, res, meta = {}) {
  if (!message) {
    return res.status(400).json({ success: false, reason: "empty_message" });
  }
  if (!isReady || !client) return notReadyResponse(res);
  const recipientType = jid.endsWith("@g.us") ? "group" : "contact";
  try {
    const result = await client.sendMessage(jid, message.slice(0, 4096));
    res.json({
      success: true,
      id: result?.id?._serialized ?? result?.id?.id,
      to: jid,
      recipientType,
      ...meta,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[wa-gateway] send failed:", msg, { jid, recipientType });
    res.status(500).json({ success: false, reason: msg, state: waState, to: jid, recipientType });
  }
}

/** Primary endpoint used by KAC8 store (WHATSAPP_API_URL) — individual contacts only */
app.post("/send", requireToken, async (req, res) => {
  const message = pickMessage(req.body);
  const phone = pickPhone(req.body);
  if (!phone) {
    return res.status(400).json({
      success: false,
      reason: "invalid_phone",
      hint: "Send { phone: '9665XXXXXXXX', message: '...' } — E.164 digits only, no @g.us",
    });
  }
  return sendText(toContactJid(phone), message, res, { phone });
});

app.post("/send/group", requireToken, async (req, res) => {
  const message = pickMessage(req.body);
  const groupJid = pickGroupJid(req.body);
  if (!groupJid) {
    return res.status(400).json({
      success: false,
      reason: "invalid_group",
      hint: "Provide group/jid as 120363…@g.us via { group: '...', message: '...' }",
    });
  }
  return sendText(groupJid, message, res, { group: groupJid });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, reason: "Not found" });
});

// ─── Process hygiene ──────────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("[wa-gateway] uncaughtException:", err);
  restartClient("uncaughtException").catch(() => {});
});

process.on("unhandledRejection", (err) => {
  console.error("[wa-gateway] unhandledRejection:", err);
});

process.on("SIGINT", async () => {
  console.log("[wa-gateway] SIGINT — shutting down");
  clearTimers();
  await destroyClient();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[wa-gateway] SIGTERM — shutting down");
  clearTimers();
  await destroyClient();
  process.exit(0);
});

app.listen(PORT, HOST, () => {
  console.log(`[wa-gateway] HTTP listening on http://${HOST}:${PORT}`);
  console.log(`[wa-gateway] QR page: http://${HOST}:${PORT}/qr`);
  console.log(`[wa-gateway] API_TOKEN configured: ${Boolean(API_TOKEN)}`);
  if (!API_TOKEN) {
    console.warn(
      "[wa-gateway] WARNING: set API_TOKEN in .env or systemd EnvironmentFile — POST /send will reject requests",
    );
  }
  initClient().catch((err) => {
    console.error("[wa-gateway] initial init failed:", err);
    restartClient("boot_init_failed");
  });
});
