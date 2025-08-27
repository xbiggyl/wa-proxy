import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import bodyParser from "body-parser";

// These are the environment variables the app uses.
// See .env.example for more details.
const {
  PORT = 3000,
  VERIFY_TOKEN,
  META_APP_SECRET,
  META_PERM_TOKEN,
  META_PHONE_NUMBER_ID,
  CHATWOOT_WEBHOOK_URL,
  CHATWOOT_WEBHOOK_TOKEN,
  OPENAI_ENDPOINT,
  N8N_BASIC_USER,
  N8N_BASIC_PASS,
} = process.env;

if (!VERIFY_TOKEN || !META_APP_SECRET || !META_PERM_TOKEN || !META_PHONE_NUMBER_ID || !OPENAI_ENDPOINT) {
  console.error("Missing required environment variables. Please check .env / deployment configuration.");
  process.exit(1);
}

const app = express();

// Raw body needed for X-Hub-Signature-256 verification
app.use("/wa", bodyParser.raw({ type: "*/*" }));

// Simple readiness/liveness
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Meta webhook verification (GET)
app.get("/wa", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function verifySignature(rawBody, headerSig) {
  if (!headerSig || !META_APP_SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(headerSig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Helpers

/**
 * If N8N_BASIC_USER and N8N_BASIC_PASS are set, returns an object with an
 * Authorization header for Basic Auth. Otherwise, returns an empty object.
 * @returns {object}
 */
function maybeAuthHeader() {
  if (N8N_BASIC_USER && N8N_BASIC_PASS) {
    const token = Buffer.from(`${N8N_BASIC_USER}:${N8N_BASIC_PASS}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }
  return {};
}

async function forwardRawJSON(url, rawBody, extraHeaders = {}) {
  if (!url) return { skipped: true };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: rawBody
    });
    if (!r.ok) {
      const t = await r.text();
      console.error(`Forward error ${url}:`, r.status, r.statusText, t.slice(0,300));
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error(`Forward exception ${url}:`, e.message);
    return { ok: false, error: e.message };
  }
}

async function sendWaText(waId, body) {
  const url = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to: waId, type: "text", text: { body } };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${META_PERM_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.text();
    console.error("WA send error:", r.status, r.statusText, err.slice(0,300));
  }
}

async function getAIReply({ waId, text }) {
  try {
    const r = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...maybeAuthHeader() },
      body: JSON.stringify({ waId, text })
    });
    const bodyText = await r.text();
    if (!r.ok) {
      console.error("AI endpoint error:", `status=${r.status}`, `statusText=${r.statusText}`, `body=${bodyText.slice(0,300)}`);
      return null;
    }
    const data = JSON.parse(bodyText);
    return data.reply || null;
  } catch (e) {
    console.error("AI endpoint exception:", e.message);
    return null;
  }
}


// Main webhook
app.post("/wa", async (req, res) => {
  const sig = req.headers["x-hub-signature-256"];
  const raw = req.body; // Buffer

  if (!verifySignature(raw, sig)) {
    return res.sendStatus(401);
  }

  // ACK immediately
  res.sendStatus(200);

  // Forward the raw payload to Chatwoot if a webhook URL is configured.
  // This is done in a non-blocking way.
  if (CHATWOOT_WEBHOOK_URL) {
    const headers = CHATWOOT_WEBHOOK_TOKEN
      ? { "X-Chatwoot-Webhook-Token": CHATWOOT_WEBHOOK_TOKEN }
      : {};
    forwardRawJSON(CHATWOOT_WEBHOOK_URL, raw, headers).catch(() => {});
  }

  // The N8N workflow is now responsible for all business logic, including
  // handoff to 3CX. The proxy's job is just to route messages.

  // Parse the webhook payload from Meta.
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    console.error("JSON parse error:", e.message);
    return; // Stop processing if payload is invalid
  }

  // Extract messages from the payload.
  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || [];

  // Process each message.
  for (const m of messages) {
    // We only handle text messages for now.
    if (m.type !== "text") continue;

    const waId = m.from;
    const text = (m.text?.body || "").trim();
    if (!waId || !text) continue;

    // Get a reply from the N8N workflow.
    const reply = await getAIReply({ waId, text });

    // If the workflow returns a reply, send it back to the user.
    if (reply) {
      await sendWaText(waId, reply);
    }
  }
});

app.listen(Number(PORT), () => {
  console.log(`WA proxy listening on :${PORT}`);
  console.log("Forwarding to Chatwoot enabled:", !!CHATWOOT_WEBHOOK_URL);
});
