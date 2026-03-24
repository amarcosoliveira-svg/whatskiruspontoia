const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 10000);
const AUTH_DIR = path.join(__dirname, "auth_info");
const DEFAULT_WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.SUPABASE_WEBHOOK_URL || null;
const MAX_405_RETRIES = 3;
const RETRY_DELAY_MS = 60_000;

const logger = pino({ level: "silent" });

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectedPhone = null;
let webhookUrl = DEFAULT_WEBHOOK_URL;
let reconnectAttempts = 0;
let blocked405 = false;
let lastError = null;
let lastIncomingMessage = null;
let lastWebhookResult = null;
let lastConnectionUpdate = null;
let startInFlight = null;
let retryTimer = null;

function json(res, payload, status = 200) {
  res.status(status).json(payload);
}

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function removeAuthDir() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
}

function resetRuntimeState({ keepWebhook = true } = {}) {
  qrCodeData = null;
  isConnected = false;
  connectedPhone = null;
  blocked405 = false;
  reconnectAttempts = 0;
  lastError = null;
  lastConnectionUpdate = null;
  lastIncomingMessage = null;
  lastWebhookResult = null;
  if (!keepWebhook) webhookUrl = DEFAULT_WEBHOOK_URL;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function unwrapMessageContainer(message) {
  if (!message) return null;

  const ephemeral = asRecord(message.ephemeralMessage);
  const ephemeralInner = asRecord(ephemeral && ephemeral.message);
  if (ephemeralInner) return unwrapMessageContainer(ephemeralInner);

  const viewOnce = asRecord(message.viewOnceMessage);
  const viewOnceInner = asRecord(viewOnce && viewOnce.message);
  if (viewOnceInner) return unwrapMessageContainer(viewOnceInner);

  const viewOnceV2 = asRecord(message.viewOnceMessageV2);
  const viewOnceV2Inner = asRecord(viewOnceV2 && viewOnceV2.message);
  if (viewOnceV2Inner) return unwrapMessageContainer(viewOnceV2Inner);

  return message;
}

function extractMessageText(message) {
  const normalized = unwrapMessageContainer(message);
  if (!normalized) return null;

  return pickString(
    normalized.conversation,
    asRecord(normalized.extendedTextMessage)?.text,
    asRecord(normalized.imageMessage)?.caption,
    asRecord(normalized.videoMessage)?.caption,
    asRecord(normalized.documentMessage)?.caption,
    asRecord(normalized.buttonsResponseMessage)?.selectedDisplayText,
    asRecord(normalized.listResponseMessage)?.title,
    asRecord(normalized.listResponseMessage)?.description,
    asRecord(normalized.templateButtonReplyMessage)?.selectedDisplayText,
    asRecord(normalized.interactiveResponseMessage)?.body,
  );
}

function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .replace(/@s\.whatsapp\.net$/, "")
    .replace(/@lid$/, "")
    .replace(/:\d+$/, "")
    .replace(/\D/g, "");
}

