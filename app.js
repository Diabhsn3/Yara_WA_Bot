// app.js — Yara WhatsApp
// - Ordered greeting (template) ➜ single menu (no spam)
// - Catalog entries, location pin + hours
// - Option 4 -> mini flow: Service -> Full name -> Message -> Attach photos? -> forward to agent
// - Agent forward: open 24h window via template, then send text + photos

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

// Agent flow state per user
// { step, service, name, message, wantPhotos, attachments:[{mediaId, mime}] }
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

// Media: get download URL, download, re-upload to our number, then return new media id
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
  return data.id; // new media id
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
                title: "عرض الكتالوج", // ≤ 24
                description: "استعراض جميع المنتجات" // ≤ 72
              },
              {
                id: "browse_catalog",
                title: "تصفح حسب الفئة", // ≤ 24
                description: "اختيار مجموعة/فئة من الكتالوج"
              },
              {
                id: "show_location",
                title: "📍 الموقع", // ≤ 24
                description: "إرسال اللوكيشن وساعات العمل"
              },
              {
                id: "talk_agent",
                title: "📞 خدمة العملاء", // ≤ 24
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
    "لفهم طلبك بسرعة، اختر من القائمة أدناه 👇 أو اكتب \"الموقع\" للحصول على اللوكيشن."
  );
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
  await sendText(
    to,
    `⏰ ساعات العمل:\n• السبت – الخميس: 12:00 ظهرًا – 21:00 مساءً\n• الجمعة: 15:00 ظهرًا – 21:00 مساءً`
  );
}

// ===== Catalog helpers (deep-link into your WA Catalog) =====
const BUSINESS_PHONE_CC = "972557215081"; // your WA business phone (no +)
function catalogLinkForCollection(collectionId) {
  // opens the WhatsApp catalog app for this business; /browse shows collections
  // (You can change to a specific collection deep-link if you have its code)
  return `https://wa.me/c/${BUSINESS_PHONE_CC}`;
}
async function sendCatalogLink(to, variant = "new") {
  const intro =
    variant === "best"
      ? "⭐ تفضّل أحدث المختارات الأكثر طلبًا في كاتالوجنا:"
      : "🛍️ تفضّل أحدث تشكيلاتنا في الكاتالوج:";
  await sendText(to, `${intro}\n${catalogLinkForCollection("default")}`);
}

// ===== Agent handoff (OPEN 24h to agent via template, then send text + photos) =====
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

  const { data } = await waPost({
    messaging_product: "whatsapp",
    to: toAgentE164,
    type: "template",
    template,
  });
  return data?.messages?.[0]?.id;
}
async function forwardTextToAgentOpenWindow({ name, service, message, fromWaId }) {
  const local = localize(fromWaId);

  // 1) Open with template (unlocks 24h)
  await sendAgentNotifyTemplate(AGENT_E164, {
    name,
    localNumber: local,
    service,
    message,
  });

  // 2) Small pause
  await sleep(400);

  // 3) Follow up with details
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
}
async function forwardImagesToAgent(attachments, caption) {
  // For each original media id: download -> upload -> send
  for (const a of attachments) {
    try {
      const { url, mime_type } = await getMediaUrl(a.mediaId);
      const bin = await downloadMedia(url);
      const newId = await uploadMediaToWA(bin, mime_type, "attachment");
      await waPost({
        messaging_product: "whatsapp",
        to: AGENT_E164,
        type: "image",
        image: { id: newId, caption },
      });
    } catch (e) {
      console.error("❌ Forward image failed:", e?.response?.data || e);
    }
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
              { id: "svc_repair", title: "تصليح" },
              { id: "svc_sell",   title: "بيع" },
              { id: "svc_buy",    title: "شراء" },
              { id: "svc_inquiry",title: "استفسار" },
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
async function askIfWantsAttachments(waId) {
  await waPost({
    messaging_product: "whatsapp",
    to: waId,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "هل تريد إضافة صور مع الرسالة؟" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "attach_yes", title: "نعم" } },
          { type: "reply", reply: { id: "attach_no",  title: "لا" } },
        ],
      },
    },
  });
}
async function askSendPhotosNow(waId) {
  await sendText(
    waId,
    "أرسل حتى 3 صور الآن (ممكن صورة تلو الأخرى). عندما تنتهي اكتب كلمة: تم"
  );
}

