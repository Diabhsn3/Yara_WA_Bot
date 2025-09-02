// app.js — Yara WhatsApp
// - Ordered greeting (template) ➜ single menu (no spam)
// - Catalog entries, location pin + hours
// - Option 4 -> mini flow: Service -> Full name -> Message -> forward to agent
// - Agent forward: try Utility/Service template to open 24h window; if blocked, fall back to wa.me link

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== ENV =====
const PORT            = process.env.PORT || 3000;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const WHATS_TOKEN     = process.env.WHATS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const TEMPLATE_NAME   = (process.env.TEMPLATE_NAME || "greetings_2").trim();
const TEMPLATE_LANG   = (process.env.TEMPLATE_LANG || "ar").trim();
const TEMPLATE_HEADER_IMAGE_URL = (process.env.TEMPLATE_HEADER_IMAGE_URL || "").trim();
const TEMPLATE_HEADER_MEDIA_ID  = (process.env.TEMPLATE_HEADER_MEDIA_ID  || "").trim();

const AGENT_E164            = (process.env.AGENT_E164 || "972525555251").trim();
const AGENT_TEMPLATE_NAME   = (process.env.AGENT_TEMPLATE_NAME || "agent_notify").trim();
const AGENT_TEMPLATE_LANG   = (process.env.AGENT_TEMPLATE_LANG || "ar").trim();

const BUSINESS_CATALOG_PHONE = (process.env.BUSINESS_CATALOG_PHONE || "972557215081").trim(); // no '+'

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID env vars.");
}

// ===== Utils & guards =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const lastMenuAt        = new Map();  // wa_id -> timestamp
const MENU_COOLDOWN_MS  = Number(process.env.MENU_COOLDOWN_MS || 15000); // 15s
const menuShownRecently = new Map();  // wa_id -> timestamp
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

// Greeting→Menu ordering state
const pendingMenuByUser   = new Map(); // wa_id -> templateMessageId (wait for status)
const menuSentForTemplate = new Set(); // templateMessageId that already triggered a menu

// Agent mini-flow state per user
// { step: 'choose_service'|'ask_name'|'message'|'forward', service, name, message }
const agentFlow = new Map();

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
    timeout: 20000,
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
  return data?.messages?.[0]?.id; // WA id of template message
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
      header: { type: "text", text: "💎 تفضّل باختيار ما يناسبك 💎" }, // ≤ 60
      body:   { text: "نقدّم لك هذه الخيارات لتسهيل تواصلك معنا:" },
      footer: { text: "شكراً لاختيارك مجوهرات يارا" },
      action: {
        button: "عرض الخدمات", // ≤ 20
        sections: [
          {
            title: "القائمة", // ≤ 24
            rows: [
              {
                id: "open_catalog",
                title: "عرض الكتالوج",      // ≤ 24
                description: "استعراض جميع المنتجات"
              },
              {
                id: "browse_catalog",
                title: "تصفح حسب الفئة",     // ≤ 24
                description: "اختيار مجموعة من الكتالوج"
              },
              {
                id: "show_location",
                title: "📍 الموقع",          // ≤ 24
                description: "إرسال اللوكيشن وساعات العمل"
              },
              {
                id: "talk_agent",
                title: "📞 خدمة العملاء",     // ≤ 24
                description: "تواصل مع ممثل الخدمة"
              }
            ]
          }
        ]
      }
    }
  });
}

async function sendMenuWithPrompt(to) {
  await sendText(
    to,
    'لفهم طلبك بسرعة، اختر من القائمة أدناه 👇 أو اكتب "الموقع" للحصول على اللوكيشن.'
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
    "⏰ ساعات العمل:\n• السبت – الخميس: 12:00 ظهرًا – 21:00 مساءً\n• الجمعة: 15:00 ظهرًا – 21:00 مساءً"
  );
}