function buildHealthPayload() {
  return {
    connected: isConnected,
    status: isConnected ? "connected" : "disconnected",
    phone: connectedPhone,
    webhookConfigured: Boolean(webhookUrl),
    webhookUrl,
    blocked405,
    retryCount: reconnectAttempts,
    lastError,
    lastIncomingMessage,
    lastWebhookResult,
    qrAvailable: Boolean(qrCodeData),
    lastConnectionUpdate,
  };
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleReconnect(reason) {
  clearRetryTimer();

  if (blocked405 || reconnectAttempts >= MAX_405_RETRIES) {
    blocked405 = true;
    lastError = reason || `Bloqueado após ${MAX_405_RETRIES} tentativas com erro 405`;
    console.log(`[WhatsApp] ${lastError}`);
    return;
  }

  reconnectAttempts += 1;
  lastError = reason || `Erro 405 ao conectar. Tentativa ${reconnectAttempts}/${MAX_405_RETRIES}`;
  console.log(`[WhatsApp] ${lastError}. Nova tentativa em ${RETRY_DELAY_MS / 1000}s`);

  retryTimer = setTimeout(() => {
    startSock(true).catch((error) => {
      console.error("[WhatsApp] Falha ao reconectar:", error.message);
    });
  }, RETRY_DELAY_MS);
}

async function closeSocket() {
  clearRetryTimer();

  if (sock) {
    try {
      sock.ev.removeAllListeners("connection.update");
      sock.ev.removeAllListeners("creds.update");
      sock.ev.removeAllListeners("messages.upsert");
    } catch (_) {}

    try {
      if (typeof sock.end === "function") sock.end(new Error("manual_close"));
    } catch (_) {}
  }

  sock = null;
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
}

async function forwardIncomingMessage(payload) {
  if (!webhookUrl) {
    lastWebhookResult = {
      ok: false,
      status: null,
      error: "Webhook não configurado",
      at: new Date().toISOString(),
    };
    console.log("[Webhook] Não configurado; mensagem não encaminhada");
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await response.text();

    lastWebhookResult = {
      ok: response.ok,
      status: response.status,
      bodyPreview: text.slice(0, 400),
      at: new Date().toISOString(),
    };

    console.log(`[Webhook] Status ${response.status} | ok=${response.ok}`);
  } catch (error) {
    lastWebhookResult = {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    console.error("[Webhook] Erro ao encaminhar mensagem:", error.message);
  }
}

async function startSock(force = false) {
  if (startInFlight && !force) return startInFlight;

  startInFlight = (async () => {
    await closeSocket();
    ensureAuthDir();

    console.log("[WhatsApp] Iniciando conexão...");
    console.log(`[Server] Webhook URL: ${webhookUrl || "NOT SET"}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[WhatsApp] Using Baileys version: ${version.join(".")}`);

    const client = makeWASocket({
      version,
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ["Render WhatsApp Bridge", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    sock = client;
    client.ev.on("creds.update", saveCreds);

    client.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      lastConnectionUpdate = {
        connection: connection || null,
        hasQr: Boolean(qr),
        timestamp: new Date().toISOString(),
      };

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        isConnected = false;
        connectedPhone = null;
        blocked405 = false;
        lastError = null;
        console.log("[WhatsApp] QR code generated - scan at /qr-json");
      }

      if (connection === "open") {
        clearRetryTimer();
        isConnected = true;
        qrCodeData = null;
        connectedPhone = normalizePhone(client.user?.id || "") || client.user?.id || null;
        reconnectAttempts = 0;
        blocked405 = false;
        lastError = null;
        console.log(`[WhatsApp] Connected as ${connectedPhone || "unknown"}`);
      }

      if (connection === "close") {
        isConnected = false;
        connectedPhone = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || null;
        const message = lastDisconnect?.error?.message || "Conexão fechada";
        console.log(`[WhatsApp] Connection closed. Status: ${statusCode || "unknown"}. Message: ${message}`);

        if (statusCode === DisconnectReason.loggedOut) {
          lastError = "Sessão desconectada. Gere um novo QR Code.";
          removeAuthDir();
          await closeSocket();
          return;
        }

        if (statusCode === 405) {
          await closeSocket();
          scheduleReconnect("405 detectado pelo WhatsApp");
          return;
        }

        await closeSocket();
      }
    });

    client.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || !Array.isArray(messages)) return;

      for (const msg of messages) {
        if (!msg || msg.key?.fromMe) continue;
        if (msg.key?.remoteJid === "status@broadcast") continue;

        const remoteJid = msg.key?.remoteJid || "";
        const phone = normalizePhone(remoteJid);
        const text = extractMessageText(msg.message || null);

        lastIncomingMessage = {
          from: remoteJid,
          phone,
          text,
          hasMessage: Boolean(text),
          messageKeys: msg.message ? Object.keys(msg.message) : [],
          at: new Date().toISOString(),
        };

        console.log(`[WhatsApp] Incoming event from ${remoteJid} | hasMessage=${Boolean(text)}`);

        if (!phone || !text) {
          console.log("[WhatsApp] Evento ignorado por não conter texto legível");
          continue;
        }

        await forwardIncomingMessage({
          from: remoteJid,
          phone,
          message: text,
          messages: [msg],
        });
      }
    });
  })();

  try {
    await startInFlight;
  } finally {
    startInFlight = null;
  }
}

