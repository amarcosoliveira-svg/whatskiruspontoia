const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";
const SUPABASE_WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL;

const logger = pino({ level: "silent" });

let sock = null;
let qrCode = null;
let connectionStatus = "disconnected";
let lastError = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ─── Helpers ──────────────────────────────────────────────

function getPhoneFromJid(jid) {
  if (!jid) return null;
  return jid.replace(/@s\.whatsapp\.net|@g\.us/g, "");
}

async function sendWebhookStatus(phone, status, messageId) {
  if (!SUPABASE_WEBHOOK_URL) {
    console.log("[Webhook] URL not configured, skipping status update");
    return;
  }

  try {
    const response = await fetch(SUPABASE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, status, messageId }),
    });

    const result = await response.json();
    console.log(`[Webhook] Status ${status} for ${phone}:`, result);
  } catch (err) {
    console.error("[Webhook] Error sending status:", err.message);
  }
}

// ─── WhatsApp Connection ──────────────────────────────────

async function connectToWhatsApp() {
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

  // ── Connection events ──
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = await QRCode.toDataURL(qr);
      connectionStatus = "waiting_qr";
      console.log("[WhatsApp] QR code generated - scan at /qr");
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      lastError = lastDisconnect?.error?.message || "Unknown error";
      connectionStatus = "disconnected";
      qrCode = null;

      console.log(`[WhatsApp] Disconnected. Reason: ${reason} - ${lastError}`);

      if (reason === DisconnectReason.loggedOut) {
        console.log("[WhatsApp] Logged out. Clearing session...");
        clearSession();
        reconnectAttempts = 0;
      } else if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 30000);
        console.log(
          `[WhatsApp] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`
        );
        setTimeout(connectToWhatsApp, delay);
      } else {
        console.log("[WhatsApp] Max reconnect attempts reached. Use /reset to clear and try again.");
      }
    }

    if (connection === "open") {
      connectionStatus = "connected";
      qrCode = null;
      reconnectAttempts = 0;
      lastError = null;
      console.log("[WhatsApp] Connected successfully!");
    }
  });

  // ── Save credentials on update ──
  sock.ev.on("creds.update", saveCreds);

  // ── Message status updates (DELIVERED, READ) ──
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      const { key, update: msgUpdate } = update;

      if (!msgUpdate || msgUpdate.status === undefined) continue;

      const phone = getPhoneFromJid(key.remoteJid);
      const messageId = key.id;

      let status;
      switch (msgUpdate.status) {
        case 2:
          status = "DELIVERED";
          break;
        case 3:
          status = "READ";
          break;
        case 4:
          status = "READ";
          break;
        default:
          continue;
      }

      console.log(`[Status] Message ${messageId} to ${phone}: ${status}`);
      await sendWebhookStatus(phone, status, messageId);
    }
  });

  // ── Message receipt (delivered/read confirmations) ──
  sock.ev.on("message-receipt.update", async (updates) => {
    for (const update of updates) {
      const phone = getPhoneFromJid(update.key.remoteJid);
      const messageId = update.key.id;

      if (update.receipt?.readTimestamp) {
        console.log(`[Receipt] Message ${messageId} read by ${phone}`);
        await sendWebhookStatus(phone, "READ", messageId);
      } else if (update.receipt?.receiptTimestamp) {
        console.log(`[Receipt] Message ${messageId} delivered to ${phone}`);
        await sendWebhookStatus(phone, "DELIVERED", messageId);
      }
    }
  });
}

// ── Incoming messages ──
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const from = getPhoneFromJid(msg.key.remoteJid);
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      if (!text || !from) continue;

      console.log(`[Incoming] Message from ${from}: ${text}`);

      if (SUPABASE_WEBHOOK_URL) {
        try {
          const resp = await fetch(SUPABASE_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, message: text }),
          });
          const data = await resp.json();
          console.log(`[Webhook] Response:`, data);
        } catch (err) {
          console.error("[Webhook] Error:", err.message);
        }
      }
    }
  });

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

// ─── API Routes ───────────────────────────────────────────

// Health check (JSON)
app.get("/health", (req, res) => {
  res.json({
    status: connectionStatus,
    uptime: process.uptime(),
    lastError,
    reconnectAttempts,
    webhookConfigured: !!SUPABASE_WEBHOOK_URL,
  });
});

// QR code as JSON (for frontend embedding)
app.get("/qr-json", (req, res) => {
  res.set(corsHeaders());
  res.json({
    status: connectionStatus,
    qrCode: qrCode || null,
  });
});

// CORS preflight for /qr-json and /health-json
app.options("/qr-json", (req, res) => {
  res.set(corsHeaders());
  res.sendStatus(204);
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
  });
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

// QR code page (HTML)
app.get("/qr", (req, res) => {
  if (connectionStatus === "connected") {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#0a0a0a;color:#22c55e;">
        <div style="text-align:center">
          <h1>✅ WhatsApp Conectado</h1>
          <p>A sessão está ativa.</p>
          <a href="/health" style="color:#60a5fa">Ver status</a>
        </div>
      </body></html>
    `);
  }

  if (!qrCode) {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#0a0a0a;color:#f59e0b;">
        <div style="text-align:center">
          <h1>⏳ Aguardando QR Code...</h1>
          <p>O QR code será gerado em instantes.</p>
          <script>setTimeout(() => location.reload(), 3000)</script>
        </div>
      </body></html>
    `);
  }

  res.send(`
    <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#0a0a0a;color:white;">
      <div style="text-align:center">
        <h1>📱 Escaneie o QR Code</h1>
        <p>Abra o WhatsApp > Dispositivos Vinculados > Vincular Dispositivo</p>
        <img src="${qrCode}" style="width:300px;height:300px;margin:20px auto;border-radius:12px;" />
        <script>setTimeout(() => location.reload(), 20000)</script>
      </div>
    </body></html>
  `);
});

// Reset session
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

  setTimeout(() => connectToWhatsApp(), 2000);

  res.json({ success: true, message: "Session cleared. Access /qr to scan." });
});

// Reset with CORS
app.options("/reset-json", (req, res) => {
  res.set(corsHeaders());
  res.sendStatus(204);
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

  setTimeout(() => connectToWhatsApp(), 2000);

  res.json({ success: true, message: "Session cleared. QR will regenerate." });
});

// Send WhatsApp message
app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: "phone and message are required" });
  }

  if (connectionStatus !== "connected" || !sock) {
    return res.status(503).json({
      success: false,
      error: "WhatsApp not connected. Access /qr to scan.",
    });
  }

  try {
    const jidCandidates = [phone];

    if (phone.startsWith("55") && phone.length >= 12) {
      const ddd = phone.slice(2, 4);
      const number = phone.slice(4);

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
        error: `Number ${phone} not found on WhatsApp`,
      });
    }

    const sentMsg = await sock.sendMessage(resolvedJid, { text: message });

    console.log(`[Send] Message sent to ${resolvedJid}, ID: ${sentMsg.key.id}`);

    const recipientPhone = getPhoneFromJid(resolvedJid);
    await sendWebhookStatus(recipientPhone, "SENT", sentMsg.key.id);

    res.json({
      success: true,
      messageId: sentMsg.key.id,
      to: resolvedJid,
    });
  } catch (err) {
    console.error("[Send] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Webhook URL: ${SUPABASE_WEBHOOK_URL || "NOT SET"}`);
  connectToWhatsApp();
});
