// app.js — Yara WhatsApp
// - Ordered greeting (template) ➜ single menu (no spam)
// - Catalog links, location pin + hours
// - Option 4 -> mini flow: Service -> Name -> Message -> (optional) Photos
// - For agent handoff: send agent template, WAIT for status, then send text + photos

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

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

const BUSINESS_CATALOG_NUMBER = (process.env.BUSINESS_CATALOG_NUMBER || "972557215081").trim();

if (!WHATS_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing WHATS_TOKEN or PHONE_NUMBER_ID env vars.");
}

// ===== Utils & guards =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dedup inbound messages to avoid retries double-processing
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
// { step, service, name, message, attachments:[{mediaId}], wantPhotos }
const agentFlow = new Map();

// ===== Agent template open-window wait queue =====
// templateMsgId -> { fromWaId, payloads: [ {kind:'text', body}, {kind:'image', mediaId, caption} ... ] }
const pendingAgentSends = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of welcomeCache) if (now - ts > WELCOME_TTL_MS) welcomeCache.delete(k);
  for (const [k, ts] of menuShownRecently) if (now - ts > 60*60*1000) menuShownRecently.delete(k);
  if (menuSentForTemplate.size > 10000) menuSentForTemplate.clear();
  // Trim pending agent sends older than 10 minutes
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

