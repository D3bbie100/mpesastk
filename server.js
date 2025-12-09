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

// ---------------------- PENDING STORE ----------------------
const pending = {}; // CheckoutRequestID → user data

function genRef() {
  return "REF-" + crypto.randomBytes(6).toString("hex");
}

// ---------------------- TOKEN ----------------------
async function getMpesaToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const url =
    process.env.MPESA_OAUTH_URL ||
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  const data = await res.json();
  return data.access_token;
}

// ---------------------- HTML ----------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------- SUBSCRIBE ----------------------
app.post("/subscribe", async (req, res) => {
  try {
    const { name, email, phone, industry } = req.body;

    const accountRef = genRef();
    pending[accountRef] = { name, email, phone, industry, createdAt: Date.now() };

    const token = await getMpesaToken();

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString("base64");

    const callbackURL = `${process.env.MPESA_CALLBACK_URL}?token=${process.env.SAFARICOM_CALLBACK_TOKEN}`;

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: 10,
      PartyA: phone,
      PartyB: "6976785",
      PhoneNumber: phone,
      CallBackURL: callbackURL,
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
    let stkData = null;

    try {
      stkData = JSON.parse(rawText);
    } catch (e) {}

    // 🔥 Store pending using CheckoutRequestID
    if (stkData?.CheckoutRequestID) {
      pending[stkData.CheckoutRequestID] = pending[accountRef];
      pending[stkData.CheckoutRequestID].originalRef = accountRef;
    }

    return res.json({
      status: "pending",
      message: "M-PESA payment prompt sent. Confirm to complete subscription.",
      reference: accountRef,
      stk: stkData,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to initiate payment",
      error: err.message,
    });
  }
});

// ---------------------- CALLBACK ----------------------
app.post("/callback", async (req, res) => {
  try {
    // 🔐 SAFARICOM CALLBACK VALIDATION
    const providedToken = req.query.token;
    if (providedToken !== process.env.SAFARICOM_CALLBACK_TOKEN) {
      console.warn("❌ Invalid callback token — rejected callback");
      return res.status(403).json({ ResultCode: 1, ResultDesc: "Forbidden" });
    }

    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;
    if (!stkCallback) return res.status(200).json({ result: "no-callback" });

    const resultCode = stkCallback.ResultCode;
    const checkoutID = stkCallback.CheckoutRequestID;

    const items = stkCallback?.CallbackMetadata?.Item || [];
    const phoneItem = items.find((it) => it.Name === "PhoneNumber");
    const payerPhone = phoneItem?.Value;

    const receiptItem = items.find((it) => it.Name === "MpesaReceiptNumber");
    const receipt = receiptItem?.Value;

    if (resultCode === 0 && pending[checkoutID]) {
      const entry = pending[checkoutID];
      const { name, email, industry } = entry;

      const key = `MAILERLITE_GROUP_${industry
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_")}`;

      const groupId = process.env[key] || process.env.MAILERLITE_DEFAULT_GROUP;

      const mlPayload = {
        email,
        name,
        fields: { phone: payerPhone || "" },
        groups: groupId ? [groupId] : undefined,
      };

      try {
        await fetch("https://connect.mailerlite.com/api/subscribers", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
          },
          body: JSON.stringify(mlPayload),
        });
      } catch (e) {
        console.error("MailerLite error:", e);
      }

      delete pending[checkoutID];

      return res.status(200).json({ ResultCode: 0, ResultDesc: "Processed" });
    }

    return res.status(200).json({ ResultCode: 0, ResultDesc: "No action taken" });
  } catch (err) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Error handled" });
  }
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
