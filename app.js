// app.js
// ----- Imports & setup
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;         // e.g. hasan-verify-123
const WHATS_TOKEN = process.env.WHATS_TOKEN;           // long-lived token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // from API Setup page

// ----- Helpers to call WhatsApp Cloud API
async function sendTemplate(to) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "yara_greeting",     // your approved template name
      language: { code: "ar" }   // Arabic
    }
  };
  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

// (optional) send a simple text reply
async function sendText(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  };
  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

// ----- Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ----- Inbound messages (POST)
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log("\n📥 Inbound:", JSON.stringify(body, null, 2));

    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const messages = change.value?.messages;
          if (messages && messages.length > 0) {
            const msg = messages[0];
            const from = msg.from; // customer number E.164 w/o '+'

            // For ANY new inbound message, auto-send your greeting template
            await sendTemplate(from);

            // Example: after template, you could follow with a text or interactive menu
            // await sendText(from, "Reply 1 to see our menu.");
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err?.response?.data || err.message);
    res.sendStatus(200); // always 200 so Meta doesn't retry too hard
  }
});

// health check
app.get("/", (_req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
