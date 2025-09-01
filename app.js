// app.js — Yara WhatsApp
// Reliable order: send greeting template, wait for status, then send menu.
// Includes: header image, location sharing, agent handoff link, 24h throttle.

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const WHATS_TOKEN     = process.env.WHATS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // e.g. 743488178852069

// Template config
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || "greetings_2";
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || "ar";

// If your template header expects IMAGE, pass ONE of:
//   TEMPLATE_HEADER_MEDIA_ID  (if uploaded to WA media)
//   TEMPLATE_HEADER_IMAGE_URL (public URL)
const TEMPLATE_HEADER_MEDIA_ID = process.env.TEMPLATE_HEADER_MEDIA_ID || "";
const TEMPLATE_HEADER_IMAGE_URL =
  process.env.TEMPLATE_HEADER_IMAGE_URL ||
  "https://drive.google.com/uc?export=download&id=10FOFqxeM0YO72n6SaOHGYfVIEU5vBbLw";

// Agent handoff
const AGENT_E164 = "972525555251"; // agent number without '+'

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID env vars.");
}

// ===== HTTP helper to WA =====
async function waPost(payload) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
}

// ===== Senders =====
async function sendTemplate(to) {
  const template = {
    name: TEMPLATE_NAME,
    language: { code: TEMPLATE_LANG },
  };

  // add header image if provided (and template expects an IMAGE header)
  const components = [];
  if (TEMPLATE_HEADER_MEDIA_ID) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { id: TEMPLATE_HEADER_MEDIA_ID } }],
    });
  } else if (TEMPLATE_HEADER_IMAGE_URL) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: TEMPLATE_HEADER_IMAGE_URL } }],
    });
  }
  if (components.length) template.components = components;

  const res = await waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template,
  });

  // Return message id (used to correlate status events if you want)
  return res.data?.messages?.[0]?.id || null;
}

async function sendMenu(to) {
  return waPost({
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
            { id: "talk_agent",     title: "📞 خدمة العملاء",  description: "تواصل مباشر مع ممثلنا" },
          ],
        }],
      },
    },
  });
}

async function sendText(to, body) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

async function sendLocation(to) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "location",
    location: {
      latitude: 32.84854,
      longitude: 35.20420,
      name: "مجوهرات يارا",
      address: "شارع ابن زيدون، طمرة",
    },
  });
}

// ===== Agent handoff (wa.me prefilled) =====
function buildAgentLink(question, waId) {
  const localNumber = "0" + waId.slice(3); // convert 972xxxxxxxxx → 0xxxxxxxxx
  const msg = `لقد وصلتك رسالة من "${localNumber}" والرسالة هي:\n${question}`;
  return `https://wa.me/${AGENT_E164}?text=${encodeURIComponent(msg)}`;
}

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
  await sendText(from, `شكرًا لك! اضغط على الرابط لبدء محادثة مباشرة مع ممثل الخدمة:\n${link}`);
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
const WELCOME_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const welcomeCache = new Map(); // wa_id -> lastTimestamp
function shouldSendWelcome(waId) {
  const now = Date.now();
  const last = welcomeCache.get(waId);
  if (!last || now - last > WELCOME_TTL_MS) {
    welcomeCache.set(waId, now);
    return true;
  }
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [waId, ts] of welcomeCache.entries()) {
    if (now - ts > WELCOME_TTL_MS) welcomeCache.delete(waId);
  }
}, 60 * 60 * 1000);

// ===== Ordering fix: queue menu until template status =====
const pendingMenuAfterTemplate = new Set(); // wa_id’s waiting for menu
const FALLBACK_MENU_DELAY_MS = 3000; // safety: send menu if no status arrives in time

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
    if (body.object !== "whatsapp_business_account") return res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // 1) Handle STATUS callbacks first (ordering fix)
        const statuses = value.statuses || [];
        for (const st of statuses) {
          const waId  = st.recipient_id;  // user number
          const type  = st.status;        // sent | delivered | read | failed
          const msgId = st.id;            // message id (if you need it)
          console.log("📨 Status:", { waId, type, msgId });

          if (pendingMenuAfterTemplate.has(waId) && (type === "sent" || type === "delivered")) {
            pendingMenuAfterTemplate.delete(waId);
            // send the menu now that the template is out
            await sendMenu(waId);
          }
        }

        // 2) Handle messages
        const messages = value.messages || [];
        for (const msg of messages) {
          const from = msg.from;
          if (!from) continue;

          // quick free-text: share location
          const textBody = msg.text?.body?.trim();
          if (textBody && /^(الموقع|لوكيشن|المكان|location|map)$/i.test(textBody)) {
            await sendLocation(from);
            continue;
          }

          // If we asked the user for their question for the agent:
          if (awaitingQuestion.get(from) && textBody) {
            await finishAgentFlow(from, textBody);
            continue;
          }

          // Template quick reply buttons:
          if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
            const { id, title } = msg.interactive.button_reply || {};
            await handleChoice(from, id || title);
            continue;
          }

          // Interactive list selections:
          if (msg.type === "interactive" && msg.interactive?.type === "list_reply") {
            const { id, title } = msg.interactive.list_reply || {};
            await handleChoice(from, id || title);
            continue;
          }

          // First message in 24h → send template, then wait for status to send menu
          if (shouldSendWelcome(from)) {
            await sendTemplate(from);
            pendingMenuAfterTemplate.add(from);

            // Fallback: if for some reason no status arrives, send menu after a short delay
            setTimeout(async () => {
              if (pendingMenuAfterTemplate.has(from)) {
                pendingMenuAfterTemplate.delete(from);
                await sendMenu(from);
              }
            }, FALLBACK_MENU_DELAY_MS);
          } else {
            // Already welcomed: show menu directly
            await sendMenu(from);
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
