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

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectedPhone = null;
let webhookUrl = process.env.WEBHOOK_URL || null;
let isStarting = false;

const logger = pino({ level: "silent" });

function clearAuthDir() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
}

async function forwardToWebhook(from, text) {
  if (!webhookUrl) {
    console.log("⚠️ WEBHOOK_URL não configurado. Mensagem ignorada de:", from);
    return;
  }
  try {
    console.log(`📤 Enviando para webhook: ${webhookUrl}`);
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, message: text }),
    });
    const body = await resp.text();
    console.log(`📤 Webhook respondeu (${resp.status}):`, body);
  } catch (err) {
    console.error("❌ Erro ao enviar para webhook:", err?.message || err);
  }
}

async function startSock() {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ["Kirus BI", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("📱 QR Code gerado");
        qrCodeData = await QRCode.toDataURL(qr);
        isConnected = false;
        connectedPhone = null;
      }

      if (connection === "open") {
        console.log("✅ WhatsApp conectado!");
        isConnected = true;
        qrCodeData = null;
        connectedPhone = sock.user?.id?.split(":")[0] || null;
        console.log("📞 Telefone conectado:", connectedPhone);
        console.log("🔗 Webhook atual:", webhookUrl || "NÃO CONFIGURADO");
        return;
      }

      if (connection === "close") {
        isConnected = false;
        connectedPhone = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`❌ Conexão fechada. Status: ${statusCode}. Reconectando: ${shouldReconnect}`);
        if (!shouldReconnect) {
          clearAuthDir();
        }
        setTimeout(() => {
          startSock().catch((err) =>
            console.error("❌ Erro ao reiniciar socket:", err?.message || err)
          );
        }, 3000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg?.key) continue;
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid === "status@broadcast") continue;

          const remoteJid = msg.key.remoteJid || "";
          if (!remoteJid.endsWith("@s.whatsapp.net")) continue;

          const from = remoteJid.replace("@s.whatsapp.net", "");
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            "";

          if (!from || !text) continue;

          console.log(`📩 Mensagem recebida de ${from}: ${text}`);
          await forwardToWebhook(from, text);
        } catch (err) {
          console.error("❌ Erro ao processar mensagem:", err?.message || err);
        }
      }
    });
  } catch (err) {
    console.error("❌ Erro ao iniciar socket:", err?.message || err);
    setTimeout(() => {
      startSock().catch((error) =>
        console.error("❌ Falha ao reiniciar:", error?.message || error)
      );
    }, 5000);
  } finally {
    isStarting = false;
  }
}

// ==================== ROTAS ====================

app.get("/", (req, res) => {
  res.json({
    service: "WhatsApp Baileys Server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: !!webhookUrl,
    webhookUrl: webhookUrl,
  });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, phone: connectedPhone });
  }
  if (qrCodeData) {
    return res.json({ connected: false, qr: qrCodeData });
  }
  return res.json({ connected: false, qr: null, message: "Aguardando QR Code..." });
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "connected" : "disconnected",
    phone: connectedPhone,
    webhookUrl: webhookUrl,
  });
});

app.post("/set-webhook", (req, res) => {
  const { webhookUrl: url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: "webhookUrl is required" });
  }
  webhookUrl = url;
  console.log(`🔗 Webhook configurado: ${webhookUrl}`);
  return res.json({ success: true, webhookUrl });
});

app.post("/send", async (req, res) => {
  const { to, message } = req.body || {};
  if (!to || !message) {
    return res.status(400).json({ error: "Missing 'to' or 'message'" });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }
  try {
    const jid = to.includes("@") ? to : `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Mensagem enviada para ${jid}`);
    return res.json({ success: true, to: jid });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    return res.status(500).json({ error: err?.message || "Failed to send" });
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    if (sock) await sock.logout();
  } catch (err) {
    console.error("⚠️ Erro ao desconectar:", err?.message || err);
  }
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
  return res.json({ success: true, message: "Disconnected" });
});

app.post("/reconnect", async (req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
    }
    clearAuthDir();
    sock = null;
    isConnected = false;
    connectedPhone = null;
    qrCodeData = null;
    startSock().catch((err) =>
      console.error("❌ Erro ao reiniciar sessão:", err?.message || err)
    );
    return res.json({ success: true, message: "Reconnecting... Check /qr for QR code" });
  } catch (err) {
    console.error("❌ Erro no reconnect:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Reconnect failed" });
  }
});

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 WEBHOOK_URL: ${webhookUrl || "NÃO CONFIGURADO"}`);
  startSock().catch((err) =>
    console.error("❌ Falha inicial:", err?.message || err)
  );
});