// Media helpers
async function getMediaUrl(mediaId) {
  const { data } = await axios.get(`https://graph.facebook.com/v23.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATS_TOKEN}` },
  });
  return { url: data.url, mime_type: data.mime_type };
}
async function downloadMedia(url) {
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATS_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return resp.data; // Buffer
}
async function uploadMediaToWA(buffer, mime_type, filename = "file") {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mime_type });
  form.append("type", mime_type);
  const { data } = await axios.post(
    `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${WHATS_TOKEN}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );
  return data.id;
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

// Queue messages to agent and send AFTER we get template status
async function queueAgentMessagesFrom(waId, { name, service, message }) {
  const local = toLocal(waId);

  // 1) Open 24h window via template
  const tmplId = await sendAgentNotifyTemplate(AGENT_E164, {
    name, localNumber: local, service, message
  });

  // 2) Build queue (text only)
  const textBody =
    `تفاصيل الطلب:\nالاسم: ${name}\nالرقم: ${local}\nالخدمة: ${service}\nالرسالة: ${message}`;

  pendingAgentSends.set(tmplId, {
    fromWaId: waId,
    created: Date.now(),
    flushed: false,
    payloads: [
      { kind: "text", body: textBody }
    ],
  });
  console.log(`↪️ Queued agent forward under template ${tmplId} for ${AGENT_E164}`);

  // 3) Fallback: if no status arrives in ~6s, flush anyway
  setTimeout(async () => {
    const job = pendingAgentSends.get(tmplId);
    if (job && !job.flushed) {
      console.log(`⏱️ Fallback flush for template ${tmplId}`);
      try { await flushAgentQueueForTemplate(tmplId); } catch (e) {
        console.error("❌ Fallback flush error:", e?.response?.data || e);
      }
    }
  }, 6000);
}

// Send everything in the queued payloads to agent (called when template status arrives)
async function flushAgentQueueForTemplate(tmplId) {
  const job = pendingAgentSends.get(tmplId);
  if (!job) return;
  if (job.flushed) return;
  job.flushed = true;
  pendingAgentSends.set(tmplId, job);
  console.log(`🚚 Flushing agent queue for template ${tmplId} (${job.payloads.length} items)`);

  for (const p of job.payloads) {
    try {
      if (p.kind === "text") {
        await waPost({ messaging_product:"whatsapp", to: AGENT_E164, type:"text", text:{ body: p.body } });
      } else if (p.kind === "image") {
        const { url, mime_type } = await getMediaUrl(p.mediaId);
        const bin = await downloadMedia(url);
        const newId = await uploadMediaToWA(bin, mime_type, "attachment");
        await waPost({ messaging_product:"whatsapp", to: AGENT_E164, type:"image", image:{ id: newId, caption: p.caption } });
      }
      await sleep(200);
    } catch (e) {
      console.error("❌ Sending to agent failed:", e?.response?.data || e);
    }
  }

  pendingAgentSends.delete(tmplId);
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
// attachments flow removed

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
  else { await sendServiceMenu(waId); return; }

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
  agentFlow.set(waId, st);
  await queueAgentMessagesFrom(waId, st);
  await sendText(
    waId,
    "تم استلام رسالتك بنجاح ✅\nسيتواصل معك فريق خدمة العملاء في أقرب وقت ممكن، وذلك خلال مدة أقصاها 24 ساعة.\nشكرًا لتواصلك معنا 💎"
  );
  resetAgentFlow(waId);
}
async function handleIncomingImage(waId, imageObj) {
  const st = agentFlow.get(waId);
  if (!st || st.step !== "collecting_media") return false;
  const mediaId = imageObj.id;
  if (!mediaId) return true;

  st.attachments = st.attachments || [];
  if (st.attachments.length < 3) st.attachments.push({ mediaId });
  agentFlow.set(waId, st);

  if (st.attachments.length >= 3) {
    await queueAgentMessagesFrom(waId, st);
    resetAgentFlow(waId);
  } else {
    await sendText(waId, `تم استلام الصورة (${st.attachments.length}/3). يمكنك إرسال المزيد أو اكتب "تم".`);
  }
  return true;
}
async function maybeFinishOnDoneKeyword(waId, text) {
  const st = agentFlow.get(waId);
  if (!st || st.step !== "collecting_media") return false;
  if (!text) return false;
  if (/^(تم|خلص|انتهيت|done)$/i.test(text.trim())) {
    await queueAgentMessagesFrom(waId, st);
    resetAgentFlow(waId);
    return true;
  }
  return false;
}

// ===== Main menu router =====
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  if (key === "open_catalog") {
    await sendCatalogLink(from);
  } else if (key === "browse_catalog") {
    await sendCatalogLink(from); // extend later to deep-link set
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

            // Greeting -> Menu
            const pendingId = pendingMenuByUser.get(waId);
            if (pendingId && pendingId === msgId && status === "sent" && !menuSentForTemplate.has(msgId)) {
              if (canShowMenu(waId)) { await sendMenu(waId); markMenuShown(waId); }
              menuSentForTemplate.add(msgId);
              pendingMenuByUser.delete(waId);
            }

            // Agent template: when 'sent' or 'delivered', flush queue
            if ((status === "sent" || status === "delivered") && pendingAgentSends.has(msgId) && waId === AGENT_E164) {
              await flushAgentQueueForTemplate(msgId);
            }
          }
          continue;
        }

        // B) Inbound messages
        for (const msg of v.messages || []) {
          const from = msg.from;
          const id   = msg.id;
          if (!from || alreadyProcessed(id)) continue;

          // Agent media collecting
          if (msg.type === "image" && msg.image?.id) {
            const handled = await handleIncomingImage(from, msg.image);
            if (handled) continue;
          }

          const textBody = msg.text?.body?.trim();

          // Collecting media: accept "تم"
          if (await maybeFinishOnDoneKeyword(from, textBody)) continue;

          // Agent flow steps
          const st = agentFlow.get(from);
          if (st) {
            if (msg.type === "interactive" && msg.interactive?.type === "list_reply" && st.step === "choose_service") {
              const { id, title } = msg.interactive.list_reply || {};
              await handleServiceChoice(from, id || title); continue;
            }
            if (msg.type === "interactive" && msg.interactive?.type === "button_reply" && st.step === "attachments_confirm") {
              const { id, title } = msg.interactive.button_reply || {};
              await handleAttachmentsDecision(from, id || title); continue;
            }
            if (st.step === "ask_name" && textBody) { await handleName(from, textBody); continue; }
            if (st.step === "message"  && textBody) { await handleCustomerMessage(from, textBody); continue; }
            if (st.step === "collecting_media" && textBody) {
              await sendText(from, 'أرسل حتى 3 صور، أو اكتب "تم" عند الانتهاء.'); continue;
            }
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
