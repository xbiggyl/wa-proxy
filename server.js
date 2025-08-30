import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const {
  // App
  PORT = 3333,

  // Meta (main AI/bot number)
  VERIFY_TOKEN,
  META_APP_SECRET,
  META_PERM_TOKEN,
  META_PHONE_NUMBER_ID,

  // Downstream sinks
  CHATWOOT_WEBHOOK_URL,
  CHATWOOT_WEBHOOK_TOKEN,

  // n8n AI endpoints
  OPENAI_ENDPOINT,
  // We won't call summary endpoint here (per your request we inject a placeholder text)
  // OPENAI_SUMMARY_ENDPOINT,

  // Optional Basic Auth to n8n
  N8N_BASIC_USER,
  N8N_BASIC_PASS,

  // Handoff detection
  HANDOFF_KEYWORDS = "human,agent,representative,support,help",

  // 3CX: only used on handoff (we inject summary and forward to this webhook)
  THREE_CX_WEBHOOK_URL,

  // 3CX sender number (used to open the window via template on handoff)
  THREE_CX_META_PHONE_NUMBER_ID,
  THREE_CX_META_PERM_TOKEN,
  HANDOFF_TEMPLATE_NAME = "",
  HANDOFF_TEMPLATE_LANG = "en",

} = process.env;

if (!VERIFY_TOKEN || !META_APP_SECRET || !META_PERM_TOKEN || !META_PHONE_NUMBER_ID || !OPENAI_ENDPOINT) {
  console.error("Missing required environment variables. Please check your .env");
  process.exit(1);
}

const app = express();

// We need the raw body for Meta signature verification and for forwarding/injection
app.use("/wa", bodyParser.raw({ type: "*/*" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// --- Meta Webhook Verification (GET) ---
app.get("/wa", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Sig verification ---
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

// --- In-memory handoff flags (replace with Redis/DB if you scale horizontally) ---
const handoff = new Map(); // waId -> boolean
const handoffRegex = new RegExp(
  HANDOFF_KEYWORDS.split(",").map(s => s.trim()).filter(Boolean).join("|"),
  "i"
);

// --- Helpers ---

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

async function sendWaTextFromMain(waId, body) {
  const url = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to: waId, type: "text", text: { body } };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${META_PERM_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.text();
    console.error("Main number send error:", r.status, r.statusText, err.slice(0,300));
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

// Inject a summary placeholder into the first text message's body and return a NEW raw buffer
function injectSummaryIntoPayload(rawBuffer, placeholderSummary) {
  try {
    const obj = JSON.parse(rawBuffer.toString("utf8"));
    const msgs = obj?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (Array.isArray(msgs)) {
      // Find the first text message
      for (const m of msgs) {
        if (m?.type === "text" && m?.text?.body) {
          m.text.body = `${m.text.body}\n\n---\n[Summary for agents]\n${placeholderSummary}`;
          break;
        }
      }
    }
    return Buffer.from(JSON.stringify(obj));
  } catch (e) {
    console.error("injectSummaryIntoPayload parse error:", e.message);
    // If injection fails, return the original raw unmodified
    return rawBuffer;
  }
}

// Send a template FROM the 3CX number TO the user (to open a window)
async function sendTemplateFrom3cxNumber({ to }) {
  if (!THREE_CX_META_PHONE_NUMBER_ID || !THREE_CX_META_PERM_TOKEN) return false;

  // If a template name is provided, prefer template (works outside 24h)
  if (HANDOFF_TEMPLATE_NAME) {
    const url = `https://graph.facebook.com/v21.0/${THREE_CX_META_PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: HANDOFF_TEMPLATE_NAME,
        language: { code: HANDOFF_TEMPLATE_LANG || "en" }
        // No parameters — we are NOT sending the summary to the user
      }
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${THREE_CX_META_PERM_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const err = await r.text();
      console.error("3CX template send error:", r.status, r.statusText, err.slice(0,300));
      // fall through to free-form
    } else {
      return true;
    }
  }

  // Fallback: free-form text (only valid within 24h window)
  const url = `https://graph.facebook.com/v21.0/${THREE_CX_META_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: "A human will assist you shortly." }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${THREE_CX_META_PERM_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const err = await r.text();
    console.error("3CX text send error:", r.status, r.statusText, err.slice(0,300));
    return false;
  }
  return true;
}

// --- Main webhook ---
app.post("/wa", async (req, res) => {
  const sig = req.headers["x-hub-signature-256"];
  const raw = req.body; // Buffer

  if (!verifySignature(raw, sig)) {
    return res.sendStatus(401);
  }

  // ACK immediately
  res.sendStatus(200);

  // Always forward inbound to Chatwoot (raw & unmodified)
  Promise.allSettled([
    forwardRawJSON(
      CHATWOOT_WEBHOOK_URL,
      raw,
      CHATWOOT_WEBHOOK_TOKEN ? { "X-Chatwoot-Webhook-Token": CHATWOOT_WEBHOOK_TOKEN } : {}
    )
  ]).catch(() => {});

  // Parse for routing/AI/handoff
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    console.error("JSON parse error:", e.message);
    return;
  }

  const messages = payload?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  for (const m of messages) {
    if (m.type !== "text") continue; // extend for media if needed
    const waId = m.from;
    const text = (m.text?.body || "").trim();
    if (!waId || !text) continue;

    // Handoff intent?
    if (handoffRegex.test(text)) {
      handoff.set(waId, true);

      // 1) Inject placeholder summary into payload and forward ONLY this modified payload to 3CX
      if (THREE_CX_WEBHOOK_URL) {
        const injectedRaw = injectSummaryIntoPayload(raw, "this is the summary");
        await forwardRawJSON(THREE_CX_WEBHOOK_URL, injectedRaw, {});
      } else {
        console.warn("THREE_CX_WEBHOOK_URL not set; skipping 3CX forward with injected summary");
      }

      // 2) Open a conversation window by sending a template FROM the 3CX number TO the user
      const ok = await sendTemplateFrom3cxNumber({ to: waId });
      if (!ok) {
        console.warn("Failed to send template/text from 3CX number to user.");
      }

      // 3) Do NOT send any more AI replies from the main number for this waId
      continue;
    }

    // Normal AI path (only if not in handoff)
    if (!handoff.get(waId)) {
      const reply = await getAIReply({ waId, text });
      if (reply) await sendWaTextFromMain(waId, reply);
    }
  }
});

app.listen(Number(PORT), () => {
  console.log(`WA proxy listening on :${PORT}`);
  console.log("Forwarding to Chatwoot:", !!CHATWOOT_WEBHOOK_URL);
  console.log("3CX webhook (on handoff only):", !!THREE_CX_WEBHOOK_URL);
});
