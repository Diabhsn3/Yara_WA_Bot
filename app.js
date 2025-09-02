// app.js — Yara WhatsApp
// - Ordered greeting (template) ➜ single menu (no spam)
// - Catalog link, location pin + hours
// - Option 4 -> mini flow: Service -> Full name -> Message -> forward to agent
// - Agent forward: send Utility template to open 24h window, WAIT for status, then send details
// - If template fails (131047/131049), notify customer + provide backup link

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

const AGENT_E164            = (process.env.AGENT_E164 || "972525555251").trim(); // agent number (no '+')
const AGENT_TEMPLATE_NAME   = (process.env.AGENT_TEMPLATE_NAME || "agent_notify").trim(); // Utility template
const AGENT_TEMPLATE_LANG   = (process.env.AGENT_TEMPLATE_LANG || "ar").trim();

const BUSINESS_CATALOG_NUMBER = (process.env.BUSINESS_CATALOG_NUMBER || "972557215081").trim();

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID env vars.");
}

// ===== Utils & guards =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dedup inbound messages (Meta retries)
const processed = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.add(id);
  if (processed.size > 5000) processed.delete(processed.values().next().value);
  return false;
}

// Per-user throttles
const lastMenuAt        = new Map();  // wa_id -> ts
const MENU_COOLDOWN_MS  = Number(process.env.MENU_COOLDOWN_MS || 15000);
const menuShownRecently = new Map();
function canShowMenu(waId) {
  const now = Date.now();
  const a = lastMenuAt.get(waId) || 0;
  const b = menuShownRecently.get(waId) || 0;
  return (now - a >= MENU_COOLDOWN_MS) && (now - b >= MENU_COOLDOWN_MS);
}
function markMenuShown(waId) {
  const now = Date.now();
  lastMenuAt.set(waId, now);
  menuShownRecently.set(waId, now);
}

// Welcome throttle (once / 24h)
const WELCOME_TTL_MS = 24 * 60 * 60 * 1000;
const welcomeCache   = new Map(); // wa_id -> ts
function shouldSendWelcome(waId) {
  const now  = Date.now();
  const last = welcomeCache.get(waId);
  if (!last || now - last > WELCOME_TTL_MS) { welcomeCache.set(waId, now); return true; }
  return false;
}

// Greeting→Menu ordering state
const pendingMenuByUser   = new Map(); // wa_id -> templateMessageId
const menuSentForTemplate = new Set(); // templateMessageId

// ===== Agent flow state =====
// { step, service, name, message }
const agentFlow = new Map();

// ===== Agent template wait queue =====
// templateMsgId -> { fromWaId, body }
const pendingAgentSends = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of welcomeCache) if (now - ts > WELCOME_TTL_MS) welcomeCache.delete(k);
  for (const [k, ts] of menuShownRecently) if (now - ts > 60*60*1000) menuShownRecently.delete(k);
  if (menuSentForTemplate.size > 10000) menuSentForTemplate.clear();
  // Trim agent queue older than 10 minutes
  for (const [k, v] of pendingAgentSends) if ((v.created || now) + 10*60*1000 < now) pendingAgentSends.delete(k);
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
    template.components = [{
      type: "header",
      parameters: [
        TEMPLATE_HEADER_MEDIA_ID
          ? { type: "image", image: { id: TEMPLATE_HEADER_MEDIA_ID } }
          : { type: "image", image: { link: TEMPLATE_HEADER_IMAGE_URL } },
      ],
    }];
  }
  const { data } = await waPost({ messaging_product:"whatsapp", to, type:"template", template });
  return data?.messages?.[0]?.id;
}

async function sendText(to, body) {
  await waPost({ messaging_product:"whatsapp", to, type:"text", text:{ body } });
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
            { id: "open_catalog",   title: "عرض الكتالوج",   description: "استعراض جميع المنتجات" },
            { id: "browse_catalog", title: "تصفح حسب الفئة", description: "اختيار مجموعة/فئة" },
            { id: "show_location",  title: "📍 الموقع",       description: "اللوكيشن وساعات العمل" },
            { id: "talk_agent",     title: "📞 خدمة العملاء",  description: "التواصل مع ممثلنا" }
          ],
        }],
      },
    },
  });
}

async function sendMenuWithPrompt(to) {
  await sendText(to, 'لفهم طلبك بسرعة، اختر من القائمة أدناه 👇 أو اكتب "الموقع" للحصول على اللوكيشن.');
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
  const hours =
    "⏰ ساعات العمل:\n" +
    "• السبت – الخميس: 12:00 ظهرًا – 21:00 مساءً\n" +
    "• الجمعة: 15:00 ظهرًا – 21:00 مساءً";
  await sendText(to, hours);
}