async function startAgentFlow(waId) {
  agentFlow.set(waId, { step: "choose_service", attachments: [] });
  await sendServiceMenu(waId);
}
async function handleServiceChoice(waId, idOrTitle) {
  const st = agentFlow.get(waId) || { attachments: [] };
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
  st.step = "attachments_confirm";
  agentFlow.set(waId, st);
  await askIfWantsAttachments(waId);
}
async function handleAttachmentsDecision(waId, decisionId) {
  const st = agentFlow.get(waId);
  if (!st) return;
  if (decisionId === "attach_yes" || decisionId === "نعم") {
    st.wantPhotos = true;
    st.step = "collecting_media";
    agentFlow.set(waId, st);
    await askSendPhotosNow(waId);
  } else {
    st.wantPhotos = false;
    st.step = "forward";
    agentFlow.set(waId, st);
    await forwardToAgentAndAck(waId);
  }
}
async function handleIncomingImage(waId, imageObj) {
  const st = agentFlow.get(waId);
  if (!st || st.step !== "collecting_media") return false;
  const mediaId = imageObj.id; // incoming customer image id
  if (!mediaId) return true;

  st.attachments = st.attachments || [];
  if (st.attachments.length < 3) {
    st.attachments.push({ mediaId });
  }
  agentFlow.set(waId, st);

  if (st.attachments.length >= 3) {
    st.step = "forward";
    agentFlow.set(waId, st);
    await forwardToAgentAndAck(waId);
  } else {
    await sendText(waId, `تم استلام الصورة (${st.attachments.length}/3). يمكنك إرسال المزيد أو اكتب "تم".`);
  }
  return true;
}
async function maybeFinishOnDoneKeyword(waId, textBody) {
  const st = agentFlow.get(waId);
  if (!st || st.step !== "collecting_media") return false;
  if (!textBody) return false;
  if (/^(تم|خلص|انتهيت|done)$/i.test(textBody.trim())) {
    st.step = "forward";
    agentFlow.set(waId, st);
    await forwardToAgentAndAck(waId);
    return true;
  }
  return false;
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
    await forwardTextToAgentOpenWindow({
      name: st.name,
      service: st.service,
      message: st.message,
      fromWaId: waId,
    });
    if (st.attachments && st.attachments.length) {
      const cap = `مرفقات (${st.attachments.length}) لطلب: ${st.name} / ${st.service}`;
      await forwardImagesToAgent(st.attachments, cap);
    }
    await sendText(
      waId,
      "تم إرسال رسالتك إلى فريق خدمة العملاء ✅\nسيتواصلون معك في أقرب وقت ممكن. شكرًا لتواصلك معنا."
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

  if (key === "show_catalog_new") {
    await sendCatalogLink(from, "new");
  } else if (key === "show_catalog_best") {
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

          // Agent mini-flow image capture
          if (msg.type === "image" && msg.image?.id) {
            const handled = await handleIncomingImage(from, msg.image);
            if (handled) continue;
          }

          const textBody = msg.text?.body?.trim();

          // If we're collecting media, accept "تم" to finish
          if (await maybeFinishOnDoneKeyword(from, textBody)) continue;

          // Agent flow steps
          const st = agentFlow.get(from);
          if (st) {
            if (msg.type === "interactive" && msg.interactive?.type === "list_reply" && st.step === "choose_service") {
              const { id, title } = msg.interactive.list_reply || {};
              await handleServiceChoice(from, id || title);
              continue;
            }
            if (msg.type === "interactive" && msg.interactive?.type === "button_reply" && st.step === "attachments_confirm") {
              const { id, title } = msg.interactive.button_reply || {};
              await handleAttachmentsDecision(from, id || title);
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
            // If in collecting_media and user sends random text that isn't "تم", just remind:
            if (st.step === "collecting_media" && textBody) {
              await sendText(from, "أرسل حتى 3 صور الآن، أو اكتب \"تم\" عند الانتهاء.");
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