// ===== Catalog helpers =====
function catalogLink() {
  // opens the WhatsApp catalog for your business
  return `https://wa.me/c/${BUSINESS_CATALOG_PHONE}`;
}
async function sendCatalogLink(to, variant = "new") {
  const intro =
    variant === "best"
      ? "⭐ تفضّل أحدث المختارات الأكثر طلبًا في كاتالوجنا:"
      : "🛍️ تفضّل أحدث تشكيلاتنا في الكاتالوج:";
  await sendText(to, `${intro}\n${catalogLink()}`);
}

// ===== Agent handoff (Utility template -> text; fallback to wa.me link) =====
function localize(waId) {
  return waId?.startsWith("972") ? "0" + waId.slice(3) : waId;
}

async function sendAgentNotifyTemplate(toAgentE164, { name, localNumber, service, message }) {
  // This template MUST be Utility/Service and approved with 4 variables.
  const template = {
    name: AGENT_TEMPLATE_NAME,
    language: { code: AGENT_TEMPLATE_LANG },
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: name || "-" },
          { type: "text", text: localNumber || "-" },
          { type: "text", text: service || "-" },
          { type: "text", text: message || "-" },
        ],
      },
    ],
  };
  const { data } = await waPost({
    messaging_product: "whatsapp",
    to: toAgentE164,
    type: "template",
    template,
  });
  return data?.messages?.[0]?.id;
}

function buildAgentLink({ name, localNumber, service, message }) {
  const text =
    `طلب جديد من ${name} (${localNumber})\n` +
    `الخدمة: ${service}\n` +
    `الرسالة: ${message}`;
  return `https://wa.me/${AGENT_E164}?text=${encodeURIComponent(text)}`;
}

// Try template; if blocked (131049/131047) fall back to wa.me link
async function forwardTextToAgentOpenWindow({ name, service, message, fromWaId }) {
  const local = localize(fromWaId);

  try {
    // 1) open/refresh 24h window to the agent via template
    await sendAgentNotifyTemplate(AGENT_E164, {
      name,
      localNumber: local,
      service,
      message,
    });

    // 2) pause and follow-up with details (now inside 24h window)
    await sleep(400);
    const body =
      `تفاصيل الطلب:\n` +
      `الاسم: ${name}\n` +
      `الرقم: ${local}\n` +
      `الخدمة: ${service}\n` +
      `الرسالة: ${message}`;
    await waPost({
      messaging_product: "whatsapp",
      to: AGENT_E164,
      type: "text",
      text: { body },
    });

    return { ok: true };
  } catch (err) {
    const code = err?.response?.data?.error?.code;
    const detail = err?.response?.data?.error?.error_data?.details;
    if (code === 131049 || code === 131047) {
      console.warn("Agent notify blocked, falling back:", code, detail);
      const link = buildAgentLink({ name, localNumber: local, service, message });
      return { ok: false, fallbackLink: link };
    }
    throw err;
  }
}

// ===== Agent mini-flow (Option 4) =====
function resetAgentFlow(waId) {
  agentFlow.delete(waId);
}
async function sendServiceMenu(waId) {
  await waPost({
    messaging_product: "whatsapp",
    to: waId,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "📞 خدمة العملاء" },
      body:   { text: "اختر نوع الخدمة للمتابعة:" },
      action: {
        button: "اختيار الخدمة",
        sections: [
          {
            title: "الخدمات",
            rows: [
              { id: "svc_repair",  title: "تصليح" },
              { id: "svc_sell",    title: "بيع" },
              { id: "svc_buy",     title: "شراء" },
              { id: "svc_inquiry", title: "استفسار" },
            ],
          },
        ],
      },
    },
  });
}
async function askFullName(waId) {
  await sendText(waId, "من فضلك اكتب اسمك الكامل:");
}
async function askMessage(waId) {
  await sendText(waId, "اكتب رسالتك بالتفصيل:");
}

