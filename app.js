// app.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;         // e.g. hasan-verify-123
const WHATS_TOKEN = process.env.WHATS_TOKEN;           // WA access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // digits from API Setup

async function sendTemplate(to) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: "yara_greeting", language: { code: "ar" } }
  };
  await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WHATS_TOKEN}`, "Content-Type": "application/json" }
  });
}

// Verify webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Handle inbound
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log("📥 Inbound:", JSON.stringify(body, null, 2));
    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const msgs = change.value?.messages;
          if (msgs && msgs.length) {
            const from = msgs[0].from; // customer number
            await sendTemplate(from);
          }
        }
      }
    }
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e);
  }
  res.sendStatus(200);
});

app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
