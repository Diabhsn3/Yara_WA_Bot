// app.js — Yara WhatsApp: ordered greeting ➜ single menu (no spam)
// - Greeting template (optionally with header image), once/24h
// - Menu (interactive list) sent once after template 'sent' status
// - If user types free text instead of choosing: prompt + menu (cooldown)
// - Location pin + hours
// - Agent handoff via DIRECT FORWARD to AGENT_E164 (no wa.me link)
// - Collect service → name → message; include local phone (0xxxxxxxxx) in forward
// - Catalog deep link

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

// Agent number to receive forwarded requests (E.164 without '+')
const AGENT_E164 = (process.env.AGENT_E164 || "972525555251").trim();

// Optional: a template to force-open the 24h window when forwarding to the agent fails.
// Must be pre-approved and have 3 body params: name, local phone, message summary.
// const FORWARD_TEMPLATE = process.env.FORWARD_TEMPLATE || "forward_to_agent";
// const FORWARD_TEMPLATE_LANG = process.env.FORWARD_TEMPLATE_LANG || "ar";

// Catalog deep link (WhatsApp catalog)
const CATALOG_PHONE_E164 = (process.env.CATALOG_PHONE_E164 || "972557215081").trim();
const CATALOG_LINK = `https://wa.me/c/${CATALOG_PHONE_E164}`;

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

// ====== Agent flow state (service → name → message) ======
/**
 * agentFlow per user:
 * {
 *   step: 'service' | 'name' | 'message',
 *   service?: 'تصليح'|'بيع'|'شراء'|'استفسار',
 *   name?: string
 * }
 */
const agentFlow = new Map(); // wa_id -> state object
function resetAgentFlow(waId) { agentFlow.delete(waId); }

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

// ===== Main menu (with catalog) =====
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
              { id: "show_catalog",      title: "🛍️ عرض الكتالوج",      description: "تصفّح كل المنتجات والصور" },
              { id: "catalog_help",      title: "🧭 مساعدة في الكتالوج", description: "اكتب اسم الصنف لنرشدك" },
              { id: "show_location",     title: "📍 موقعنا (اللوكيشن)",  description: "استلم موقعنا كلوكيشن" },
              { id: "talk_agent",        title: "📞 خدمة العملاء",       description: "تواصل مباشر مع ممثلنا" },
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
    "لفهم طلبك بسرعة، اختر من القائمة أدناه 👇 أو اكتب \"الموقع\" للحصول على اللوكيشن. لعرض المنتجات اكتب \"كتالوج\"."
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

// ===== DIRECT forward to agent =====
function toLocal0(waId) {
  // Convert E.164 "972xxxxxxxxx" to "0xxxxxxxxx"
  if (!waId) return "";
  if (waId.startsWith("972")) return "0" + waId.slice(3);
  return waId;
}

// Try to send a text directly to the agent from your business number.
// If it fails with a 24h-window error (e.g., 470/131045), we currently inform the user.
// (Optional) You can implement a template fallback here if you create FORWARD_TEMPLATE.
async function forwardToAgent({ name, service, message, fromWaId }) {
  const local = toLocal0(fromWaId);
  const composed =
    `طلب جديد من بوت يارا:\n` +
    `الاسم: ${name}\n` +
    `الرقم: ${local}\n` +
    `الخدمة: ${service}\n` +
    `الرسالة: ${message}\n` +
    `معرّف واتساب: ${fromWaId}`;

  try {
    await waPost({
      messaging_product: "whatsapp",
      to: AGENT_E164,
      type: "text",
      text: { body: composed },
    });
    return { ok: true };
  } catch (err) {
    const data = err?.response?.data;
    console.error("❌ forwardToAgent error:", data || err);

    // // OPTIONAL TEMPLATE FALLBACK (uncomment after you create/approve a template)
    // if (FORWARD_TEMPLATE && (data?.error?.code === 470 || data?.error?.code === 131045)) {
    //   try {
    //     await waPost({
    //       messaging_product: "whatsapp",
    //       to: AGENT_E164,
    //       type: "template",
    //       template: {
    //         name: FORWARD_TEMPLATE,
    //         language: { code: FORWARD_TEMPLATE_LANG },
    //         components: [{
    //           type: "body",
    //           parameters: [
    //             { type: "text", text: name },
    //             { type: "text", text: local },
    //             { type: "text", text: `${service}: ${message}` },
    //           ],
    //         }],
    //       },
    //     });
    //     return { ok: true };
    //   } catch (e2) {
    //     console.error("❌ forwardToAgent template fallback error:", e2?.response?.data || e2);
    //   }
    // }

    return { ok: false, reason: data || err };
  }
}

