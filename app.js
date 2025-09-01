// app.js — Yara WhatsApp: welcome (once/24h) + menu + buttons + location + agent handoff link + template header image

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;        // webhook verify secret
const WHATS_TOKEN     = process.env.WHATS_TOKEN;         // WA access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;     // e.g. 743488178852069

// Template config (you can override from Render → Environment)
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || "greetings_2";
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || "ar";

// If your template header expects IMAGE, provide ONE of these:
// 1) Public URL (we use your Google Drive direct link by default)
const TEMPLATE_HEADER_IMAGE_URL =
  process.env.TEMPLATE_HEADER_IMAGE_URL ||
  "https://drive.google.com/uc?export=download&id=10FOFqxeM0YO72n6SaOHGYfVIEU5vBbLw";

// 2) OR media id (if you uploaded the image to WhatsApp and got an id)
// If you set this, leave TEMPLATE_HEADER_IMAGE_URL empty.
const TEMPLATE_HEADER_MEDIA_ID = process.env.TEMPLATE_HEADER_MEDIA_ID || "";

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID environment variables.");
}

// ===== Core WA helper =====
async function waPost(payload) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
}

// ===== Senders =====
async function sendTemplate(to) {
  // Build template payload and include header image if provided
  const template = {
    name: TEMPLATE_NAME,
    language: { code: TEMPLATE_LANG }
  };

  // If template has IMAGE header, we must include the header component
  const components = [];

  if (TEMPLATE_HEADER_MEDIA_ID) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { id: TEMPLATE_HEADER_MEDIA_ID } }]
    });
  } else if (TEMPLATE_HEADER_IMAGE_URL) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: TEMPLATE_HEADER_IMAGE_URL } }]
    });
  }

  if (components.length) {
    template.components = components;
  }

  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template
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

async function sendMenu(to) {
  // Interactive LIST including location and agent options
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "💎 تفضّل باختيار ما يناسبك 💎" },
      body:   { text: "نقدّم لك هذه الخيارات لتسهيل تواصلك معنا:" },
      footer: { text: "شكراً لاختيارك مجوهرات يارا" },
      action: {
        button: "عرض الخدمات",
        sections: [{
          title: "القائمة",
          rows: [
            { id: "show_products",  title: "عرض التشكيلة",   description: "خواتم • أطقم • سلاسل" },
            { id: "show_pricing",   title: "الأسعار والعروض", description: "خصومات ومجموعات خاصة" },
            { id: "show_location",  title: "📍 موقعنا (اللوكيشن)", description: "استلم موقعنا كلوكيشن" },
            { id: "talk_agent",     title: "📞 خدمة العملاء",  description: "تواصل مباشر مع ممثلنا" }
          ]
        }]
      }
    }
  });
}

async function sendLocation(to) {
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "location",
    location: {
      latitude: 32.84854,
      longitude: 35.20420,
      name: "مجوهرات يارا",
      address: "شارع ابن زيدون، طمرة"
    }
  });
}

// ===== Agent handoff via wa.me link =====
const AGENT_E164 = "972525555251"; // agent number (without +)
function buildAgentLink(question, waId) {
  const msg = `مرحبا، لدي سؤال من ${waId}:\n${question}`;
  const encoded = encodeURIComponent(msg);
  return `https://wa.me/${AGENT_E164}?text=${encoded}`;
}

// Track users who selected “talk to agent” and we’re waiting for their question
const awaitingQuestion = new Map(); // wa_id -> true

async function startAgentFlow(from) {
  awaitingQuestion.set(from, true);
  await sendText(
    from,
    "لخدمتِك بشكل أسرع، من فضلك اكتب باختصار سؤالك أو ما تريد الاستفسار عنه، وسنحوّلك لممثل خدمة العملاء."
  );
}

async function finishAgentFlow(from, userText) {
  awaitingQuestion.delete(from);
  const link = buildAgentLink(userText, from);
  await sendText(
    from,
    `شكرًا لك! اضغط على الرابط لبدء محادثة مباشرة مع ممثل الخدمة، وسيظهر سؤالك مُسبقًا:\n${link}`
  );
}

// ===== Choice router (buttons & list) =====
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  if (key === "عرض التشكيلة" || key === "show_products") {
    await sendText(from, "تفضل تشكيلة مجوهرات يارا: https://your-site/collection");
  } else if (key === "الأسعار والعروض" || key === "show_pricing") {
    await sendText(from, "الأسعار والعروض الحالية: https://your-site/pricing");
  } else if (key === "الموقع" || key === "show_location") {
    await sendLocation(from);
  } else if (key === "تواصل مع ممثل خدمة العملاء" || key === "talk_agent" || key === "📞 خدمة العملاء") {
    await startAgentFlow(from);
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

// Clean old cache entries hourly (best-effort)
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

          // 0) Keyword location by free text
          const textBody = msg.text?.body?.trim();
          if (textBody && /^(الموقع|لوكيشن|المكان|location|map)$/i.test(textBody)) {
            await sendLocation(from);
            continue;
          }

          // If we are waiting for the user's question for agent handoff:
          if (awaitingQuestion.get(from) && textBody) {
            await finishAgentFlow(from, textBody);
            continue;
          }

          // 1) Template Quick Reply buttons
          if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
            const { id, title } = msg.interactive.button_reply || {};
            console.log("🔘 Template button:", { id, title });
            await handleChoice(from, id || title);
            continue;
          }

          // 2) Interactive LIST selections
          if (msg.type === "interactive" && msg.interactive?.type === "list_reply") {
            const { id, title } = msg.interactive.list_reply || {};
            console.log("📋 List choice:", { id, title });
            await handleChoice(from, id || title);
            continue;
          }

          // 3) Any other inbound (e.g., plain text)
          if (shouldSendWelcome(from)) {
            await sendTemplate(from);
            await sendMenu(from);
          } else {
            await sendMenu(from);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ Webhook error:", e?.response?.data || e);
    res.sendStatus(200); // always ack to avoid retries
  }
});

// Health check
app.get("/health", (_req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
