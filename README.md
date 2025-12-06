# Yara WhatsApp Business Bot

Production WhatsApp Business Cloud API webhook for **Yara Jewelry (Mini Kinyon Yara)**.  
The bot sends an ordered greeting template, then a single interactive menu to keep the conversation clean and non-spammy.

## Features

- ✅ Greeting template → single interactive menu (no repeated spam)
- 📂 Catalog link to the WhatsApp business catalog
- 📍 Location pin + opening hours for the Tamra store
- 💰 “Gold price today” option, driven by an environment variable
- 👨‍💼 “Customer service” mini-flow:
  - Choose service type (repair / sell / buy / inquiry)
  - Collect customer full name
  - Collect detailed message
  - Forward everything to a human agent via pre-approved template
- 🔒 Safety / reliability:
  - De-duplicates webhook retries
  - Per-user throttling for menus
  - Welcome message limited to once per 24h
  - Shortened deep links for agent reply

## Tech Stack

- Node.js (>= 18)
- Express.js
- Axios
- WhatsApp Business Cloud API (Graph API v23.0)

## Environment Variables

The bot is configured fully via env vars:

```env
PORT=3000
VERIFY_TOKEN=your_webhook_verify_token
WHATS_TOKEN=your_whatsapp_cloud_api_token
PHONE_NUMBER_ID=your_phone_number_id

TEMPLATE_NAME=greetings_2
TEMPLATE_LANG=ar
TEMPLATE_HEADER_IMAGE_URL=
TEMPLATE_HEADER_MEDIA_ID=

AGENT_E164=9725XXXXXXXX     # agent phone in E.164
AGENT_TEMPLATE_NAME=agent_notify
AGENT_TEMPLATE_LANG=ar

AGENT_LINK_TEMPLATE_NAME=agent_link_optional
AGENT_LINK_TEMPLATE_LANG=ar

BUSINESS_CATALOG_NUMBER=97255XXXXXXX
GOLD_PRICE=XXX              # e.g. "230"
MENU_COOLDOWN_MS=15000
