const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrCodeData = null;
let qrRawString = null;
let isConnected = false;
let connectedPhone = null;
let blocked405 = false;
let retryCount = 0;
let lastError = null;
let lastIncomingMessage = null;
let lastWebhookResult = null;
let lastConnectionUpdate = null;
let connectingInProgress = false;

const MAX_RETRIES = 3;

let webhookUrl =
  process.env.WEBHOOK_URL ||
  process.env.SUPABASE_WEBHOOK_URL ||
  null;

if (webhookUrl) {
  console.log(`[Server] Webhook configurado em runtime: ${webhookUrl}`);
}

const logger = pino({ level: "silent" });

function extractMessageText(message) {
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  const ephemeral = message.ephemeralMessage?.message;
  if (ephemeral) return extractMessageText(ephemeral);
  const viewOnce = message.viewOnceMessage?.message;
  if (viewOnce) return extractMessageText(viewOnce);
  const viewOnceV2 = message.viewOnceMessageV2?.message;
  if (viewOnceV2) return extractMessageText(viewOnceV2);
  if (message.templateButtonReplyMessage?.selectedDisplayText)
    return message.templateButtonReplyMessage.selectedDisplayText;
  if (message.buttonsResponseMessage?.selectedDisplayText)
    return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listResponseMessage?.title)
    return message.listResponseMessage.title;
  return null;
}

async function startSock() {
  if (connectingInProgress) {
    console.log("[WhatsApp] Connection already in progress, skipping...");
    return;
  }
  connectingInProgress = true;

  try {
    // Delete stale auth on fresh start to avoid 515/405 loops
    if (blocked405 || retryCount >= MAX_RETRIES) {
      console.log("[WhatsApp] Clearing auth_info due to previous block...");
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      blocked405 = false;
      retryCount = 0;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // ===== FIX FOR 405: fetch latest WA Web version =====
    let waVersion;
    try {
      const versionResult = await fetchLatestBaileysVersion();
      waVersion = versionResult.version;
      console.log(`[WhatsApp] Fetched WA version: ${JSON.stringify(waVersion)}`);
    } catch (vErr) {
      // Fallback to a known working version if fetch fails
      waVersion = [2, 3000, 1015901307];
      console.log(`[WhatsApp] Version fetch failed, using fallback: ${JSON.stringify(waVersion)}`);
    }

    console.log("[WhatsApp] Iniciando conexão...");
    console.log(`[Server] Webhook URL: ${webhookUrl}`);

    sock = makeWASocket({
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      // ===== FIX FOR 405: set browser identity and version =====
      browser: Browsers.ubuntu("Chrome"),
      version: waVersion,
      retryRequestDelayMs: 250,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 25000,
    });

    console.log(`[WhatsApp] Using WA version: ${JSON.stringify(waVersion)}`);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      lastConnectionUpdate = {
        connection,
        qr: qr ? "(present)" : null,
        statusCode: lastDisconnect?.error?.output?.statusCode,
        timestamp: new Date().toISOString(),
      };

      if (qr) {
        console.log("[WhatsApp] QR code generated - scan at /qr-json");
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          qrRawString = qr;
        } catch (e) {
          console.error("[WhatsApp] QR encode error:", e.message);
          qrRawString = qr;
        }
        isConnected = false;
      }

      if (connection === "close") {
        isConnected = false;
        connectingInProgress = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || "";
        lastError = `Status: ${statusCode}. ${errorMessage}`;

        console.log(
          `[WhatsApp] Connection closed. Status: ${statusCode}. Message: ${errorMessage}`
        );

        // 515 = Stream Errored — do NOT auto-reconnect
        if (statusCode === 515) {
          console.log("[WhatsApp] Status 515 detected - NOT auto-reconnecting.");
          qrCodeData = null;
          qrRawString = null;
          return;
        }

        // 405 = rate limited / version mismatch
        if (statusCode === 405) {
          retryCount++;
          console.log(`[WhatsApp] 405 error. Retry count: ${retryCount}/${MAX_RETRIES}`);
          
          if (retryCount >= MAX_RETRIES) {
            blocked405 = true;
            console.log("[WhatsApp] Blocked after too many 405 errors. Clearing auth and waiting for cooldown.");
            // Clear auth to start fresh next time
            if (fs.existsSync(AUTH_DIR)) {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
            qrCodeData = null;
            qrRawString = null;
            return;
          }
          
          // On 405, clear auth and retry with delay
          console.log("[WhatsApp] Clearing auth_info after 405 before retry...");
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          const delay = Math.min(5000 * Math.pow(2, retryCount), 60000);
          console.log(`[WhatsApp] Reconnecting in ${delay}ms...`);
          setTimeout(startSock, delay);
        } else {
          console.log("[WhatsApp] Logged out. Clearing auth...");
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
          qrCodeData = null;
          qrRawString = null;
          setTimeout(startSock, 3000);
        }
      }

      if (connection === "open") {
        console.log("[WhatsApp] Connected!");
        isConnected = true;
        blocked405 = false;
        retryCount = 0;
        lastError = null;
        qrCodeData = null;
        qrRawString = null;
        connectingInProgress = false;
        connectedPhone = sock.user?.id?.split(":")[0] || null;
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;

        const from = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
        const text = extractMessageText(msg.message);

        if (!text || !from) continue;

        console.log(`[WhatsApp] Message from ${from}: ${text.substring(0, 100)}`);
        lastIncomingMessage = { from, text: text.substring(0, 200), at: new Date().toISOString() };

        if (webhookUrl) {
          try {
            const resp = await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                from,
                message: text,
                rawMessage: msg.message,
                key: msg.key,
              }),
            });
            const data = await resp.text();
            lastWebhookResult = { status: resp.status, body: data.substring(0, 500), at: new Date().toISOString() };
            console.log(`[WhatsApp] Webhook response: ${resp.status}`);
          } catch (err) {
            lastWebhookResult = { error: err.message, at: new Date().toISOString() };
            console.error("[WhatsApp] Webhook error:", err.message);
          }
        }
      }
    });
  } catch (err) {
    console.error("[WhatsApp] startSock error:", err.message);
    lastError = err.message;
    connectingInProgress = false;
  }
}

