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

// ----------------------------------------------------------------

// Store by CheckoutRequestID (this is the FIX)
const pending = {}; // { checkoutId: { name, email, phone, industry } }

// ---------------------- DARAJA TOKEN ----------------------

async function getMpesaToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;

  console.log("🔍 Getting MPESA token…");
  if (!consumerKey || !consumerSecret) {
    console.error("❌ Missing MPESA_CONSUMER_* values");
    throw new Error("Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in env");
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const url =
    process.env.MPESA_OAUTH_URL ||
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  console.log("🔍 OAuth Request →", url);

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  }).catch((err) => {
    console.error("❌ TOKEN FETCH FAILED:", err);
    throw err;
  });

  console.log("🔍 OAuth Response Status:", res.status);

  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ OAuth Error Body:", txt);
    throw new Error("Failed to get token: " + txt);
  }

  const data = await res.json();
  console.log("✅ Token acquired");
  return data.access_token;
}

// ---------------------- SERVE HTML ----------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------- STK PUSH ----------------------

app.post("/subscribe", async (req, res) => {
  try {
    console.log("\n\n============================");
    console.log("📥 /subscribe payload:", req.body);
    console.log("============================\n");

    const { name, email, phone, industry } = req.body;
    if (!name || !email || !phone || !industry) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Use a readable description, not a reference for matching
    const description = `Subscription (${industry})`;

    // Daraja config
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;

    if (!shortcode || !passkey) {
      console.error("❌ Missing SHORTCODE/PASSKEY");
      return res.status(500).json({ message: "MPESA_SHORTCODE or MPESA_PASSKEY not set" });
    }

    // Get token
    const token = await getMpesaToken();

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: 10,
      PartyA: phone,
      PartyB: '6976785',
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: "PAYMENT",
      TransactionDesc: description,
    };

    console.log("\n📤 STK Payload (password hidden):");
    console.log(JSON.stringify({ ...payload, Password: "[HIDDEN]" }, null, 2));

    checkForUnsafeCharacters(payload);

    const url =
      process.env.MPESA_STK_URL ||
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

    console.log("🔍 Sending STK push →", url);

    const stkRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("🔍 STK Response Status:", stkRes.status);

    const rawText = await stkRes.text();
    console.log("📥 Raw STK response:", rawText);

    let stkData = null;
    try {
      stkData = JSON.parse(rawText);
    } catch {
      console.warn("⚠️ STK parse failed");
    }

    // FIX: Use CheckoutRequestID as the reference
    const checkoutId = stkData?.CheckoutRequestID;
    if (checkoutId) {
      pending[checkoutId] = { name, email, phone, industry };
    }

    return res.json({
      status: "pending",
      message: "M-PESA prompt sent to your phone.",
      checkoutId,
      stk: stkData,
    });

  } catch (err) {
    console.error("❌ ERROR /subscribe:", err);
    await logFetchError(err);

    return res.status(500).json({
      message: "Failed to initiate payment",
      error: err.message,
    });
  }
});

// ---------------------- CALLBACK ----------------------

app.post("/callback", async (req, res) => {
  try {
    console.log("\n\n========== CALLBACK RECEIVED ==========");
    console.log(JSON.stringify(req.body, null, 2).slice(0, 5000));
    console.log("=======================================\n\n");

    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) return res.status(200).json({ result: "no-stk" });

    const resultCode = stkCallback.ResultCode;
    const checkoutId = stkCallback.CheckoutRequestID; // FIXED: guaranteed match

    console.log("🔍 Parsed callback:", {
      resultCode,
      checkoutId
    });

    if (resultCode === 0 && pending[checkoutId]) {
      const { name, email, industry, phone } = pending[checkoutId];

      const key = `MAILERLITE_GROUP_${industry.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      const groupId = process.env[key] || process.env.MAILERLITE_DEFAULT_GROUP;

      const mlPayload = {
        email,
        name,
        fields: { phone },
        groups: groupId ? [groupId] : []
      };

      console.log("📤 Sending to MailerLite:", mlPayload);

      try {
        const mlRes = await fetch("https://connect.mailerlite.com/api/subscribers", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
          },
          body: JSON.stringify(mlPayload),
        });
        console.log("📩 MailerLite status:", mlRes.status);
        console.log("📩 MailerLite body:", await mlRes.text());
      } catch (e) {
        console.error("❌ MailerLite error:", e);
      }

      delete pending[checkoutId];
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Processed" });
    }

    console.warn("⚠️ Callback not processed:", { resultCode, checkoutId });
    return res.status(200).json({ ResultCode: 0, ResultDesc: "No action taken" });

  } catch (err) {
    console.error("❌ ERROR in /callback:", err);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Error handled" });
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