app.get("/", (req, res) => {
  json(res, {
    service: "WhatsApp Baileys Server",
    ...buildHealthPayload(),
  });
});

app.get("/health", (req, res) => json(res, buildHealthPayload()));
app.get("/health-json", (req, res) => json(res, buildHealthPayload()));
app.get("/status", (req, res) => json(res, buildHealthPayload()));
app.get("/status-json", (req, res) => json(res, buildHealthPayload()));

app.get("/qr", (req, res) => {
  if (isConnected) return json(res, { connected: true, phone: connectedPhone });
  if (qrCodeData) return json(res, { connected: false, qr: qrCodeData });
  return json(res, { connected: false, qr: null, message: "Aguardando QR Code..." });
});

app.get("/qr-json", (req, res) => {
  if (isConnected) return json(res, { connected: true, phone: connectedPhone });
  if (qrCodeData) return json(res, { connected: false, qr: qrCodeData });
  return json(res, { connected: false, qr: null, message: "Aguardando QR Code..." });
});

app.post("/set-webhook", (req, res) => {
  const nextUrl = typeof req.body?.webhookUrl === "string" ? req.body.webhookUrl.trim() : "";
  if (!nextUrl) return json(res, { error: "webhookUrl is required" }, 400);

  webhookUrl = nextUrl;
  console.log(`[Server] Webhook configurado em runtime: ${webhookUrl}`);
  return json(res, { success: true, webhookUrl });
});

app.post("/send", async (req, res) => {
  const to = typeof req.body?.to === "string" ? req.body.to : "";
  const message = typeof req.body?.message === "string" ? req.body.message : "";

  if (!to || !message) return json(res, { error: "Missing 'to' or 'message'" }, 400);
  if (!sock || !isConnected) return json(res, { error: "WhatsApp not connected" }, 503);

  try {
    const jid = to.includes("@") ? to : `${normalizePhone(to)}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp] Mensagem enviada para ${jid}`);
    return json(res, { success: true, to: jid });
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.post("/send-whatsapp", async (req, res) => {
  const phone = typeof req.body?.phone === "string" ? req.body.phone : "";
  const message = typeof req.body?.message === "string" ? req.body.message : "";

  if (!phone || !message) return json(res, { error: "Missing 'phone' or 'message'" }, 400);
  if (!sock || !isConnected) return json(res, { error: "WhatsApp not connected" }, 503);

  try {
    const jid = `${normalizePhone(phone)}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp] Mensagem enviada para ${jid}`);
    return json(res, { success: true, to: jid });
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.get("/reset", async (req, res) => {
  try {
    await closeSocket();
    removeAuthDir();
    resetRuntimeState();
    await startSock(true);
    return json(res, { success: true, message: "Reset executado. Consulte /qr-json." });
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.get("/reset-json", async (req, res) => {
  try {
    await closeSocket();
    removeAuthDir();
    resetRuntimeState();
    await startSock(true);
    return json(res, { success: true, message: "Reset executado. Consulte /qr-json." });
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.post("/reconnect", async (req, res) => {
  try {
    await closeSocket();
    blocked405 = false;
    lastError = null;
    await startSock(true);
    return json(res, { success: true, message: "Reconectando..." });
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    if (sock && typeof sock.logout === "function") {
      await sock.logout();
    }
    await closeSocket();
    return json(res, { success: true, message: "Disconnected" });
  } catch (error) {
    return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Webhook URL: ${webhookUrl || "NOT SET"}`);
  console.log("Menu");
  console.log("- GET  /health-json");
  console.log("- GET  /qr-json");
  console.log("- GET  /reset-json");
  console.log("- POST /set-webhook");
  console.log("- POST /send-whatsapp");
});
