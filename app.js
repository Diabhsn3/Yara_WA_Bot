const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const WHATS_TOKEN     = process.env.WHATS_TOKEN;          // must be set in Render
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;      // e.g. 743488178852069

// ---------- helpers ----------
async function waPost(payload) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

async function sendTemplate(to) {
  // your approved template name & language
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: "greeting", language: { code: "ar" } }
  });
}

async function sendText(to, body) {
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });
}

// Example replies per button
async function handleButtonChoice(from, titleOrId) {
  // Normalize (trim/strip) just in case
  const key = (titleOrId || "").trim();

  if (key === "عرض التشكيلة") {
    await sendText(from, "تفضل تشكيلة مجوهرات يارا: https://your-site/collection");
  } else if (key === "الأسعار والعروض") {
    await sendText(from, "الأسعار والعروض الحالية: https://your-site/pricing");
  } else if (key === "تواصل مع ممثل خدمة العملاء") {
    await sendText(from, "سيتواصل معك ممثل خدمة العملاء قريباً. بإمكانك أيضاً إرسال سؤالك هنا.");
  } else {
    // Fallback
    await sendText(from, "شكراً لتواصلك معنا. كيف نقدر نساعدك؟");
  }
}

// ---------- webhook verify ----------
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ---------- webhook receive ----------
app.post("/", async (req, res) => {
  try {
    const body = req.body;
    console.log("📥 Inbound:", JSON.stringify(body, null, 2));

    if (body.object !== "whatsapp_business_account") return res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // ignore delivery/read status callbacks
        if (value.statuses) continue;

        const msgs = value.messages || [];
        for (const msg of msgs) {
          const from = msg.from;
          if (!from) continue;

          // 1) Handle quick-reply button clicks from your template
          if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
            const { id, title } = msg.interactive.button_reply || {};
            console.log("🔘 Button clicked:", { id, title });
            await handleButtonChoice(from, id || title);
            continue;
          }

          // 2) For any other inbound (e.g., plain text), send welcome template
          await sendTemplate(from);
        }
      }
    }
  } catch (e) {
    console.error("❌ Webhook error:", e?.response?.data || e);
  }
  res.sendStatus(200);
});

app.get("/health", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
