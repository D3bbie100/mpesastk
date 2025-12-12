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

// Log potential unsafe characters (helps identify WAF triggers)
function checkForUnsafeCharacters(payload) {
  Object.entries(payload).forEach(([key, value]) => {
    if (typeof value === "string" && /[^a-zA-Z0-9\-_\s()./]/.test(value)) {
      console.warn(`⚠️ POSSIBLE UNSAFE CHARACTERS detected in ${key}:`, value);
    }
  });
}

// Log full Safaricom error response
async function logFetchError(err) {
  if (err.name === "FetchError") {
    console.error("FETCH ERROR:", err);
    return;
  }
  console.error("Error:", err);
}

// ----------------------------------------------------------------


// In-memory pending store (replace with DB in production)
const pending = {}; // { reference: { name, email, phone, industry, createdAt } }

// Helper to generate short unique reference
function genRef() {
  return "REF-" + crypto.randomBytes(6).toString("hex");
}


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

    // Generate ref
    const accountRef = genRef();
    pending[accountRef] = { name, email, phone, industry, createdAt: Date.now() };

    // Daraja config
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackBase = process.env.MPESA_CALLBACK_BASE || "https://job-updates-app.onrender.com";

    if (!shortcode || !passkey) {
      console.error("❌ Missing SHORTCODE/PASSKEY");
      return res.status(500).json({ message: "MPESA_SHORTCODE or MPESA_PASSKEY not set" });
    }

    // Get token
    const token = await getMpesaToken();

    // Timestamp + password
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
      AccountReference: accountRef,
      TransactionDesc: `Subscription (${industry})`,
    };

    // Show payload with hidden password
    console.log("\n📤 STK Payload:");
    console.log(JSON.stringify({ ...payload, Password: "[HIDDEN]" }, null, 2));

    // Check for unsafe characters (debugging 400.002.02)
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
    }).catch((err) => {
      console.error("❌ STK FETCH FAIL:", err);
      throw err;
    });

    console.log("🔍 STK Response Status:", stkRes.status);

    const rawText = await stkRes.text();
    console.log("📥 Raw STK response:", rawText);

    let stkData = null;
    try {
      stkData = JSON.parse(rawText);
    } catch (e) {
      console.warn("⚠️ STK response JSON parse failed");
    }

    return res.json({
      status: "pending",
      message:
        "M-PESA payment prompt sent to your phone. Confirm to complete subscription.",
      reference: accountRef,
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

    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;
    if (!stkCallback) return res.status(200).json({ result: "no-stk-callback-present" });

    const resultCode = stkCallback.ResultCode;
    const items = stkCallback?.CallbackMetadata?.Item || [];

    const accountRefItem = items.find((it) => it.Name === "AccountReference");
    const phoneItem =
      items.find((it) => it.Name === "PhoneNumber" || it.Name === "MSISDN");
    const amountItem = items.find((it) => it.Name === "Amount");
    const receiptItem =
      items.find((it) => it.Name === "MpesaReceiptNumber" || it.Name === "ReceiptNumber");

    const accountRef = accountRefItem?.Value || stkCallback?.CheckoutRequestID;
    const payerPhone = phoneItem?.Value;
    const amount = amountItem?.Value;
    const receipt = receiptItem?.Value;

    console.log("🔍 Parsed callback:", {
      resultCode,
      accountRef,
      payerPhone,
      amount,
      receipt,
    });

    if (resultCode === 0 && accountRef && pending[accountRef]) {
      const entry = pending[accountRef];
      const { name, email, industry } = entry;

      const key = `MAILERLITE_GROUP_${industry.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      const groupId = process.env[key] || process.env.MAILERLITE_DEFAULT_GROUP;

      const mlPayload = {
        email,
        name,
        fields: { phone: payerPhone || "" },
      };
      if (groupId) mlPayload.groups = [groupId];

      try {
  console.log("🚀 Starting MailerLite subscription workflow...");

  const apiKey = process.env.MAILERLITE_API_KEY;
  const groupId = mlPayload.groups[0];
  const email = mlPayload.email; // make sure you have this

  console.log("🔑 API Key exists?", !!apiKey);
  console.log("👤 Target email:", email);
  console.log("📌 Target group:", groupId);

  // 1️⃣ CHECK IF SUBSCRIBER EXISTS
  console.log("🔍 Checking if subscriber already exists...");

  const checkUrl = `https://connect.mailerlite.com/api/subscribers/${email}`;
  console.log("🌐 GET URL:", checkUrl);

  const checkRes = await fetch(checkUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  console.log("📥 Check response status:", checkRes.status);

  let exists = false;
  let subscriberId = null;
  let inGroup = false;

  if (checkRes.status === 200) {
    console.log("✅ Subscriber exists. Parsing response...");

    const subData = await checkRes.json();
    console.log("🔎 Subscriber data received:", subData);

    exists = true;
    subscriberId = subData.data.id;

    console.log("🆔 Subscriber ID:", subscriberId);
    console.log("📚 Groups:", subData.data.groups);

    inGroup = subData.data.groups.some((g) => g.id === groupId);
    console.log("📍 Subscriber in target group?", inGroup);
  } else {
    console.log("ℹ️ Subscriber does NOT exist (status was not 200).");
  }

  // 2️⃣ REMOVE FROM GROUP IF THEY ALREADY EXIST IN IT
  if (exists && inGroup) {
    console.log("🔄 Subscriber already in group → removing them...");

    const deleteUrl = `https://connect.mailerlite.com/api/subscribers/${subscriberId}/groups/${groupId}`;
    console.log("🌐 DELETE URL:", deleteUrl);

    const removeRes = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    console.log("🧹 Remove response:", removeRes.status, await removeRes.text());
  }

  // 3️⃣ ADD / UPDATE SUBSCRIBER
  console.log("➕ Adding subscriber to group...");
  console.log("📦 Payload being sent:", mlPayload);

  const addRes = await fetch("https://connect.mailerlite.com/api/subscribers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(mlPayload),
  });

  console.log("📩 Final MailerLite response status:", addRes.status);

  const finalText = await addRes.text();
  console.log("📩 Final response body:", finalText);

} catch (e) {
  console.error("❌ MailerLite error:", e);
}

      delete pending[accountRef];
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Processed" });
    }

    console.warn("⚠️ Callback not processed:", { resultCode, accountRef });
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
