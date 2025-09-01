// app.js — Yara WhatsApp: ordered greeting ➜ single menu (no spam)
// - Greeting template (optionally with header image), once/24h
// - Menu (interactive list) sent exactly once after template 'sent' status
// - If user types free text instead of choosing: prompt + menu (cooldown)
// - Location pin + hours
// - Agent handoff via wa.me prefilled link

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;                 // webhook verify secret
const WHATS_TOKEN     = process.env.WHATS_TOKEN;                  // WA access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;              // e.g. 743488178852069

const TEMPLATE_NAME   = process.env.TEMPLATE_NAME || "greetings_2";
const TEMPLATE_LANG   = process.env.TEMPLATE_LANG || "ar";
const TEMPLATE_HEADER_IMAGE_URL =
  (process.env.TEMPLATE_HEADER_IMAGE_URL || "").trim();           // public URL if header=image
const TEMPLATE_HEADER_MEDIA_ID =
  (process.env.TEMPLATE_HEADER_MEDIA_ID || "").trim();            // media id if uploaded

const AGENT_E164 = process.env.AGENT_E164 || "972525555251";      // agent number (E.164, no +)

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID env vars.");
}

// ===== Utils & guards =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Dedup inbound message IDs (avoid double processing on Meta retries)
const processed = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  if (processed.size > 5000) {
    const it = processed.values();
    processed.delete(it.next().value);
  }
  return false;
}

// Per-user throttles
const lastMenuAt            = new Map();  // wa_id -> timestamp
const MENU_COOLDOWN_MS      = Number(process.env.MENU_COOLDOWN_MS || 15000); // 15s
const menuShownRecently     = new Map();  // wa_id -> timestamp (extra spam guard)

function canShowMenu(waId) {
  const now = Date.now();
  const last  = lastMenuAt.get(waId) || 0;
  const recent = menuShownRecently.get(waId) || 0;
  return (now - last >= MENU_COOLDOWN_MS) && (now - recent >= MENU_COOLDOWN_MS);
}
function markMenuShown(waId) {
  const now = Date.now();
  lastMenuAt.set(waId, now);
  menuShownRecently.set(waId, now);
}

// Welcome throttle: once per user per 24h
const WELCOME_TTL_MS = 24 * 60 * 60 * 1000;
const welcomeCache   = new Map(); // wa_id -> lastSentTimestamp
function shouldSendWelcome(waId) {
  const now  = Date.now();
  const last = welcomeCache.get(waId);
  if (!last || now - last > WELCOME_TTL_MS) {
    welcomeCache.set(waId, now);
    return true;
  }
  return false;
}

// Agent handoff state
const awaitingQuestion = new Map(); // wa_id -> true

// Greeting→Menu ordering state
const pendingMenuByUser   = new Map(); // wa_id -> templateMessageId (wait for status)
const menuSentForTemplate = new Set(); // templateMessageId that already triggered a menu

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of welcomeCache.entries())
    if (now - ts > WELCOME_TTL_MS) welcomeCache.delete(k);
  for (const [k, ts] of menuShownRecently.entries())
    if (now - ts > 60 * 60 * 1000) menuShownRecently.delete(k);
  if (menuSentForTemplate.size > 10000) menuSentForTemplate.clear();
}, 60 * 1000);

// ===== WhatsApp Core =====
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

  const { data } = await waPost({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template,
  });

  // Return WA message id of the template (used to match status)
  return data?.messages?.[0]?.id;
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
              { id: "show_products",  title: "عرض التشكيلة",     description: "خواتم • أطقم • سلاسل" },
              { id: "show_pricing",   title: "الأسعار والعروض",   description: "خصومات ومجموعات خاصة" },
              { id: "show_location",  title: "📍 موقعنا (اللوكيشن)", description: "استلم موقعنا كلوكيشن" },
              { id: "talk_agent",     title: "📞 خدمة العملاء",    description: "تواصل مباشر مع ممثلنا" },
            ],
          },
        ],
      },
    },
  });
}

async function sendMenuWithPrompt(to) {
  await sendText(
    to,
    "لفهم طلبك بسرعة، اختر من القائمة أدناه 👇 أو اكتب \"الموقع\" للحصول على اللوكيشن."
  );
  await sendMenu(to);
}

async function sendLocation(to) {
  // Pin
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
  // Hours
  await sendText(
    to,
    `⏰ ساعات العمل:\n• السبت – الخميس: 12:00 ظهرًا – 21:00 مساءً\n• الجمعة: 15:00 ظهرًا – 21:00 مساءً`
  );
}

// ===== Agent handoff =====
function buildAgentLink(question, waId) {
  const local = waId?.startsWith("972") ? "0" + waId.slice(3) : waId;
  const msg = `لقد وصلتك رسالة من "${local}" والرسالة هي:\n${question}`;
  const encoded = encodeURIComponent(msg);
  return `https://wa.me/${AGENT_E164}?text=${encoded}`;
}

async function startAgentFlow(from) {
  awaitingQuestion.set(from, true);
  await sendText(
    from,
    "لخدمتِك بشكل أسرع، من فضلك اكتب باختصار سؤالك أو ما تريد الاستفسار عنه، ثم سنرسل لك رابط محادثة مباشرة مع ممثل الخدمة."
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

// ===== Choice router =====
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
    // Unknown option → polite prompt + menu
    if (canShowMenu(from)) {
      await sendMenuWithPrompt(from);
      markMenuShown(from);
    }
  }
}

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

        // --- A) STATUS callbacks: keep order greeting ➜ menu (only on 'sent') ---
        if (Array.isArray(v.statuses) && v.statuses.length) {
          for (const st of v.statuses) {
            const waId   = st?.recipient_id; // customer wa_id
            const msgId  = st?.id;           // message id whose status changed
            const status = st?.status;       // sent | delivered | read | failed

            const pendingId = pendingMenuByUser.get(waId);
            if (!pendingId || pendingId !== msgId) continue;

            if (status === "sent" && !menuSentForTemplate.has(msgId)) {
              if (canShowMenu(waId)) {
                await sendMenu(waId);
                markMenuShown(waId);
              }
              menuSentForTemplate.add(msgId);
              pendingMenuByUser.delete(waId);
            }
          }
          continue; // handled statuses
        }

        // --- B) Inbound messages from the user ---
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

          // Location keywords immediately
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

          // Non-interactive free text (or any text that isn't a keyword)
          if (textBody) {
            if (shouldSendWelcome(from)) {
              const templateMsgId = await sendTemplate(from);
              if (templateMsgId) {
                pendingMenuByUser.set(from, templateMsgId); // wait for status to send menu
              } else {
                if (canShowMenu(from)) {
                  await sendMenu(from);
                  markMenuShown(from);
                }
              }
            } else {
              if (canShowMenu(from)) {
                await sendMenuWithPrompt(from);
                markMenuShown(from);
              }
            }
            continue;
          }

          // If it's neither text nor interactive (e.g., media/status echoes), do nothing.
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err?.response?.data || err);
    res.sendStatus(200); // Always ACK to avoid retries
  }
});

// Health
app.get("/health", (_req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
