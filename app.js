// app.js — Auto-welcome with a WhatsApp Template

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- ENV (set these in Render → Environment) ---
const PORT             = process.env.PORT || 3000;
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN;      // e.g. hasan-verify-123
const WHATS_TOKEN      = EAANeda0KzzABPZAXOOpZBzEKfxXTiVtLpSn7QIr5QWXSHLdb7bZBbaPX4SxezqgMZBlBo4p6AkiBtvcyyD37b9pYRFg2dq69EZBLHrRLSKVQmlcr3rvao98FUkw9EZAzIPlfweZC5ES9jnOaJYuGf1YZBFIztRD60oDkNGauJJlVnnZB99TWDGEuCWAzq7HGLDiq9DZALfcvZAynDje7q8mSghgfdihe9GZAgH7DyS9aVfvNBeDhsgZDZD;       // your WA access token
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;   // e.g. 743488178852069

// --- helper: send your approved template (change name/lang if needed) ---
async function sendTemplate(to) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: "greeting", language: { code: "ar" } } // <— your template
  };
  try {
    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("✅ Template sent:", JSON.stringify(data));
  } catch (err) {
    console.error("❌ sendTemplate error:",
      err.response?.data || err.message || err);
  }
}

// --- GET /  (Webhook verification) ---
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- POST / (Inbound messages) ---
app.post("/", async (req, res) => {
  try {
    const body = req.body;
    console.log("\n📥 Inbound:", JSON.stringify(body, null, 2));

    // Only handle WhatsApp BA notifications
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Ignore delivery/read status webhooks
        if (value.statuses) continue;

        const messages = value.messages || [];
        for (const msg of messages) {
          const from = msg.from; // customer's WA number (E.164 without '+')
          if (!from) continue;

          // Auto send your welcome template
          await sendTemplate(from);
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook handler error:", e.response?.data || e);
    return res.sendStatus(200); // always ack to avoid retries
  }
});

// Health check
app.get("/health", (_req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`\n🚀 Listening on ${PORT}\n`));
