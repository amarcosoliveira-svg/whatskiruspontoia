const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || "./auth_info");
const SUPABASE_WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || "";

const logger = pino({ level: "silent" });

let sock = null;
let qrCode = null;
let connectionStatus = "disconnected";
let lastError = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isConnecting = false;

const MAX_RECONNECT_ATTEMPTS = 5;

// ─── Helpers ──────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function getPhoneFromJid(jid) {
  if (!jid) return null;
  return jid.replace(/@s\.whatsapp\.net|@g\.us/g, "");
}

function clearSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("[Session] Auth directory cleared");
    }
  } catch (err) {
    console.error("[Session] Error clearing:", err.message);
  }
}

function scheduleReconnect() {
  if (reconnectTimer || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log("[WhatsApp] Max reconnect attempts reached. Use /reset to clear and try again.");
    }
    return;
  }

  reconnectAttempts += 1;
  const delay = Math.min(5000 * reconnectAttempts, 30000);

  console.log(
    `[WhatsApp] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, delay);
}

async function sendWebhookPayload(payload) {
  if (!SUPABASE_WEBHOOK_URL) {
    console.log("[Webhook] SUPABASE_WEBHOOK_URL not configured, skipping");
    return;
  }

  try {
    const response = await fetch(SUPABASE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log("[Webhook] Response:", text);
  } catch (err) {
    console.error("[Webhook] Error:", err.message);
  }
}

async function sendWebhookStatus(phone, status, messageId) {
  await sendWebhookPayload({ phone, status, messageId });
}

function extractMessageText(message) {
  if (!message) return "";

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;

  if (message.ephemeralMessage?.message) {
    return extractMessageText(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return extractMessageText(message.viewOnceMessage.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return extractMessageText(message.documentWithCaptionMessage.message);
  }

  return "";
}

// ─── WhatsApp Connection ──────────────────────────────────

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[WhatsApp] Using Baileys version: ${version.join(".")}`);

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
        connectionStatus = "waiting_qr";
        console.log("[WhatsApp] QR code generated - scan at /qr");
      }

      if (connection === "open") {
        connectionStatus = "connected";
        qrCode = null;
        reconnectAttempts = 0;
        lastError = null;

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        console.log("[WhatsApp] Connected successfully!");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.data?.statusCode ||
          lastDisconnect?.error?.statusCode ||
          null;

        lastError = lastDisconnect?.error?.message || "Unknown error";
        connectionStatus = "disconnected";
        qrCode = null;
        sock = null;

        console.log(`[WhatsApp] Disconnected. Reason: ${statusCode} - ${lastError}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("[WhatsApp] Logged out. Clearing session...");
          clearSession();
          reconnectAttempts = 0;
          scheduleReconnect();
        } else {
          scheduleReconnect();
        }
      }
    });

    // Status updates (delivered/read)
    sock.ev.on("messages.update", async (updates) => {
      for (const item of updates) {
        const { key, update } = item;
        if (!update || update.status === undefined) continue;

        const phone = getPhoneFromJid(key.remoteJid);
        const messageId = key.id;

        let status = null;
        switch (update.status) {
          case 2:
            status = "DELIVERED";
            break;
          case 3:
          case 4:
            status = "READ";
            break;
          default:
            break;
        }

        if (status && phone && messageId) {
          console.log(`[Status] Message ${messageId} to ${phone}: ${status}`);
          await sendWebhookStatus(phone, status, messageId);
        }
      }
    });

    // Receipt updates
    sock.ev.on("message-receipt.update", async (updates) => {
      for (const update of updates) {
        const phone = getPhoneFromJid(update.key?.remoteJid);
        const messageId = update.key?.id;

        if (!phone || !messageId) continue;

        if (update.receipt?.readTimestamp) {
          console.log(`[Receipt] Message ${messageId} read by ${phone}`);
          await sendWebhookStatus(phone, "READ", messageId);
        } else if (update.receipt?.receiptTimestamp) {
          console.log(`[Receipt] Message ${messageId} delivered to ${phone}`);
          await sendWebhookStatus(phone, "DELIVERED", messageId);
        }
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg?.key) continue;
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === "status@broadcast") continue;

        const from = getPhoneFromJid(msg.key.remoteJid);
        const text = extractMessageText(msg.message);
        const messageId = msg.key.id || null;

        if (!from || !text) continue;

        console.log(`[Incoming] Message from ${from}: ${text}`);

        await sendWebhookPayload({
          from,
          message: text,
          messageId,
        });
      }
    });
  } catch (err) {
    lastError = err.message;
    connectionStatus = "disconnected";
    sock = null;
    console.error("[WhatsApp] Connection error:", err.message);
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

// ─── API Routes ───────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    status: connectionStatus,
    uptime: process.uptime(),
    lastError,
    reconnectAttempts,
    webhookConfigured: !!SUPABASE_WEBHOOK_URL,
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: connectionStatus,
    uptime: process.uptime(),
    lastError,
    reconnectAttempts,
    webhookConfigured: !!SUPABASE_WEBHOOK_URL,
  });
});

app.options("/health-json", (req, res) => {
  res.set(corsHeaders());
  res.sendStatus(204);
});

app.get("/health-json", (req, res) => {
  res.set(corsHeaders());
  res.json({
    status: connectionStatus,
    lastError,
    reconnectAttempts,
    webhookConfigured: !!SUPABASE_WEBHOOK_URL,
  });
});

app.options("/qr-json", (req, res) => {
  res.set(corsHeaders());
  res.sendStatus(204);
});

app.get("/qr-json", (req, res) => {
  res.set(corsHeaders());
  res.json({
    status: connectionStatus,
    qrCode: qrCode || null,
  });
});

app.get("/qr", (req, res) => {
  if (connectionStatus === "connected") {
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>WhatsApp conectado</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 24px; text-align: center;">
          <h1>✅ WhatsApp Conectado</h1>
          <p>A sessão está ativa.</p>
          <a href="/health" target="_blank">Ver status</a>
        </body>
      </html>
    `);
  }

  if (!qrCode) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Aguardando QR Code</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 24px; text-align: center;">
          <h1>⏳ Aguardando QR Code...</h1>
          <p>O QR code será gerado em instantes.</p>
          <a href="/qr">Atualizar</a>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Escaneie o QR Code</title>
      </head>
      <body style="font-family: Arial, sans-serif; padding: 24px; text-align: center;">
        <h1>📱 Escaneie o QR Code</h1>
        <p>Abra o WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrCode}" alt="QR Code do WhatsApp" style="max-width: 320px; width: 100%;" />
      </body>
    </html>
  `);
});

app.options("/reset-json", (req, res) => {
  res.set(corsHeaders());
  res.sendStatus(204);
});

app.get("/reset", async (req, res) => {
  console.log("[Reset] Clearing session and reconnecting...");

  try {
    if (sock) {
      sock.ev.removeAllListeners();
      await sock.logout().catch(() => {});
      sock = null;
    }
  } catch (e) {
    console.log("[Reset] Socket cleanup:", e.message);
  }

  clearSession();
  connectionStatus = "disconnected";
  qrCode = null;
  reconnectAttempts = 0;
  lastError = null;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  setTimeout(() => connectToWhatsApp(), 2000);

  res.json({ success: true, message: "Session cleared. Access /qr to scan." });
});

app.get("/reset-json", async (req, res) => {
  res.set(corsHeaders());
  console.log("[Reset] Clearing session and reconnecting...");

  try {
    if (sock) {
      sock.ev.removeAllListeners();
      await sock.logout().catch(() => {});
      sock = null;
    }
  } catch (e) {
    console.log("[Reset] Socket cleanup:", e.message);
  }

  clearSession();
  connectionStatus = "disconnected";
  qrCode = null;
  reconnectAttempts = 0;
  lastError = null;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  setTimeout(() => connectToWhatsApp(), 2000);

  res.json({ success: true, message: "Session cleared. QR will regenerate." });
});

app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({
      success: false,
      error: "phone and message are required",
    });
  }

  if (connectionStatus !== "connected" || !sock) {
    return res.status(503).json({
      success: false,
      error: "WhatsApp not connected. Access /qr to scan.",
    });
  }

  try {
    const cleanPhone = String(phone).replace(/\D/g, "");
    const jidCandidates = [cleanPhone];

    if (cleanPhone.startsWith("55") && cleanPhone.length >= 12) {
      const ddd = cleanPhone.slice(2, 4);
      const number = cleanPhone.slice(4);

      if (number.length === 9 && number.startsWith("9")) {
        jidCandidates.push(`55${ddd}${number.slice(1)}`);
      } else if (number.length === 8) {
        jidCandidates.push(`55${ddd}9${number}`);
      }
    }

    let resolvedJid = null;

    for (const candidate of jidCandidates) {
      const [result] = await sock.onWhatsApp(`${candidate}@s.whatsapp.net`);
      if (result?.exists) {
        resolvedJid = result.jid;
        console.log(`[Send] Resolved JID: ${resolvedJid} (from candidate ${candidate})`);
        break;
      }
    }

    if (!resolvedJid) {
      return res.status(404).json({
        success: false,
        error: `Number ${cleanPhone} not found on WhatsApp`,
      });
    }

    const sentMsg = await sock.sendMessage(resolvedJid, { text: message });
    const recipientPhone = getPhoneFromJid(resolvedJid);

    console.log(`[Send] Message sent to ${resolvedJid}, ID: ${sentMsg.key.id}`);

    await sendWebhookStatus(recipientPhone, "SENT", sentMsg.key.id);

    res.json({
      success: true,
      messageId: sentMsg.key.id,
      to: resolvedJid,
    });
  } catch (err) {
    console.error("[Send] Error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ─── Start ────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Webhook URL: ${SUPABASE_WEBHOOK_URL || "NOT SET"}`);
  connectToWhatsApp();
});
