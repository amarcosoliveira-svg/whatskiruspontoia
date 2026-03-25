const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

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
  console.log("[Server] Webhook configurado em runtime: " + webhookUrl);
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
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    console.log("[WhatsApp] Iniciando conexao...");
    console.log("[Server] Webhook URL: " + webhookUrl);

    sock = makeWASocket({
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      retryRequestDelayMs: 250,
    });

    const version = sock.version || "unknown";
    console.log("[WhatsApp] Using Baileys version: " + version);

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
        lastError = "Status: " + statusCode + ". " + errorMessage;

        console.log("[WhatsApp] Connection closed. Status: " + statusCode + ". Message: " + errorMessage);

        if (statusCode === 515) {
          console.log("[WhatsApp] Status 515 detected - NOT auto-reconnecting. Call /clear-auth then /reset-json.");
          qrCodeData = null;
          qrRawString = null;
          return;
        }

        if (statusCode === 405) {
          retryCount++;
          if (retryCount >= MAX_RETRIES) {
            blocked405 = true;
            console.log("[WhatsApp] Blocked after too many 405 errors. Waiting for cooldown.");
            return;
          }
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          const delay = Math.min(3000 * Math.pow(2, retryCount), 30000);
          console.log("[WhatsApp] Reconnecting in " + delay + "ms...");
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

        console.log("[WhatsApp] Message from " + from + ": " + text.substring(0, 100));
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
            console.log("[WhatsApp] Webhook response: " + resp.status);
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

function buildHealthResponse() {
  return {
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
  };
}

app.get("/health", (req, res) => res.json(buildHealthResponse()));
app.get("/health-json", (req, res) => res.json(buildHealthResponse()));

app.get("/", (req, res) => {
  res.json({
    service: "WhatsApp Baileys Server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: !!webhookUrl,
  });
});

app.get("/qr-json", (req, res) => {
  if (isConnected) return res.json({ connected: true, phone: connectedPhone, qr: null });
  if (qrCodeData) return res.json({ connected: false, qr: qrCodeData });
  res.json({ connected: false, qr: null, message: "Aguardando QR Code..." });
});

app.get("/qr", (req, res) => {
  if (isConnected) return res.send("<h1>WhatsApp Connected!</h1><p>Phone: " + connectedPhone + "</p>");
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
  console.log("[Server] Webhook configurado: " + webhookUrl);
  res.json({ success: true, webhookUrl });
});

// ==================== CLEAR AUTH (fixes 515) ====================
app.get("/clear-auth", (req, res) => {
  console.log("[WhatsApp] /clear-auth called");

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
    console.log("[WhatsApp] auth_info does not exist");
  }

  res.json({ success: true, message: "Auth cleared. Call /reset-json to start fresh." });
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
    const jid = normalized.includes("@") ? normalized : normalized + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: targetMessage });
    console.log("[WhatsApp] Message sent to " + jid);
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
  console.log("[Server] Running on port " + PORT);
  console.log("[Server] Waiting for /reset-json to start WhatsApp connection...");
});