async function startAgentFlow(waId) {
  agentFlow.set(waId, { step: "choose_service" });
  await sendServiceMenu(waId);
}
async function handleServiceChoice(waId, idOrTitle) {
  const st = agentFlow.get(waId) || {};
  let service = "";
  switch ((idOrTitle || "").trim()) {
    case "svc_repair":
    case "تصليح":
      service = "تصليح"; break;
    case "svc_sell":
    case "بيع":
      service = "بيع"; break;
    case "svc_buy":
    case "شراء":
      service = "شراء"; break;
    case "svc_inquiry":
    case "استفسار":
      service = "استفسار"; break;
    default:
      await sendServiceMenu(waId);
      return;
  }
  st.service = service;
  st.step = "ask_name";
  agentFlow.set(waId, st);
  await askFullName(waId);
}
async function handleName(waId, textBody) {
  const st = agentFlow.get(waId);
  if (!st) return;
  st.name = textBody;
  st.step = "message";
  agentFlow.set(waId, st);
  await askMessage(waId);
}
async function handleCustomerMessage(waId, textBody) {
  const st = agentFlow.get(waId);
  if (!st) return;
  st.message = textBody;
  st.step = "forward";
  agentFlow.set(waId, st);
  await forwardToAgentAndAck(waId);
}

async function forwardToAgentAndAck(waId) {
  const st = agentFlow.get(waId);
  if (!st || !st.name || !st.service || !st.message) {
    await sendText(waId, "نقصت بعض البيانات — سنعيد تشغيل الخدمة.");
    resetAgentFlow(waId);
    await startAgentFlow(waId);
    return;
  }

  try {
    const result = await forwardTextToAgentOpenWindow({
      name: st.name,
      service: st.service,
      message: st.message,
      fromWaId: waId,
    });

    if (result.ok) {
      await sendText(
        waId,
        "تم إرسال رسالتك إلى فريق خدمة العملاء ✅\nسيتواصلون معك في أقرب وقت ممكن. شكرًا لتواصلك معنا."
      );
    } else {
      await sendText(
        waId,
        "حاولنا إرسال رسالتك تلقائيًا لكن واجهتنا مشكلة بسيطة.\nيمكنك إرسال الرسالة مباشرة لممثل الخدمة عبر هذا الرابط:\n" +
        result.fallbackLink
      );
    }
  } catch (err) {
    console.error("❌ Forward to agent failed:", err?.response?.data || err);
    await sendText(
      waId,
      "تعذر إرسال رسالتك الآن. سنحاول مجددًا قريبًا. إذا استمرّ ذلك، اكتب 'خدمة' لإعادة المحاولة."
    );
  } finally {
    resetAgentFlow(waId);
  }
}

// ===== Choice router (main menu) =====
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  if (key === "open_catalog") {
    await sendCatalogLink(from, "new");
  } else if (key === "browse_catalog") {
    await sendCatalogLink(from, "best");
  } else if (key === "show_location" || key === "الموقع") {
    await sendLocation(from);
  } else if (key === "talk_agent" || key === "📞 خدمة العملاء") {
    await startAgentFlow(from);
  } else {
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
          continue;
        }

        // --- B) Inbound messages from the user ---
        for (const msg of v.messages || []) {
          const from = msg.from;
          const id   = msg.id;
          if (!from || alreadyProcessed(id)) continue;

          const textBody = msg.text?.body?.trim();

          // Agent flow steps
          const st = agentFlow.get(from);
          if (st) {
            if (msg.type === "interactive" && msg.interactive?.type === "list_reply" && st.step === "choose_service") {
              const { id, title } = msg.interactive.list_reply || {};
              await handleServiceChoice(from, id || title);
              continue;
            }
            if (st.step === "ask_name" && textBody) {
              await handleName(from, textBody);
              continue;
            }
            if (st.step === "message" && textBody) {
              await handleCustomerMessage(from, textBody);
              continue;
            }
          }

          // Location keywords (outside the agent flow)
          if (textBody && /^(الموقع|لوكيشن|المكان|location|map)$/i.test(textBody)) {
            await sendLocation(from);
            continue;
          }

          // Interactive replies from main menu
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

          // Non-interactive free text (not in agent-flow):
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
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err?.response?.data || err);
    res.sendStatus(200); // Always ACK
  }
});

// Health
app.get("/health", (_req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`🚀 Listening on ${PORT}`));
