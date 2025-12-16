import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.json());
app.use(express.static("."));

/* ============================================================
   SAFARICOM CALLBACK IP WHITELIST
============================================================ */
const SAFARICOM_IPS = new Set([
  "196.201.214.200",
  "196.201.214.206",
  "196.201.213.114",
  "196.201.214.207",
  "196.201.214.208",
  "196.201.213.44",
  "196.201.212.127",
  "196.201.212.138",
  "196.201.212.129",
  "196.201.212.136",
  "196.201.212.74",
  "196.201.212.69",
]);

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress;
}

/* ============================================================
   TELEGRAM ALERT HELPER
============================================================ */
async function sendTelegramAlert(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    });
  } catch (e) {
    console.error("❌ Telegram alert failed:", e.message);
  }
}

/* ============================================================
   LOG HELPERS
============================================================ */
async function logFetchError(err) {
  console.error("Error:", err);
}

/* ============================================================
   PENDING STORE
============================================================ */
const pending = {};

function genRef() {
  return "REF-" + crypto.randomBytes(6).toString("hex");
}

/* ============================================================
   MPESA TOKEN
============================================================ */
async function getMpesaToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await fetch(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );

  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).access_token;
}

/* ============================================================
   SERVE HTML
============================================================ */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ============================================================
   STK PUSH
============================================================ */
app.post("/subscribe", async (req, res) => {
  try {
    const { name, email, phone, industry } = req.body;
    if (!name || !email || !phone || !industry)
      return res.status(400).json({ message: "Missing fields" });

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const password = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString("base64");

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: 10,
      PartyA: phone,
      PartyB: "6976785",
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: genRef(),
      TransactionDesc: `Subscription (${industry})`,
    };

    const stkRes = await fetch(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const stkData = await stkRes.json();

    if (stkData?.CheckoutRequestID) {
      pending[stkData.CheckoutRequestID] = {
        name,
        email,
        phone,
        industry,
        createdAt: Date.now(),
      };
    }

    res.json({ status: "pending", stk: stkData });
  } catch (err) {
    await logFetchError(err);
    res.status(500).json({ message: "STK failed" });
  }
});

/* ============================================================
   CALLBACK (WITH IP MONITORING)
============================================================ */
app.post("/callback", async (req, res) => {
  const ip = getClientIp(req);
  const isSafaricom = SAFARICOM_IPS.has(ip);

  if (!isSafaricom) {
    console.warn("⚠️ CALLBACK FROM NON-WHITELISTED IP:", ip);
    await sendTelegramAlert(
      `⚠️ MPESA callback from NON-whitelisted IP\nIP: ${ip}`
    );
  }

  try {
    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) return res.json({ ResultCode: 0 });

    const checkoutId = stkCallback.CheckoutRequestID;

    if (!pending[checkoutId]) {
      await sendTelegramAlert(
        `⚠️ Callback with NO matching pending entry\nCheckoutRequestID: ${checkoutId}\nIP: ${ip}`
      );
      return res.json({ ResultCode: 0 });
    }

    delete pending[checkoutId];
    return res.json({ ResultCode: 0, ResultDesc: "Processed" });
  } catch (err) {
    await sendTelegramAlert(`❌ CALLBACK ERROR\n${err.message}`);
    return res.json({ ResultCode: 0 });
  }
});

/* ============================================================
   DEBUG
============================================================ */
app.get("/_pending", (req, res) => {
  res.json(pending);
});

/* ============================================================
   START
============================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
