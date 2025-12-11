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


// =============================================================
// ✅ SAFARICOM CALLBACK TOKEN VALIDATION
// =============================================================
function validateSafaricomCallback(req) {
  const token = req.query.token;
  if (!token) return false;

  const expected = process.env.CALLBACK_TOKEN;
  return token === expected;
}


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
    let stkData = null;

    try {
      stkData = JSON.parse(rawText);
    } catch (e) {}

    // Store the CheckoutRequestID → pending user
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


// =============================================================
// 🔥 MAILERLITE HELPERS
// =============================================================

// Get subscriber by email
async function findSubscriber(email) {
  const res = await fetch(
    `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
      },
    }
  );

  if (res.status === 404) return null;
  return await res.json();
}

// Remove subscriber from group
async function removeFromGroup(subscriberId, groupId) {
  await fetch(
    `https://connect.mailerlite.com/api/subscribers/${subscriberId}/groups/${groupId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
      },
    }
  );
}

// Add (or re-add) subscriber
async function addToGroup(email, name, phone, groupId) {
  const payload = {
    email,
    name,
    fields: { phone },
    groups: [groupId],
  };

  await fetch(`https://connect.mailerlite.com/api/subscribers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
}


// ---------------------- CALLBACK ----------------------
app.post("/callback", async (req, res) => {
  try {
    // SAFARICOM CALLBACK VALIDATION
    if (!validateSafaricomCallback(req)) {
      console.log("❌ Invalid Safaricom token");
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Invalid token" });
    }

    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;
    if (!stkCallback) return res.status(200).json({ result: "no-callback" });

    const resultCode = stkCallback.ResultCode;

    // Identify user using CheckoutRequestID
    const accountRef = stkCallback.CheckoutRequestID;
    const items = stkCallback?.CallbackMetadata?.Item || [];
    const phoneItem = items.find((it) => it.Name === "PhoneNumber");
    const payerPhone = phoneItem?.Value;

    if (resultCode === 0 && pending[accountRef]) {
      const entry = pending[accountRef];
      const { name, email, industry } = entry;

      const key = `MAILERLITE_GROUP_${industry
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "_")}`;

      const groupId = process.env[key] || process.env.MAILERLITE_DEFAULT_GROUP;

      try {
        // 🔥 CHECK IF SUBSCRIBER EXISTS
        const subscriber = await findSubscriber(email);

        if (subscriber) {
          const isInGroup = subscriber.groups?.some((g) => g.id === groupId);
          if (isInGroup) {
            // 🔥 REMOVE FIRST to refresh timestamp
            await removeFromGroup(subscriber.id, groupId);
          }
        }

        // 🔥 ADD (or re-add) subscriber to group
        await addToGroup(email, name, payerPhone || "", groupId);

      } catch (e) {
        console.error("MailerLite error:", e);
      }

      delete pending[accountRef];
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Processed" });
    }

    return res.status(200).json({ ResultCode: 0, ResultDesc: "No action taken" });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Error handled" });
  }
});


// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