// Send the service submenu (تصليح، بيع، شراء، استفسار)
async function sendServiceMenu(to) {
  agentFlow.set(to, { step: "service" });
  await waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "📞 خدمة العملاء" },
      body:   { text: "اختر الخدمة التي تريد الاستفسار عنها:" },
      footer: { text: "يرجى اختيار خيار واحد" },
      action: {
        button: "اختيار الخدمة",
        sections: [
          {
            title: "الخدمات",
            rows: [
              { id: "svc_repair", title: "تصليح" },
              { id: "svc_sell",   title: "بيع" },
              { id: "svc_buy",    title: "شراء" },
              { id: "svc_info",   title: "استفسار" },
            ],
          },
        ],
      },
    },
  });
}

async function askForName(to, serviceTitle) {
  agentFlow.set(to, { step: "name", service: serviceTitle });
  await sendText(
    to,
    `ممتاز، اخترت خدمة "${serviceTitle}".\nمن فضلك اكتب اسمك الكامل:`
  );
}

async function askForMessage(to) {
  const st = agentFlow.get(to);
  if (!st) return;
  st.step = "message";
  agentFlow.set(to, st);
  await sendText(
    to,
    "شكرًا لك.\nالآن اكتب الرسالة / سؤالك بالتفصيل لكي نرسلها لممثل خدمة العملاء:"
  );
}

async function finishAgentFlow(to, userMessage) {
  const st = agentFlow.get(to);
  if (!st || st.step !== "message" || !st.name || !st.service) {
    resetAgentFlow(to);
    await sendText(to, "حدث خطأ بسيط في جمع البيانات. لنحاول من جديد.");
    await sendServiceMenu(to);
    return;
  }
  st.message = userMessage;

  // Forward directly to agent
  const result = await forwardToAgent({
    name: st.name,
    service: st.service,
    message: st.message,
    fromWaId: to,
  });

  resetAgentFlow(to);

  if (result.ok) {
    await sendText(
      to,
      "تم إرسال رسالتك إلى فريق خدمة العملاء ✅\nسيتواصلون معك في أقرب وقت ممكن. شكرًا لتواصلك معنا."
    );
  } else {
    await sendText(
      to,
      "تعذر إرسال رسالتك إلى فريق الخدمة في الوقت الحالي. يرجى المحاولة مجددًا لاحقًا أو اختيار خدمة أخرى من القائمة."
    );
  }
}

// ===== Choice router =====
async function handleChoice(from, idOrTitle) {
  const key = (idOrTitle || "").trim();

  // Catalog
  if (key === "show_catalog" || key === "🛍️ عرض الكتالوج") {
    await sendText(
      from,
      `تفضّل كتالوج يارا الكامل:\n${CATALOG_LINK}\n\nيمكنك إضافة المنتجات إلى السلة أو إرسال استفسارك لنا هنا.`
    );
    return;
  }
  if (key === "catalog_help" || key === "🧭 مساعدة في الكتالوج") {
    await sendText(
      from,
      "اكتب اسم الصنف الذي تبحث عنه (مثل: خاتم، طقم خطوبة، حلق 21) وسنرسل لك روابط مباشرة من الكتالوج."
    );
    return;
  }

  // Location
  if (key === "الموقع" || key === "show_location") {
    await sendLocation(from);
    return;
  }

  // Agent: start multi-step flow
  if (key === "تواصل مع ممثل خدمة العملاء" || key === "talk_agent" || key === "📞 خدمة العملاء") {
    await sendServiceMenu(from);
    return;
  }

  // Service submenu selections
  if (["svc_repair", "svc_sell", "svc_buy", "svc_info"].includes(key)) {
    const titleMap = {
      svc_repair: "تصليح",
      svc_sell:   "بيع",
      svc_buy:    "شراء",
      svc_info:   "استفسار",
    };
    await askForName(from, titleMap[key]);
    return;
  }

  // Unknown option → polite prompt + menu
  if (canShowMenu(from)) {
    await sendMenuWithPrompt(from);
    markMenuShown(from);
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

          // If the user is in the agent flow wizard, collect inputs
          const st = agentFlow.get(from);
          if (st && textBody) {
            if (st.step === "name") {
              st.name = textBody;
              agentFlow.set(from, st);
              await askForMessage(from);
              continue;
            }
            if (st.step === "message") {
              await finishAgentFlow(from, textBody);
              continue;
            }
          }

          // Location keywords immediately
          if (textBody && /^(الموقع|لوكيشن|المكان|location|map)$/i.test(textBody)) {
            await sendLocation(from);
            continue;
          }

          // Catalog keyword shortcut
          if (textBody && /(كتالوج|catalog)/i.test(textBody)) {
            await sendText(from, `هذا هو كتالوج يارا:\n${CATALOG_LINK}`);
            continue;
          }

          // Interactive replies (main menu or service submenu)
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
