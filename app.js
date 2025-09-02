// app.js — Yara WhatsApp
// - Ordered greeting (template) ➜ single menu (no spam)
// - Catalog link, location pin + hours
// - Option 4 -> mini flow: Service -> Full name -> Message -> forward to agent (no photos)
// - Agent forward: open 24h window only if needed (no deep links)
// - Handles Meta 131047 (re-engagement) and 131049 (ecosystem throttle) both on send AND on async webhook status

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

// Agent flow state per user: { step, service, name, message }
const agentFlow = new Map();

// Agent 24h window tracking for the agent number itself
const agentWindowUntil = new Map(); // AGENT_E164 -> timestamp (ms)
function isAgentWindowOpen() {
  const until = agentWindowUntil.get(AGENT_E164) || 0;
  return Date.now() < until;
}
function markAgentWindowOpen() {
  agentWindowUntil.set(AGENT_E164, Date.now() + Math.floor(23.5 * 60 * 60 * 1000)); // 23.5h
}

// Track agent messages we send so we can retry on async status=failed(131047)
const pendingAgentSends = new Map(); // msgId -> { payload, context, attempts }

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of welcomeCache.entries())
    if (now - ts > WELCOME_TTL_MS) welcomeCache.delete(k);
  for (const [k, ts] of menuShownRecently.entries())
    if (now - ts > 60 * 60 * 1000) menuShownRecently.delete(k);
  if (menuSentForTemplate.size > 10000) menuSentForTemplate.clear();

  // clear stale pending agent sends (older than ~30min)
  for (const [k, v] of pendingAgentSends.entries()) {
    if (v.ts && now - v.ts > 30 * 60 * 1000) pendingAgentSends.delete(k);
  }
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

  return data?.messages?.[0]?.id || null; // WA id of template message
}

