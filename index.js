const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

let sock = null;
let qrCode = null;
let isConnected = false;
let retryCount = 0;
const MAX_RETRIES = 5;
const AUTH_DIR = path.join(__dirname, "auth_info");

function clearAuthInfo() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("Auth info cleared");
    }
  } catch (err) {
    console.error("Error clearing auth info:", err.message);
  }
}

async function connectWhatsApp() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log("Using WA version:", version.join("."));

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        isConnected = false;
        console.log("New QR code generated. Access /qr to scan.");
      }

      if (connection === "open") {
        isConnected = true;
        qrCode = null;
        retryCount = 0;
        console.log("✅ WhatsApp connected successfully!");
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || "Unknown";
        console.log(`❌ Disconnected. Code: ${statusCode}, Message: ${errorMessage}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Session logged out. Clearing credentials...");
          clearAuthInfo();
        }

        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = Math.min(retryCount * 5000, 30000);
          console.log(`Retry ${retryCount}/${MAX_RETRIES} in ${delay / 1000}s`);
          setTimeout(connectWhatsApp, delay);
        } else {
          console.log("Max retries reached. Access /reset to restart.");
        }
      }
    });
  } catch (err) {
    console.error("Connection error:", err.message);
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      setTimeout(connectWhatsApp, 10000);
    }
  }
}

// --- ROUTES ---

app.get("/qr", async (req, res) => {
  if (isConnected) {
    return res.send(
      "<html><body style='display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;'>" +
      "<h1>✅ WhatsApp já está conectado!</h1></body></html>"
    );
  }
  if (!qrCode) {
    return res.send(
      "<html><head><meta http-equiv='refresh' content='5'></head>" +
      "<body style='display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;'>" +
      "<h1>⏳ Aguardando QR Code... (atualiza em 5s)</h1></body></html>"
    );
  }
  try {
    const qrImage = await QRCode.toDataURL(qrCode);
    res.send(
      "<html><head><meta http-equiv='refresh' content='30'></head>" +
      "<body style='display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;'>" +
      "<h2>Escaneie o QR Code com WhatsApp</h2>" +
      `<img src='${qrImage}' style='width:300px;height:300px;'/>` +
      "<p style='color:gray;'>Atualiza automaticamente em 30s</p></body></html>"
    );
  } catch (err) {
    res.status(500).send("Erro ao gerar QR Code");
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    connected: isConnected,
    hasQR: !!qrCode,
    retryCount,
  });
});

app.get("/reset", async (req, res) => {
  console.log("Manual reset requested");
  clearAuthInfo();
  qrCode = null;
  isConnected = false;
  retryCount = 0;
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
  }
  setTimeout(connectWhatsApp, 2000);
  res.json({ status: "reset", message: "Session cleared. Access /qr in a few seconds." });
});

app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message are required" });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp not connected. Access /qr to scan." });
  }

  try {
    const formattedPhone = phone.replace(/\D/g, "");
    console.log(`Looking up number: ${formattedPhone}`);

    // Use onWhatsApp to resolve the correct JID
    const [result] = await sock.onWhatsApp(formattedPhone);

    if (!result || !result.exists) {
      // Try alternate format: with/without the 9th digit
      const areaCode = formattedPhone.slice(2, 4);
      const rest = formattedPhone.slice(4);
      let altPhone;

      if (rest.length === 9 && rest.startsWith("9")) {
        // Remove 9th digit
        altPhone = formattedPhone.slice(0, 4) + rest.slice(1);
      } else if (rest.length === 8) {
        // Add 9th digit
        altPhone = formattedPhone.slice(0, 4) + "9" + rest;
      }

      if (altPhone) {
        console.log(`Number not found, trying alternate: ${altPhone}`);
        const [altResult] = await sock.onWhatsApp(altPhone);

        if (altResult && altResult.exists) {
          await sock.sendMessage(altResult.jid, { text: message });
          console.log(`✅ Message sent to ${altResult.jid} (alternate format)`);
          return res.json({ success: true, jid: altResult.jid, format: "alternate" });
        }
      }

      console.log(`❌ Number ${formattedPhone} not found on WhatsApp`);
      return res.status(404).json({
        error: "Number not registered on WhatsApp",
        phone: formattedPhone,
      });
    }

    await sock.sendMessage(result.jid, { text: message });
    console.log(`✅ Message sent to ${result.jid}`);
    res.json({ success: true, jid: result.jid, format: "original" });
  } catch (err) {
    console.error("Error sending message:", err.message);
    res.status(500).json({ error: "Failed to send message", details: err.message });
  }
});

// --- START ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  connectWhatsApp();
});