// Catalog link
function catalogLink() { return `https://wa.me/c/${BUSINESS_CATALOG_NUMBER}`; }
async function sendCatalogLink(to) { await sendText(to, `🛍️ تفضّل الكتالوج:\n${catalogLink()}`); }

// ===== Agent handoff =====
function toLocal(waId) { return waId?.startsWith("972") ? "0" + waId.slice(3) : waId; }

async function sendAgentNotifyTemplate(toAgentE164, { name, localNumber, service, message }) {
  // This template must be category = Utility and approved
  const template = {
    name: AGENT_TEMPLATE_NAME,
    language: { code: AGENT_TEMPLATE_LANG },
    components: [{
      type: "body",
      parameters: [
        { type: "text", text: name || "-" },
        { type: "text", text: localNumber || "-" },
        { type: "text", text: service || "-" },
        { type: "text", text: message || "-" },
      ],
    }],
  };
  const { data } = await waPost({ messaging_product:"whatsapp", to: toAgentE164, type:"template", template });
  return data?.messages?.[0]?.id;
}

async function queueAgentMessage(waId, { name, service, message }) {
  const local = toLocal(waId);
  // 1) Open 24h with template
  const tmplId = await sendAgentNotifyTemplate(AGENT_E164, {
    name, localNumber: local, service, message,
  });

  // 2) Prepare the follow-up text (to send after template status)
  const body =
    `تفاصيل الطلب:\n` +
    `الاسم: ${name}\n` +
    `الرقم: ${local}\n` +
    `الخدمة: ${service}\n` +
    `الرسالة: ${message}`;

  pendingAgentSends.set(tmplId, {
    fromWaId: waId,
    created: Date.now(),
    body,
  });

  // 3) Tell the customer immediately
  await sendText(waId, "تم إرسال طلبك إلى فريق خدمة العملاء ✅\nسيتواصلون معك في أقرب وقت ممكن. شكرًا لتواصلك معنا.");
}

async function flushAgentQueueForTemplate(tmplId) {
  const job = pendingAgentSends.get(tmplId);
  if (!job) return;
  try {
    await waPost({ messaging_product:"whatsapp", to: AGENT_E164, type:"text", text:{ body: job.body } });
  } catch (e) {
    console.error("❌ Agent follow-up text failed:", e?.response?.data || e);
  } finally {
    pendingAgentSends.delete(tmplId);
  }
}

function backupLinkToAgent(waId, { name, service, message }) {
  const local = toLocal(waId);
  const txt = encodeURIComponent(
    `طلب جديد\nالاسم: ${name}\nالرقم: ${local}\nالخدمة: ${service}\nالرسالة: ${message}`
  );
  return `https://wa.me/${AGENT_E164}?text=${txt}`;
}

// ===== Agent mini-flow (Option 4) =====
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
        sections: [{
          title: "الخدمات",
          rows: [
            { id: "svc_repair",  title: "تصليح" },
            { id: "svc_sell",    title: "بيع" },
            { id: "svc_buy",     title: "شراء" },
            { id: "svc_inquiry", title: "استفسار" },
          ],
        }],
      },
    },
  });
}
async function askFullName(waId) { await sendText(waId, "من فضلك اكتب اسمك الكامل:"); }
async function askMessage(waId)  { await sendText(waId, "اكتب رسالتك بالتفصيل:"); }

async function startAgentFlow(waId) {
  agentFlow.set(waId, { step: "choose_service" });
  await sendServiceMenu(waId);
}
async function handleServiceChoice(waId, idOrTitle) {
  const st = agentFlow.get(waId) || {};
  const k = (idOrTitle || "").trim();
  if (k === "svc_repair" || k === "تصليح") st.service = "تصليح";
  else if (k === "svc_sell" || k === "بيع") st.service = "بيع";
  else if (k === "svc_buy" || k === "شراء") st.service = "شراء";
  else if (k === "svc_inquiry" || k === "استفسار") st.service = "استفسار";
  else { await sendServiceMenu(waId); return;

  }
  st.step = "ask_name";
  agentFlow.set(waId, st);
  await askFullName(waId);
}
async function handleName(waId, text) {
  const st = agentFlow.get(waId); if (!st) return;
  st.name = text;
  st.step = "message";
  agentFlow.set(waId, st);
  await askMessage(waId);
}
async function handleCustomerMessage(waId, text) {
  const st = agentFlow.get(waId); if (!st) return;
  st.message = text;
  // Queue to agent (template + wait)
  try {
    await queueAgentMessage(waId, st);
  } catch (err) {
    // Template send failed immediately (e.g., policy) — tell customer and give backup link
    console.error("❌ Agent template send failed:", err?.response?.data || err);
    const link = backupLinkToAgent(waId, st);
    await sendText(
      waId,
      `تعذر إرسال الطلب تلقائيًا الآن. اضغط هذا الرابط لمراسلة فريق الخدمة مباشرةً:\n${link}`
    );
  } finally {
    resetAgentFlow(waId);
  }
}

