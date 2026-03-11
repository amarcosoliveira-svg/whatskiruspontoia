const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

let sock = null;
let isConnected = false;
let qrCode = null;
let retryCount = 0;
const MAX_RETRIES = 5;
const AUTH_FOLDER = path.join(__dirname, "auth_info");
const logger = pino({ level: "silent" });

function clearAuthFolder() {
  if (fs.existsSync(AUTH_FOLDER)) {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    console.log("🗑️ Sessão antiga removida.");
  }
}

async function connectWhatsApp(forceNew = false) {
  if (forceNew) clearAuthFolder();

  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 Usando WA versão: ${version.join(".")}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: ["Ubuntu", "Chrome", "22.0.0"],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrCode = qr;
        retryCount = 0;
        console.log("📲 QR Code gerado! Acesse GET /qr");
      }

      if (connection === "open") {
        isConnected = true;
        qrCode = null;
        retryCount = 0;
        console.log("✅ WhatsApp conectado!");
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ Desconectado. Código: ${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          console.log("🔒 Sessão encerrada. Use POST /reset para reconectar.");
          clearAuthFolder();
          return;
        }

        retryCount++;
        if (retryCount <= MAX_RETRIES) {
          const delay = Math.min(retryCount * 5000, 30000);
          console.log(`🔄 Tentativa ${retryCount}/${MAX_RETRIES} em ${delay / 1000}s...`);
          setTimeout(() => connectWhatsApp(statusCode === 405), delay);
        } else {
          console.log("⛔ Máximo de tentativas. Use POST /reset.");
        }
      }
    });
  } catch (err) {
    console.error("💥 Erro ao iniciar:", err.message);
    retryCount++;
    if (retryCount <= MAX_RETRIES) {
      setTimeout(() => connectWhatsApp(true), 10000);
    }
  }
}

app.get("/health", (req, res) => res.json({ status: "ok", connected: isConnected }));

app.get("/qr", (req, res) => {
  if (isConnected) return res.json({ status: "connected" });
  if (!qrCode) return res.json({ status: "waiting", message: "Aguardando QR..." });
  res.json({ status: "pending", qr: qrCode });
});

app.post("/reset", (req, res) => {
  clearAuthFolder();
  isConnected = false;
  qrCode = null;
  retryCount = 0;
  connectWhatsApp(true);
  res.json({ success: true, message: "Resetado. Aguarde QR." });
});

app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone e message obrigatórios" });
  if (!isConnected || !sock) return res.status(503).json({ error: "WhatsApp desconectado" });
  try {
    await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Porta ${PORT}`);
  connectWhatsApp(true);
});
