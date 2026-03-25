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

app.set("trust proxy", true);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.json());
app.use(express.static("."));

// ------------------------- SAFARICOM IP ALLOWLIST -------------------------
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

// ------------------------- TELEGRAM ALERT -------------------------
async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("❌ Telegram alert failed:", err);
  }
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

  const res = await fetch(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );

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
    console.log("\n📥 /subscribe payload:", req.body);

    // ✅ INCLUDED referredBy
    const { name, email, phone, referredBy, industry } = req.body;

    if (!name || !email || !phone || !industry) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const accountRef = genRef();

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;

    const token = await getMpesaToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14);

    const password = Buffer.from(
      shortcode + passkey + timestamp
    ).toString("base64");

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: 100,
      PartyA: phone,
      PartyB: "6976785",
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: accountRef,
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

    // ✅ STORE referredBy
    if (stkData?.CheckoutRequestID) {
      pending[stkData.CheckoutRequestID] = {
        name,
        email,
        phone,
        referredBy,
        industry,
        createdAt: Date.now(),
      };
    }

    return res.json({
      status: "pending",
      checkoutID: stkData?.CheckoutRequestID,
      stk: stkData,
    });

  } catch (err) {
    console.error("❌ ERROR /subscribe:", err);
    return res.status(500).json({ message: "Failed to initiate payment" });
  }
});

// ---------------------- CALLBACK ----------------------
app.post("/callback", async (req, res) => {
  try {
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress;

    if (!SAFARICOM_IPS.has(clientIp)) {
      await sendTelegramAlert(`🚨 Unauthorized callback from ${clientIp}`);
    }

    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) return res.json({ result: "no-stk-callback" });

    const checkoutId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;

    if (resultCode === 0 && checkoutId && pending[checkoutId]) {
      const entry = pending[checkoutId];

      const { name, email, industry } = entry;

      // ✅ MAILERLITE (WITH referred_by)
      try {
        const key =
          "MAILERLITE_GROUP_" +
          industry.toUpperCase().replace(/[^A-Z0-9]/g, "_");

        const groupId =
          process.env[key] || process.env.MAILERLITE_DEFAULT_GROUP;

        const apiKey = process.env.MAILERLITE_API_KEY;

        const mlPayload = {
          email,
          name: entry.name,
          fields: {
            name: entry.name,
            phone: entry.phone,
            referred_by: entry.referredBy || "", // ✅ INCLUDED
          },
          ...(groupId ? { groups: [groupId] } : {}),
        };

        await fetch("https://connect.mailerlite.com/api/subscribers", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(mlPayload),
        });

      } catch (e) {
        console.error("❌ MailerLite error:", e);
      }

      delete pending[checkoutId];
      return res.json({ ResultCode: 0, ResultDesc: "Processed" });
    }

    return res.json({ ResultCode: 0, ResultDesc: "No action taken" });

  } catch (err) {
    console.error("❌ ERROR in /callback:", err);
    return res.json({ ResultCode: 0, ResultDesc: "Error handled" });
  }
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