// ===== Main menu router =====
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  if (key === "open_catalog") {
    await sendCatalogLink(from);
  } else if (key === "browse_catalog") {
    await sendCatalogLink(from); // You can later deep-link a specific set
  } else if (key === "show_location" || key === "الموقع") {
    await sendLocation(from);
  } else if (key === "talk_agent" || key === "📞 خدمة العملاء") {
    await startAgentFlow(from);
  } else {
    if (canShowMenu(from)) { await sendMenuWithPrompt(from); markMenuShown(from); }
  }
}

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

        // A) STATUS callbacks
        if (Array.isArray(v.statuses) && v.statuses.length) {
          for (const st of v.statuses) {
            const waId   = st?.recipient_id;
            const msgId  = st?.id;
            const status = st?.status;
            const error  = st?.errors?.[0];

            // Greeting -> Menu
            const pendingId = pendingMenuByUser.get(waId);
            if (pendingId && pendingId === msgId && status === "sent" && !menuSentForTemplate.has(msgId)) {
              if (canShowMenu(waId)) { await sendMenu(waId); markMenuShown(waId); }
              menuSentForTemplate.add(msgId);
              pendingMenuByUser.delete(waId);
            }

            // Agent template: on 'sent' or 'delivered' flush; on 'failed' offer backup
            if (pendingAgentSends.has(msgId) && waId === AGENT_E164) {
              if (status === "sent" || status === "delivered") {
                await flushAgentQueueForTemplate(msgId);
              } else if (status === "failed") {
                const job = pendingAgentSends.get(msgId);
                pendingAgentSends.delete(msgId);
                // Tell the customer + provide manual link
                if (job?.fromWaId) {
                  await sendText(
                    job.fromWaId,
                    "تعذر إرسال الطلب تلقائيًا إلى فريق الخدمة الآن. سنحاول تحسين المسار.\n" +
                    "يمكنك أيضًا مراسلتهم مباشرة عبر هذا الرابط:"
                  );
                  // Reconstruct link text from job.body
                  const linkTxt = encodeURIComponent(job.body);
                  const backup = `https://wa.me/${AGENT_E164}?text=${linkTxt}`;
                  await sendText(job.fromWaId, backup);
                }
                console.error("❌ Agent template failed:", error || st);
              }
            }
          }
          return res.sendStatus(200);
        }

        // B) Inbound messages
        for (const msg of v.messages || []) {
          const from = msg.from;
          const id   = msg.id;
          if (!from || alreadyProcessed(id)) continue;

          const textBody = msg.text?.body?.trim();

          // Agent flow steps
          const af = agentFlow.get(from);
          if (af) {
            if (msg.type === "interactive" && msg.interactive?.type === "list_reply" && af.step === "choose_service") {
              const { id, title } = msg.interactive.list_reply || {};
              await handleServiceChoice(from, id || title); continue;
            }
            if (af.step === "ask_name" && textBody) { await handleName(from, textBody); continue; }
            if (af.step === "message"  && textBody) { await handleCustomerMessage(from, textBody); continue; }
          }

          // Location keywords
          if (textBody && /^(الموقع|لوكيشن|المكان|location|map)$/i.test(textBody)) { await sendLocation(from); continue; }

          // Interactive from main menu
          if (msg.type === "interactive") {
            if (msg.interactive?.type === "button_reply") {
              const { id, title } = msg.interactive.button_reply || {};
              await handleChoice(from, id || title); continue;
            }
            if (msg.interactive?.type === "list_reply") {
              const { id, title } = msg.interactive.list_reply || {};
              await handleChoice(from, id || title); continue;
            }
          }

          // Free text not in a flow → greeting+menu or prompt+menu
          if (textBody) {
            if (shouldSendWelcome(from)) {
              const templateMsgId = await sendTemplate(from);
              if (templateMsgId) pendingMenuByUser.set(from, templateMsgId);
              else if (canShowMenu(from)) { await sendMenu(from); markMenuShown(from); }
            } else {
              if (canShowMenu(from)) { await sendMenuWithPrompt(from); markMenuShown(from); }
            }
          }
        }

        return res.sendStatus(200);
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
