require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const getAccessToken = async () => {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const res = await axios.get(
    'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    }
  );

  return res.data.access_token;
};

app.post('/stkpush', async (req, res) => {
  try {
    const accessToken = await getAccessToken();

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const { phone } = req.body;

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: 10,
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'Payment',
      TransactionDesc: 'Payment',
    };

    console.log("Payload being sent:", payload); // 🔍 Debug print

    const stkRes = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json(stkRes.data);
} catch (err) {
  if (err.response) {
    console.error("❌ Error response from Safaricom:", {
      status: err.response.status,
      data: err.response.data,
      headers: err.response.headers,
    });
  } else {
    console.error("❌ Request failed:", err.message);
  }

  res.status(500).json({ error: 'STK Push failed' });
}
});

app.post('/callback', (req, res) => {
  console.log('M-Pesa callback:', req.body);
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
