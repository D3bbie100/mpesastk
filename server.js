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

// ---------------------- TELEGRAM ALERTS ----------------------
const SAFE_IPS = new Set([
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

async function sendTelegramAlert(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: message,
        }),
      }
    );
  } catch (e) {
    console.error("❌ Telegram alert failed:", e);
  }
}

// ------------------------- LOG HELPERS -------------------------
function checkForUnsafeCharacters(payload) {
  Object.entries(payload).forEach(([key, value]) => {
    if (typeof value === "string" && /[^a-zA-Z0-9\-_\s()./]/.test(value)) {
      console.warn(`⚠️ POSSIBLE UNSAFE CHARACTERS detected in ${key}:`, value);
    }
  });
}

async function logFetchError(err) {
  if (err.name === "FetchError") {
    console.error("FETCH ERROR:", err);
    return;
  }
  console.error("Error:", err);
}

// ------------------------- PENDING STORE -------------------------
const pending = {};

function genRef() {
  return "REF-" + crypto.randomBytes(6).toString("hex");
}

// ---------------------- DARAJA TOKEN ----------------------
async function getMpesaToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error("Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET");
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const url =
    process.env.MPESA_OAUTH_URL ||
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Failed to get token: " + txt);
  }

  const data = await res.json();
  return data.access_token;
}

// ---------------------- SERVE HTML ----------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------- STK PUSH ----------------------
app.post("/subscribe", async (req, res) => {
  try {
    const { name, email, phone, industry } = req.body;
    if (!name || !email || !phone || !industry) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const accountRef = genRef();
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
      AccountReference: accountRef,
      TransactionDesc: `Subscription (${industry})`,
    };

    const url =
      process.env.MPESA_STK_URL ||
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

    const stkRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await stkRes.text();
    const stkData = JSON.parse(rawText);

    if (stkData?.CheckoutRequestID) {
      pending[stkData.CheckoutRequestID] = {
        name,
        email,
        phone,
        industry,
        createdAt: Date.now(),
      };
    }

    res.json({ status: "pending", checkoutID: stkData?.CheckoutRequestID });
  } catch (err) {
    await logFetchError(err);
    res.status(500).json({ message: "Failed to initiate payment" });
  }
});

// ---------------------- CALLBACK ----------------------
app.post("/callback", async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress?.replace("::ffff:", "");

    if (ip && !SAFE_IPS.has(ip)) {
      await sendTelegramAlert(
        `🚨 UNSAFE CALLBACK IP DETECTED\nIP: ${ip}\nTime: ${new Date().toISOString()}`
      );
    }

    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) return res.json({ result: "no-stk-callback" });

    const checkoutId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;

    if (resultCode === 0 && checkoutId && pending[checkoutId]) {
      delete pending[checkoutId];
    }

    res.json({ ResultCode: 0, ResultDesc: "Processed" });
  } catch (err) {
    res.json({ ResultCode: 0, ResultDesc: "Error handled" });
  }
});

// ---------------------- DEBUG ----------------------
app.get("/_pending", (req, res) => {
  res.json(pending);
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
