const express = require("express");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_info");
const SUPABASE_WEBHOOK_URL =
  process.env.SUPABASE_WEBHOOK_URL || process.env.WEBHOOK_URL || "";

const logger = pino({ level: "silent" });

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectedPhone = null;
let reconnectTimer = null;
let isStarting = false;

// ─── CORS ─────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function sendJson(res, status, payload) {
  res.set(corsHeaders).status(status).json(payload);
}

// ─── Helpers ──────────────────────────────────────────────
function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function getPhoneFromJid(jid) {
  if (!jid) return "";
  return jid.split("@")[0].replace(/\D/g, "");
}

function extractMessageText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  if (message.ephemeralMessage?.message)
    return extractMessageText(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message)
    return extractMessageText(message.viewOnceMessage.message);
  return "";
}

async function forwardIncomingMessage(payload) {
  if (!SUPABASE_WEBHOOK_URL) {
    console.log("⚠️  SUPABASE_WEBHOOK_URL não configurada, ignorando mensagem.");
    return;
  }
  try {
    const resp = await fetch(SUPABASE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    console.log(`📨 Webhook respondeu (${resp.status}): ${text}`);
  } catch (error) {
    console.error("❌ Erro ao encaminhar para webhook:", error?.message || error);
  }
}

// ─── Reconnect helpers ────────────────────────────────────
function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(delay = 3000) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    connectToWhatsApp().catch((err) => {
      console.error("❌ Falha ao reconectar:", err?.message || err);
      scheduleReconnect(5000);
    });
  }, delay);
}

async function cleanupSocket() {
  try {
    if (sock?.ws?.readyState === 1) sock.ws.close();
  } catch (_) {}
  sock = null;
  isConnected = false;
  connectedPhone = null;
}

async function resetSession() {
  clearReconnectTimer();
  try {
    if (sock) {
      try { await sock.logout(); } catch (_) {}
    }
  } finally {
    await cleanupSocket();
    qrCodeData = null;
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  }
  await connectToWhatsApp();
}

// ─── Main connection ──────────────────────────────────────
async function connectToWhatsApp() {
  if (isStarting) return;
  isStarting = true;

  try {
    clearReconnectTimer();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const newSock = makeWASocket({
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ["WhatsKirus", "Chrome", "1.0.0"],
    });

    sock = newSock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          isConnected = false;
          connectedPhone = null;
          console.log("📱 QR Code atualizado.");
        } catch (err) {
          console.error("❌ Erro ao gerar QR:", err?.message || err);
        }
      }

      if (connection === "open") {
        isConnected = true;
        qrCodeData = null;
        connectedPhone = getPhoneFromJid(sock?.user?.id);
        console.log(
          `✅ WhatsApp conectado: ${connectedPhone || "número não identificado"}`
        );
      }

      if (connection === "close") {
        isConnected = false;
        connectedPhone = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        console.log(
          `❌ Conexão fechada. Status: ${statusCode}. Reconectar: ${shouldReconnect}`
        );

        if (!shouldReconnect) {
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
          qrCodeData = null;
        }

        await cleanupSocket();
        scheduleReconnect(shouldReconnect ? 3000 : 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages || []) {
        try {
          if (!msg?.key) continue;
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid === "status@broadcast") continue;

          const from = getPhoneFromJid(msg.key.remoteJid);
          const text = extractMessageText(msg.message);
          if (!from || !text) continue;

          console.log(`📩 Mensagem de ${from}: ${text}`);

          await forwardIncomingMessage({
            from,
            message: text,
            messageId: msg.key.id || null,
          });
        } catch (error) {
          console.error(
            "❌ Erro em messages.upsert:",
            error?.message || error
          );
        }
      }
    });
  } catch (error) {
    console.error(
      "❌ Erro ao iniciar conexão WhatsApp:",
      error?.message || error
    );
    await cleanupSocket();
    scheduleReconnect(5000);
  } finally {
    isStarting = false;
  }
}

// ─── Routes ───────────────────────────────────────────────
app.options("*", (_req, res) => res.set(corsHeaders).sendStatus(204));

app.get("/", (_req, res) => res.redirect("/health"));

app.get("/health", (_req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: "whatsapp-baileys-server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: Boolean(SUPABASE_WEBHOOK_URL),
  });
});

app.get("/health-json", (_req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: "whatsapp-baileys-server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: Boolean(SUPABASE_WEBHOOK_URL),
  });
});

app.get("/qr", (_req, res) => {
  if (isConnected) {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif">
        <div style="text-align:center">
          <h2>✅ WhatsApp conectado</h2>
          <p>Número: ${connectedPhone || "não identificado"}</p>
        </div>
      </body></html>
    `);
  }
  if (!qrCodeData) {
    return res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif">
        <div style="text-align:center">
          <h2>⏳ Aguardando QR Code...</h2>
          <p>Recarregue em alguns segundos.</p>
        </div>
      </body></html>
    `);
  }
  res.send(`
    <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif">
      <div style="text-align:center">
        <h2>📱 Escaneie o QR Code</h2>
        <img src="${qrCodeData}" style="max-width:400px"/>
      </div>
    </body></html>
  `);
});

app.get("/qr-json", (_req, res) => {
  sendJson(res, 200, {
    connected: isConnected,
    phone: connectedPhone,
    qr: isConnected ? null : qrCodeData,
    webhookConfigured: Boolean(SUPABASE_WEBHOOK_URL),
  });
});

app.get("/reset", async (_req, res) => {
  try {
    await resetSession();
    res.send(`
      <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif">
        <div style="text-align:center">
          <h2>Sessão reiniciada</h2>
          <p>Acesse <a href="/qr">/qr</a> para escanear o novo QR Code.</p>
        </div>
      </body></html>
    `);
  } catch (error) {
    res.status(500).send(`<pre>Erro: ${String(error?.message || error)}</pre>`);
  }
});

app.get("/reset-json", async (_req, res) => {
  try {
    await resetSession();
    sendJson(res, 200, { success: true, message: "Sessão reiniciada." });
  } catch (error) {
    sendJson(res, 500, { success: false, error: String(error?.message || error) });
  }
});

app.post("/send-whatsapp", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const message = String(req.body?.message || "").trim();

    if (!phone || !message) {
      return sendJson(res, 400, {
        success: false,
        error: "phone e message são obrigatórios.",
      });
    }

    if (!sock || !isConnected) {
      return sendJson(res, 503, {
        success: false,
        error: "WhatsApp não está conectado.",
      });
    }

    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Mensagem enviada para ${jid}`);

    sendJson(res, 200, { success: true, to: phone, jid });
  } catch (error) {
    console.error("❌ Erro ao enviar:", error?.message || error);
    sendJson(res, 500, { success: false, error: String(error?.message || error) });
  }
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await connectToWhatsApp();
});
