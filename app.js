// app.js — Yara WhatsApp: welcome (once/24h) + ordered menu + buttons + location + agent handoff + optional template header image

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;                // webhook verify secret
const WHATS_TOKEN     = process.env.WHATS_TOKEN;                 // WA access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;             // e.g. 743488178852069

const TEMPLATE_NAME   = process.env.TEMPLATE_NAME || "greetings_2";
const TEMPLATE_LANG   = process.env.TEMPLATE_LANG || "ar";

// Provide ONE (or none) if your template header expects IMAGE:
const TEMPLATE_HEADER_IMAGE_URL =
  process.env.TEMPLATE_HEADER_IMAGE_URL || ""; // e.g. public https://.../image.jpg
const TEMPLATE_HEADER_MEDIA_ID   =
  process.env.TEMPLATE_HEADER_MEDIA_ID || "";  // media id returned by /media

// Delay to keep ordering: greeting → menu (ms)
const WELCOME_MENU_DELAY_MS = Number(process.env.WELCOME_MENU_DELAY_MS || 900);

// Agent number (E.164 without '+')
const AGENT_E164 = "972525555251";

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID env vars.");
}

// ===== Utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Dedup inbound message IDs (avoid double processing when Meta retries)
const processed = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  // keep set from growing forever
  if (processed.size > 5000) {
    const it = processed.values();
    processed.delete(it.next().value);
  }
  return false;
}

// ===== WhatsApp core helper =====
async function waPost(payload) {
  const url = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
  return axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATS_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

// ===== Senders =====
async function sendTemplate(to) {
  // Only attach a header if you actually provided one
  const hasHeaderImage = Boolean(TEMPLATE_HEADER_MEDIA_ID || TEMPLATE_HEADER_IMAGE_URL);

  const template = {
    name: TEMPLATE_NAME,
    language: { code: TEMPLATE_LANG },
  };

  if (hasHeaderImage) {
    template.components = [
      {
        type: "header",
        parameters: [
          TEMPLATE_HEADER_MEDIA_ID
            ? { type: "image", image: { id: TEMPLATE_HEADER_MEDIA_ID } }
            : { type: "image", image: { link: TEMPLATE_HEADER_IMAGE_URL } },
        ],
      },
    ];
  }

  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template,
  });
}

async function sendText(to, body) {
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

async function sendMenu(to) {
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
        sections: [
          {
            title: "القائمة",
            rows: [
              { id: "show_products",  title: "عرض التشكيلة",    description: "خواتم • أطقم • سلاسل" },
              { id: "show_pricing",   title: "الأسعار والعروض",  description: "خصومات ومجموعات خاصة" },
              { id: "show_location",  title: "📍 موقعنا (اللوكيشن)", description: "استلم موقعنا كلوكيشن" },
              { id: "talk_agent",     title: "📞 خدمة العملاء",   description: "تواصل مباشر مع ممثلنا" },
            ],
          },
        ],
      },
    },
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
      address: "شارع ابن زيدون، طمرة",
    },
  });
}

// ===== Agent handoff via wa.me (prefills the agent’s box) =====
function buildAgentLink(question, waId) {
  // Convert E.164 “972xxxxxxxxx” -> local “0xxxxxxxxx”
  const local = waId?.startsWith("972") ? "0" + waId.slice(3) : waId;
  const msg = `لقد وصلتك رسالة من "${local}" والرسالة هي:\n${question}`;
  const encoded = encodeURIComponent(msg);
  return `https://wa.me/${AGENT_E164}?text=${encoded}`;
}

// Track users who picked “talk to agent” and we’re waiting for their question
const awaitingQuestion = new Map(); // wa_id -> true

async function startAgentFlow(from) {
  awaitingQuestion.set(from, true);
  await sendText(
    from,
    "لخدمتِك بشكل أسرع، من فضلك اكتب باختصار سؤالك أو ما تريد الاستفسار عنه، وسنوفّر لك رابط محادثة مباشرة مع ممثل الخدمة."
  );
}

async function finishAgentFlow(from, userText) {
  awaitingQuestion.delete(from);
  const link = buildAgentLink(userText, from);
  await sendText(
    from,
    `شكرًا لك! اضغط على الرابط لبدء محادثة مباشرة مع ممثل الخدمة (سيظهر سؤالك مهيّأً للإرسال):\n${link}`
  );
}

// ===== Choice router (buttons & list) =====
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  if (key === "عرض التشكيلة" || key === "show_products") {
    await sendText(from, "تفضّل تشكيلة مجوهرات يارا: https://your-site/collection");
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
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
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
        const v = change.value || {};

        // ignore delivery/read
        if (v.statuses) continue;

        for (const msg of v.messages || []) {
          const from = msg.from;
          const id   = msg.id;

          if (!from || alreadyProcessed(id)) continue;

          // If waiting for agent question and user sent text
          const textBody = msg.text?.body?.trim();
          if (awaitingQuestion.get(from) && textBody) {
            await finishAgentFlow(from, textBody);
            continue;
          }

          // free-text location keywords
          if (textBody && /^(الموقع|لوكيشن|المكان|location|map)$/i.test(textBody)) {
            await sendLocation(from);
            continue;
          }

          // interactive: button
          if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
            const { id, title } = msg.interactive.button_reply || {};
            await handleChoice(from, id || title);
            continue;
          }

          // interactive: list reply
          if (msg.type === "interactive" && msg.interactive?.type === "list_reply") {
            const { id, title } = msg.interactive.list_reply || {};
            await handleChoice(from, id || title);
            continue;
          }

          // Any other inbound: welcome (once per 24h) then menu
          if (shouldSendWelcome(from)) {
            await sendTemplate(from);                 // send greeting first
            await sleep(WELCOME_MENU_DELAY_MS);       // small pause to keep order
            await sendMenu(from);                     // then the menu
          } else {
            await sendMenu(from);                     // subsequent messages: menu only
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err?.response?.data || err);
    res.sendStatus(200); // always ack to avoid retries
  }
});

// Health check
app.get("/health", (_req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
