// app.js — Yara WhatsApp: ordered greeting ➜ single menu
// + location, agent handoff, template header image, and CATALOG (Option B: product_list)

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const WHATS_TOKEN     = process.env.WHATS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const TEMPLATE_NAME   = process.env.TEMPLATE_NAME || "greetings_2";
const TEMPLATE_LANG   = process.env.TEMPLATE_LANG || "ar";
const TEMPLATE_HEADER_IMAGE_URL = (process.env.TEMPLATE_HEADER_IMAGE_URL || "").trim();
const TEMPLATE_HEADER_MEDIA_ID  = (process.env.TEMPLATE_HEADER_MEDIA_ID  || "").trim();

const AGENT_E164 = "972525555251"; // agent number (no +)

// === Catalog (Option B) ===
const CATALOG_ID = (process.env.CATALOG_ID || "").trim(); // required to send catalog
// Comma-separated retailer IDs from your Google Sheet: e.g. "p001,p002,p003"
const CATALOG_RETAILER_IDS = (process.env.CATALOG_RETAILER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID env vars.");
}

// ===== Utils =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Deduplicate inbound message IDs (Meta may retry)
const processed = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  if (processed.size > 5000) processed.delete(processed.values().next().value);
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
  const template = { name: TEMPLATE_NAME, language: { code: TEMPLATE_LANG } };
  const hasHeaderImage = Boolean(TEMPLATE_HEADER_MEDIA_ID || TEMPLATE_HEADER_IMAGE_URL);
  if (hasHeaderImage) {
    template.components = [{
      type: "header",
      parameters: [
        TEMPLATE_HEADER_MEDIA_ID
          ? { type: "image", image: { id: TEMPLATE_HEADER_MEDIA_ID } }
          : { type: "image", image: { link: TEMPLATE_HEADER_IMAGE_URL } },
      ],
    }];
  }

  const { data } = await waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template,
  });

  return data?.messages?.[0]?.id; // used to order greeting -> menu
}

async function sendText(to, body) {
  await waPost({ messaging_product: "whatsapp", to, type: "text", text: { body } });
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
        sections: [{
          title: "القائمة",
          rows: [
            { id: "show_products",  title: "عرض التشكيلة",     description: "خواتم • أطقم • سلاسل" },
            { id: "show_pricing",   title: "الأسعار والعروض",   description: "خصومات ومجموعات خاصة" },
            { id: "show_location",  title: "📍 موقعنا (اللوكيشن)", description: "استلم موقعنا كلوكيشن" },
            { id: "show_catalog",   title: "📖 الكتالوج",        description: "تصفح منتجاتنا" }, // NEW
            { id: "talk_agent",     title: "📞 خدمة العملاء",    description: "تواصل مباشر مع ممثلنا" },
          ],
        }],
      },
    },
  });
}

async function sendMenuWithPrompt(to) {
  await sendText(to, "لفهم طلبك بسرعة، اختر من القائمة أدناه 👇 أو اكتب \"الموقع\" للحصول على اللوكيشن.");
  await sendMenu(to);
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
      address: "طمرة، شارع ابن زيدون",
    },
  });
  await sendText(to, `⏰ ساعات العمل:\n• السبت – الخميس: 12:00 ظهرًا – 21:00 مساءً\n• الجمعة: 15:00 ظهرًا – 21:00 مساءً`);
}

// ====== Catalog senders (Option B) ======
async function sendCatalogList(to) {
  if (!CATALOG_ID || CATALOG_RETAILER_IDS.length === 0) {
    await sendText(to, "الكتالوج غير مهيأ بعد. الرجاء المحاولة لاحقًا.");
    return;
  }

  // Build sections with up to 30 products total (API limit)
  const items = CATALOG_RETAILER_IDS.slice(0, 30).map(id => ({ product_retailer_id: id }));
  const sections = [{ title: "تشكيلة مختارة", product_items: items }];

  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "product_list",
      header: { type: "text", text: "🛍️ كتالوج مجوهرات يارا" },
      body:   { text: "اختر من منتجاتنا أدناه:" },
      footer: { text: "تسوق ممتع!" },
      action: {
        catalog_id: CATALOG_ID,
        sections,
      },
    },
  });
}

// ===== Agent handoff (prefilled link) =====
function buildAgentLink(question, waId) {
  const local = waId?.startsWith("972") ? "0" + waId.slice(3) : waId;
  const msg = `لقد وصلتك رسالة من "${local}" والرسالة هي:\n${question}`;
  return `https://wa.me/${AGENT_E164}?text=${encodeURIComponent(msg)}`;
}