async function sendText(to, body) {
  const { data } = await waPost({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
  return data?.messages?.[0]?.id || null;
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
              { id: "open_catalog",   title: "عرض الكتالوج",   description: "استعراض جميع المنتجات" },
              { id: "browse_catalog", title: "تصفح حسب الفئة", description: "اختيار مجموعة من الكتالوج" },
              { id: "show_location",  title: "📍 الموقع",       description: "اللوكيشن وساعات العمل" },
              { id: "talk_agent",     title: "📞 خدمة العملاء",  description: "تواصل مع ممثل الخدمة" },
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
  // Hours — ASCII text/newlines only to avoid encoding issues
  await sendText(
    to,
    "⏰ ساعات العمل:\n- السبت إلى الخميس: 12:00 ظهرا إلى 21:00 مساء\n- الجمعة: 15:00 ظهرا إلى 21:00 مساء"
  );
}

// ===== Catalog helpers =====
const BUSINESS_PHONE_CC = "972557215081"; // your WA business phone (no +)
function catalogLinkForCollection(/*collectionId*/) {
  return `https://wa.me/c/${BUSINESS_PHONE_CC}`; // default catalog
}
async function sendCatalogLink(to, variant = "new") {
  const intro =
    variant === "best"
      ? "⭐ تفضّل أحدث المختارات الأكثر طلبا في كاتالوجنا:"
      : "🛍️ تفضّل أحدث تشكيلاتنا في الكاتالوج:";
  await sendText(to, `${intro}\n${catalogLinkForCollection("default")}`);
}

// ===== Agent handoff =====
function localize(waId) {
  return waId?.startsWith("972") ? "0" + waId.slice(3) : waId;
}

async function sendAgentNotifyTemplate(toAgentE164, { name, localNumber, service, message }) {
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

  await waPost({
    messaging_product: "whatsapp",
    to: toAgentE164,
    type: "template",
    template,
  });
  markAgentWindowOpen();
}

async function ensureAgentWindowOpen(context) {
  if (isAgentWindowOpen()) return;
  await sendAgentNotifyTemplate(AGENT_E164, context);
  await sleep(600);
}

// NOTE: removed deep-linking to customer per your request.
// We keep a resilient send that can handle 131047/131049 synchronously.
async function safeSendToAgent(payload, openContext) {
  // Try once
  try {
    const resp = await waPost(payload);
    return resp?.data?.messages?.[0]?.id || null;
  } catch (e) {
    const err = e?.response?.data?.error || {};
    const code = err.code;
    const details = err?.error_data?.details || "";

    // 24h window closed => open with template and retry
    if (code === 131047 || /re-engagement/i.test(details)) {
      await ensureAgentWindowOpen(openContext);
      await sleep(800);
      const resp2 = await waPost(payload);
      return resp2?.data?.messages?.[0]?.id || null;
    }

    // "healthy ecosystem" throttle => short backoff & retry once
    if (code === 131049) {
      await sleep(1500);
      const resp3 = await waPost(payload);
      return resp3?.data?.messages?.[0]?.id || null;
    }

    throw e;
  }
}

async function forwardTextToAgentOpenWindow({ name, service, message, fromWaId }) {
  const local = localize(fromWaId);

  // 1) Open only if needed via approved template
  await ensureAgentWindowOpen({
    name,
    localNumber: local,
    service,
    message,
  });

  // 2) Build single text to agent (NO LINKS)
  const body =
    "تفاصيل الطلب:\n" +
    `الاسم: ${name}\n` +
    `الرقم: ${local}\n` +
    `الخدمة: ${service}\n` +
    `الرسالة: ${message}`;

  const payload = {
    messaging_product: "whatsapp",
    to: AGENT_E164,
    type: "text",
    text: { body },
  };

  // 3) Send safely; keep for async retry if Meta returns failure later via webhook
  const msgId = await safeSendToAgent(payload, {
    name,
    localNumber: local,
    service,
    message,
  });

  if (msgId) {
    pendingAgentSends.set(msgId, {
      payload,
      context: { name, localNumber: local, service, message },
      attempts: 1,
      ts: Date.now(),
    });
  }
}

// ===== Agent mini-flow (Option 4) — no photos =====
function resetAgentFlow(waId) { agentFlow.delete(waId); }

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
async function askFullName(waId)  { await sendText(waId, "من فضلك اكتب اسمك الكامل:"); }
async function askMessage(waId)   { await sendText(waId, "اكتب رسالتك بالتفصيل:"); }

async function startAgentFlow(waId) {
  agentFlow.set(waId, { step: "choose_service" });
  await sendServiceMenu(waId);
}
async function handleServiceChoice(waId, idOrTitle) {
  const st = agentFlow.get(waId) || {};
  let service = "";
  switch ((idOrTitle || "").trim()) {
    case "svc_repair":
    case "تصليح":   service = "تصليح"; break;
    case "svc_sell":
    case "بيع":     service = "بيع"; break;
    case "svc_buy":
    case "شراء":    service = "شراء"; break;
    case "svc_inquiry":
    case "استفسار": service = "استفسار"; break;
    default:
      await sendServiceMenu(waId); return;
  }
  st.service = service;
  st.step = "ask_name";
  agentFlow.set(waId, st);
  await askFullName(waId);
}
async function handleName(waId, textBody) {
  const st = agentFlow.get(waId); if (!st) return;
  st.name = textBody;
  st.step = "message";
  agentFlow.set(waId, st);
  await askMessage(waId);
}
async function handleCustomerMessage(waId, textBody) {
  const st = agentFlow.get(waId); if (!st) return;
  st.message = textBody;
  st.step = "forward";
  agentFlow.set(waId, st);

  // Forward to agent and ACK to customer
  try {
    await forwardTextToAgentOpenWindow({
      name: st.name,
      service: st.service,
      message: st.message,
      fromWaId: waId,
    });

    await sendText(
      waId,
      "تم استلام رسالتك بنجاح ✅\nسيتواصل معك فريق خدمة العملاء في أقرب وقت ممكن، وذلك خلال مدة أقصاها 24 ساعة.\nشكرًا لتواصلك معنا 💎"
    );

  } catch (err) {
    console.error("❌ Forward to agent failed:", err?.response?.data || err);
    await sendText(
      waId,
      "تعذر إرسال رسالتك الآن. سنحاول مجددًا قريبًا. إذا استمرّ ذلك، راسلنا بكلمة 'خدمة' لإعادة المحاولة."
    );
  } finally {
    resetAgentFlow(waId);
  }
}

// ===== Choice router (main menu) =====
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  if (key === "open_catalog" || key === "show_catalog_new") {
    await sendCatalogLink(from, "new");
  } else if (key === "browse_catalog" || key === "show_catalog_best") {
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

        // --- A) STATUS callbacks ---
        if (Array.isArray(v.statuses) && v.statuses.length) {
          for (const st of v.statuses) {
            const waId   = st?.recipient_id; // customer wa_id (or agent E164 for our case)
            const msgId  = st?.id;           // message id whose status changed
            const status = st?.status;       // sent | delivered | read | failed

            // Greeting->Menu ordering (only on 'sent')
            const pendingId = pendingMenuByUser.get(waId);
            if (pendingId && pendingId === msgId) {
              if (status === "sent" && !menuSentForTemplate.has(msgId)) {
                try {
                  if (canShowMenu(waId)) {
                    await sendMenu(waId);
                    markMenuShown(waId);
                  }
                } finally {
                  menuSentForTemplate.add(msgId);
                  pendingMenuByUser.delete(waId);
                }
              }
            }

            // Agent async failure (131047) ➜ open window with template ➜ retry once
            const agentPending = pendingAgentSends.get(msgId);
            if (agentPending) {
              if (status === "failed") {
                const errObj = Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;
                const code   = errObj?.code;
                const details = errObj?.error_data?.details || "";

                if (code === 131047 || /re-engagement/i.test(details)) {
                  const { payload, context, attempts } = agentPending;
                  if (attempts < 2) {
                    try {
                      await ensureAgentWindowOpen(context);
                      await sleep(800);
                      const resp = await waPost(payload);
                      const newId = resp?.data?.messages?.[0]?.id || null;
                      if (newId) {
                        pendingAgentSends.set(newId, {
                          payload,
                          context,
                          attempts: attempts + 1,
                          ts: Date.now(),
                        });
                      }
                    } catch (e) {
                      console.error("❌ Agent resend failed:", e?.response?.data || e);
                    } finally {
                      pendingAgentSends.delete(msgId);
                    }
                  } else {
                    pendingAgentSends.delete(msgId);
                  }
                } else {
                  // Other failure types -> drop
                  pendingAgentSends.delete(msgId);
                }
              } else if (status === "sent" || status === "delivered" || status === "read") {
                // Successful path -> cleanup
                pendingAgentSends.delete(msgId);
              }
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