// ==================== ROUTES ====================

app.get("/health", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "connected" : blocked405 ? "blocked" : "disconnected",
    phone: connectedPhone,
    webhookConfigured: !!webhookUrl,
    webhookUrl: webhookUrl,
    blocked405,
    retryCount,
    lastError,
    lastIncomingMessage,
    lastWebhookResult,
    qrAvailable: !!qrCodeData,
    lastConnectionUpdate,
  });
});

app.get("/health-json", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "connected" : blocked405 ? "blocked" : "disconnected",
    phone: connectedPhone,
    webhookConfigured: !!webhookUrl,
    webhookUrl: webhookUrl,
    blocked405,
    retryCount,
    lastError,
    lastIncomingMessage,
    lastWebhookResult,
    qrAvailable: !!qrCodeData,
    lastConnectionUpdate,
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "WhatsApp Baileys Server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: !!webhookUrl,
  });
});

app.get("/qr-json", (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, phone: connectedPhone, qr: null });
  }
  if (qrCodeData) {
    return res.json({ connected: false, qr: qrCodeData });
  }
  res.json({ connected: false, qr: null, message: "Aguardando QR Code..." });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send("<h1>WhatsApp Connected!</h1><p>Phone: " + connectedPhone + "</p>");
  }
  if (qrCodeData) {
    return res.send(
      '<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111">' +
        '<img src="' + qrCodeData + '" style="width:400px;height:400px" />' +
        "</body></html>"
    );
  }
  res.send("<h1>Aguardando QR Code...</h1><p>Acesse /reset-json para iniciar</p>");
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "connected" : "disconnected",
    phone: connectedPhone,
    webhookUrl,
    blocked405,
    retryCount,
    lastError,
  });
});

app.post("/set-webhook", (req, res) => {
  const { webhookUrl: url } = req.body;
  if (!url) return res.status(400).json({ error: "webhookUrl is required" });
  webhookUrl = url;
  console.log(`[Server] Webhook configurado: ${webhookUrl}`);
  res.json({ success: true, webhookUrl });
});

// ==================== CLEAR AUTH ====================
app.get("/clear-auth", (req, res) => {
  console.log("[WhatsApp] /clear-auth called — clearing auth_info...");
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
  }
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
  qrRawString = null;
  blocked405 = false;
  retryCount = 0;
  lastError = null;
  connectingInProgress = false;

  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("[WhatsApp] auth_info deleted successfully");
    } catch (err) {
      console.error("[WhatsApp] Failed to delete auth_info:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  } else {
    console.log("[WhatsApp] auth_info does not exist, nothing to clear");
  }
  res.json({ success: true, message: "Auth cleared. Call /reset-json to start a fresh session." });
});

app.post("/clear-auth", (req, res) => {
  req.method = "GET";
  app.handle(req, res);
});

// ==================== RESET / RECONNECT ====================
app.get("/reset-json", async (req, res) => {
  console.log("[WhatsApp] /reset-json called");
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
  }
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
  qrRawString = null;
  blocked405 = false;
  retryCount = 0;
  lastError = null;
  connectingInProgress = false;

  // Delete auth for fresh QR
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }

  startSock();
  res.json({ success: true, message: "Session reset. Poll /qr-json for QR code." });
});

app.get("/reset", (req, res) => {
  req.url = "/reset-json";
  app.handle(req, res);
});

app.get("/reconnect", async (req, res) => {
  console.log("[WhatsApp] /reconnect called");
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
  }
  isConnected = false;
  connectingInProgress = false;
  blocked405 = false;
  retryCount = 0;
  startSock();
  res.json({ success: true, message: "Reconnecting..." });
});

app.post("/disconnect", async (req, res) => {
  if (sock) {
    try { await sock.logout(); } catch (e) {}
    sock = null;
  }
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
  qrRawString = null;
  res.json({ success: true, message: "Disconnected" });
});

app.post("/send-whatsapp", async (req, res) => {
  const { phone, message, to, text } = req.body;
  const targetPhone = phone || to;
  const targetMessage = message || text;

  if (!targetPhone || !targetMessage) {
    return res.status(400).json({ error: "Missing 'phone'/'to' or 'message'/'text'" });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const normalized = targetPhone.replace(/\D/g, "");
    const jid = normalized.includes("@") ? normalized : `${normalized}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: targetMessage });
    console.log(`[WhatsApp] Message sent to ${jid}`);
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("[WhatsApp] Send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", (req, res) => {
  req.url = "/send-whatsapp";
  app.handle(req, res);
});

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log("[Server] Waiting for /reset-json to start WhatsApp connection...");
});
