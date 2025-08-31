// Add this at the top of your file
const axios = require('axios');

const WHATS_TOKEN = process.env.WHATS_TOKEN; // your permanent access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // from API Setup

// Function to send template
async function sendTemplate(to) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "template",
    template: {
      name: "yara_greeting",   // <-- your template name
      language: { code: "ar" } // Arabic
    }
  };

  await axios.post(url, data, {
    headers: { Authorization: `Bearer ${WHATS_TOKEN}` }
  });
}

// Inside your POST route:
app.post('/', async (req, res) => {
  const body = req.body;

  if (body.object) {
    body.entry.forEach(entry => {
      entry.changes.forEach(change => {
        if (change.value.messages) {
          const message = change.value.messages[0];
          const from = message.from; // customer number

          console.log("New customer:", from);

          // Auto-send your greeting template
          sendTemplate(from).catch(err => console.error(err));
        }
      });
    });
  }

  res.sendStatus(200);
});

// Import Express.js
const express = require('express');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Set port and verify_token
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// Route for GET requests
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Route for POST requests
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