const awaitingQuestion     = new Map(); // wa_id -> true
const pendingMenuByUser    = new Map(); // wa_id -> templateMessageId (waiting for status)
const menuSentForTemplate  = new Set(); // template message ids that already triggered menu
const lastMenuAt           = new Map(); // wa_id -> timestamp
const MENU_COOLDOWN_MS     = 3000;

async function startAgentFlow(from) {
  awaitingQuestion.set(from, true);
  await sendText(from, "لخدمتِك بشكل أسرع، اكتب باختصار سؤالك وسنرسل لك رابط محادثة مباشرة مع ممثل الخدمة.");
}

async function finishAgentFlow(from, userText) {
  awaitingQuestion.delete(from);
  await sendText(from, `شكرًا لك! تواصل مباشرة مع ممثل الخدمة عبر الرابط:\n${buildAgentLink(userText, from)}`);
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
  } else if (key === "📖 الكتالوج" || key === "show_catalog") {
    await sendCatalogList(from); // <—— Option B
  } else if (key === "تواصل مع ممثل خدمة العملاء" || key === "talk_agent" || key === "📞 خدمة العملاء") {
    await startAgentFlow(from);
  } else {
    await sendMenuWithPrompt(from);
  }
}

// ===== Welcome throttle (once / 24h) =====
const WELCOME_TTL_MS = 24 * 60 * 60 * 1000;
const welcomeCache = new Map();
function shouldSendWelcome(waId) {
  const now = Date.now();
  const last = welcomeCache.get(waId);
  if (!last || now - last > WELCOME_TTL_MS) {
    welcomeCache.set(waId, now);
    return true;
  }
  return false;
}

// Housekeeping
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of welcomeCache.entries()) if (now - ts > WELCOME_TTL_MS) welcomeCache.delete(k);
  if (menuSentForTemplate.size > 10000) menuSentForTemplate.clear();
}, 60 * 60 * 1000);

// ===== Webhook verify =====
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Webhook receive =====
app.post("/", async (req, res) => {
  try {
    const body = req.body;
    console.log("📥 Inbound:", JSON.stringify(body, null, 2));
    if (body.object !== "whatsapp_business_account") return res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};

        // A) Status callbacks — order greeting -> menu
        if (Array.isArray(v.statuses) && v.statuses.length) {
          for (const st of v.statuses) {
            const waId   = st?.recipient_id;
            const msgId  = st?.id;
            const status = st?.status; // sent | delivered | read | failed
            const pendingId = pendingMenuByUser.get(waId);
            if (!pendingId || pendingId !== msgId) continue;
            if (status === "sent" && !menuSentForTemplate.has(msgId)) {
              const last = lastMenuAt.get(waId) || 0;
              if (Date.now() - last >= MENU_COOLDOWN_MS) {
                await sendMenu(waId);
                lastMenuAt.set(waId, Date.now());
              }
              menuSentForTemplate.add(msgId);
              pendingMenuByUser.delete(waId);
            }
          }
          continue;
        }

        // B) Inbound user messages
        for (const msg of v.messages || []) {
          const from = msg.from;
          const id   = msg.id;
          if (!from || alreadyProcessed(id)) continue;

          const textBody = msg.text?.body?.trim();

          // Agent handoff capture
          if (awaitingQuestion.get(from) && textBody) {
            await finishAgentFlow(from, textBody);
            continue;
          }

          // Location keywords
          if (textBody && /^(الموقع|لوكيشن|المكان|location|map)$/i.test(textBody)) {
            await sendLocation(from);
            continue;
          }

          // Interactive replies
          if (msg.type === "interactive") {
            if (msg.interactive?.type === "button_reply") {
              const { id, title } = msg.interactive.button_reply || {};
              await handleChoice(from, id || title);
              continue;
            }
            if (msg.interactive?.type === "list_reply") {
              const { id, title } = msg.interactive.list_reply || {};
              await handleChoice(from, id || title);
              continue;
            }
          }

          // Non-interactive free text
          if (textBody) {
            if (shouldSendWelcome(from)) {
              const templateMsgId = await sendTemplate(from);
              if (templateMsgId) {
                pendingMenuByUser.set(from, templateMsgId);
              } else {
                await sleep(600);
                await sendMenu(from);
                lastMenuAt.set(from, Date.now());
              }
            } else {
              const last = lastMenuAt.get(from) || 0;
              if (Date.now() - last >= MENU_COOLDOWN_MS) {
                await sendMenuWithPrompt(from);
                lastMenuAt.set(from, Date.now());
              }
            }
            continue;
          }

          // Anything else: send menu (cooldown)
          const last = lastMenuAt.get(from) || 0;
          if (Date.now() - last >= MENU_COOLDOWN_MS) {
            await sendMenu(from);
            lastMenuAt.set(from, Date.now());
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err?.response?.data || err);
    res.sendStatus(200);
  }
});

// Health
app.get("/health", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
