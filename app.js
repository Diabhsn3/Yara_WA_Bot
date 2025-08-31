// app.js — Yara WhatsApp auto-welcome + button handling (once per 24h)

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;        // used in webhook verify
const WHATS_TOKEN     = process.env.WHATS_TOKEN;         // WhatsApp access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;     // e.g. 743488178852069

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID environment variables.");
}

// ===== WhatsApp helpers =====
async function waPost(payload) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

// 1) Send your approved template (edit name/lang if needed)
async function sendTemplate(to) {
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: "greeting", language: { code: "ar" } }
  });
}

// 2) Send a plain text message
async function sendText(to, body) {
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });
}

// 3) (Optional) Interactive list menu to follow the welcome
async function sendMenu(to) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "مجوهرات يارا ✨" },
      body:   { text: "اختر الخدمة المطلوبة:" },
      footer: { text: "شكراً لاختيارك يارا" },
      action: {
        button: "عرض الخدمات",
        sections: [{
          title: "القائمة",
          rows: [
            { id: "show_products", title: "عرض التشكيلة", description: "خواتم • أطقم • سلاسل" },
            { id: "show_pricing",  title: "الأسعار والعروض", description: "خصومات ومجموعات خاصة" },
            { id: "talk_agent",    title: "تواصل مع ممثل",  description: "خدمة العملاء مباشرة" }
          ]
        }]
      }
    }
  };
  await waPost(payload);
}

// Replies based on template Quick Reply OR list/menu selections
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  // Handle template quick-replies (match on button title)
  if (key === "عرض التشكيلة" || key === "show_products") {
    await sendText(from, "تفضل تشكيلة مجوهرات يارا: https://your-site/collection");
  } else if (key === "الأسعار والعروض" || key === "show_pricing") {
    await sendText(from, "الأسعار والعروض الحالية: https://your-site/pricing");
  } else if (key === "تواصل مع ممثل خدمة العملاء" || key === "talk_agent") {
    await sendText(from, "سيتم تحويلك لممثل خدمة العملاء قريباً. يمكنك أيضاً إرسال سؤالك هنا.");
  } else {
    await sendText(from, "كيف نقدر نساعدك؟");
  }
}

// ===== Welcome throttle: once per user per 24h =====
const WELCOME_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const welcomeCache = new Map(); // wa_id -> lastSentTimestamp

function shouldSendWelcome(waId) {
  const now = Date.now();
  const last = welcomeCache.get(waId);
  if (!last || now - last > WELCOME_TTL_MS) {
    welcomeCache.set(waId, now);
    return true;
  }
  return false;
}

// Clean old cache entries hourly
setInterval(() => {
  const now = Date.now();
  for (const [waId, ts] of welcomeCache.entries()) {
    if (now - ts > WELCOME_TTL_MS) welcomeCache.delete(waId);
  }
}, 60 * 60 * 1000);

// ===== Webhook verify (GET /) =====
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

// ===== Webhook receive (POST /) =====
app.post("/", async (req, res) => {
  try {
    const body = req.body;
    console.log("📥 Inbound:", JSON.stringify(body, null, 2));

    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Ignore delivery/read statuses
        if (value.statuses) continue;

        const messages = value.messages || [];
        for (const msg of messages) {
          const from = msg.from;
          if (!from) continue;

          // A) User tapped a quick-reply button in your template
          if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
            const { id, title } = msg.interactive.button_reply || {};
            console.log("🔘 Template button:", { id, title });
            await handleChoice(from, id || title);
            continue; // do not send the welcome again
          }

          // B) User selected from your interactive LIST menu
          if (msg.type === "interactive" && msg.interactive?.type === "list_reply") {
            const { id, title } = msg.interactive.list_reply || {};
            console.log("📋 List choice:", { id, title });
            await handleChoice(from, id || title);
            continue;
          }

          // C) Any other inbound (e.g., plain text)
          if (shouldSendWelcome(from)) {
            // First time in 24h: send template (welcome) then menu (optional)
            await sendTemplate(from);
            await sendMenu(from);                 // remove if you don't want menu
          } else {
            // Already welcomed within TTL: just send menu or handle normally
            await sendMenu(from);                 // or: await sendText(from, "كيف نقدر نساعدك؟");
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook error:", e?.response?.data || e);
    res.sendStatus(200); // Always ack to avoid retries
  }
});

// Health check
app.get("/health", (_req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
