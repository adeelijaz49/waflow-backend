const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const FormData = require("form-data");
const mime = require("mime-types");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_verify_token";

const upload = multer({ storage: multer.memoryStorage() });

// Health check
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// ─── WhatsApp helpers ────────────────────────────────────────────────────────

const WA_PHONE_ID = "1032683093271618";
const WA_TOKEN =
  process.env.WA_TOKEN;

const WA_HEADERS = {
  Authorization: `Bearer ${WA_TOKEN}`,
  "Content-Type": "application/json",
};
const WA_MESSAGES_URL = `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`;

async function waPost(body) {
  const response = await axios.post(WA_MESSAGES_URL, body, { headers: WA_HEADERS });
  return response.data;
}

async function uploadMediaToWhatsApp(file) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  const contentType =
    file.mimetype && !file.mimetype.startsWith("text/")
      ? file.mimetype
      : mime.lookup(file.originalname) || "application/octet-stream";
  form.append("file", file.buffer, { filename: file.originalname, contentType });

  const response = await axios.post(
    `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/media`,
    form,
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, ...form.getHeaders() } }
  );
  return response.data.id;
}

// Send an image with an "Interested?" button underneath
function sendImageWithButton(to, mediaId, bodyText) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "image", image: { id: mediaId } },
      body: { text: bodyText },
      action: {
        buttons: [
          { type: "reply", reply: { id: "interested", title: "Interested?" } }
        ]
      }
    }
  });
}

// "Good choice!" with Continue Shopping / Checkout buttons
function sendGoodChoice(to) {
  return waPost({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Good choice! What would you like to do next?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "continue_shopping", title: "Continue Shopping" } },
          { type: "reply", reply: { id: "checkout",          title: "Checkout"           } }
        ]
      }
    }
  });
}

// ─── Webhook (incoming messages from WhatsApp) ───────────────────────────────

// Meta calls GET /webhook to verify the endpoint
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta calls POST /webhook for every incoming message / button click
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const entry   = req.body?.entry?.[0];
  const change  = entry?.changes?.[0]?.value;
  const message = change?.messages?.[0];

  if (!message) return;

  const from = message.from;
  console.log(`Incoming message from ${from}:`, JSON.stringify(message, null, 2));

  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const buttonId = message.interactive.button_reply.id;
    console.log(`Button tapped: ${buttonId} from ${from}`);

    if (buttonId === "interested") {
      await sendGoodChoice(from).catch(err =>
        console.error("Error sending good choice:", err.response?.data ?? err.message)
      );

    } else if (buttonId === "continue_shopping") {
      await waPost({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: "Happy shopping! Take your time browsing." }
      }).catch(err =>
        console.error("Error sending continue shopping reply:", err.response?.data ?? err.message)
      );

    } else if (buttonId === "checkout") {
      await waPost({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: "Your total is 0.1 AUD. Thank you for shopping with us!" }
      }).catch(err =>
        console.error("Error sending checkout reply:", err.response?.data ?? err.message)
      );
    }
  }
});

// ─── Send template ───────────────────────────────────────────────────────────

app.post("/send-template", async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Both 'to' and 'message' are required" });
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${WA_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: "hello_world", language: { code: "en_US" } }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    return res.json({ success: true, data: response.data });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({ success: false, error: error.response.data });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Send message ────────────────────────────────────────────────────────────

app.post("/send-message", upload.array("images"), async (req, res) => {
  console.log("====================================");
  console.log("POST /send-message called");
  console.log("Body:", req.body);
  console.log("Files:", req.files?.length ?? 0);

  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Both 'to' and 'message' are required" });
  }

  const files = req.files || [];

  if (files.length > 10) {
    return res.status(400).json({ success: false, error: "Maximum 10 images allowed" });
  }

  try {
    let result;

    if (files.length === 0) {
      console.log("Sending text message...");
      result = await waPost({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message }
      });

    } else if (files.length === 1) {
      console.log("Uploading 1 image...");
      const mediaId = await uploadMediaToWhatsApp(files[0]);
      console.log("Media ID:", mediaId);
      result = await sendImageWithButton(to, mediaId, message);

    } else {
      console.log(`Uploading ${files.length} images concurrently...`);
      const mediaIds = await Promise.all(files.map(f => uploadMediaToWhatsApp(f)));
      console.log("Media IDs:", mediaIds);
      result = await Promise.all(mediaIds.map(id => sendImageWithButton(to, id, message)));
    }

    console.log("Response:", JSON.stringify(result, null, 2));
    console.log("====================================");
    return res.json({ success: true, data: result });

  } catch (error) {
    console.log("WhatsApp API error:");
    if (error.response) {
      console.log(JSON.stringify(error.response.data, null, 2));
      return res.status(error.response.status).json({ success: false, error: error.response.data });
    }
    console.log(error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
