import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const {
  PORT = 3000,
  VERIFY_TOKEN,
  META_APP_SECRET,
  META_PERM_TOKEN,
  META_PHONE_NUMBER_ID,
  THREE_CX_WEBHOOK_URL,
  CHATWOOT_WEBHOOK_URL,
  CHATWOOT_WEBHOOK_TOKEN,
  OPENAI_ENDPOINT,
  OPENAI_SUMMARY_ENDPOINT,
  N8N_BASIC_USER,
  N8N_BASIC_PASS,
  HANDOFF_KEYWORDS = "human,agent,representative,support,help",
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

// Basic in-memory handoff flags (replace with Redis/DB in prod HA)
const handoff = new Map(); // waId -> boolean

const handoffRegex = new RegExp(
  HANDOFF_KEYWORDS.split(",").map(s => s.trim()).filter(Boolean).join("|"),
  "i"
);

// Helpers
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

async function getAISummary(waId) {
  if (!OPENAI_SUMMARY_ENDPOINT) return "Summary not available.";
  try {
    const r = await fetch(OPENAI_SUMMARY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...maybeAuthHeader() },
      body: JSON.stringify({ waId })
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error("AI summary error:", r.status, r.statusText, txt.slice(0,300));
      return "Summary not available.";
    }
    const data = JSON.parse(txt);
    return data.summary || "Summary not available.";
  } catch (e) {
    console.error("AI summary exception:", e.message);
    return "Summary not available.";
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

  // Fan-out raw payload to 3CX + Chatwoot (non-blocking)
  Promise.allSettled([
    forwardRawJSON(THREE_CX_WEBHOOK_URL, raw, {}),
    forwardRawJSON(
      CHATWOOT_WEBHOOK_URL,
      raw,
      CHATWOOT_WEBHOOK_TOKEN ? { "X-Chatwoot-Webhook-Token": CHATWOOT_WEBHOOK_TOKEN } : {}
    ),
  ]).catch(() => {});

  // Parse after forwarding
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
      await sendWaText(waId, "Okay — connecting you with a human.");
      const summary = await getAISummary(waId);
      await sendWaText(waId, `Summary so far:\n${summary}`);
      continue;
    }

    // AI control path
    if (!handoff.get(waId)) {
      const reply = await getAIReply({ waId, text });
      if (reply) await sendWaText(waId, reply);
    }
  }
});

app.listen(Number(PORT), () => {
  console.log(`WA proxy listening on :${PORT}`);
  console.log("Forwarding enabled:", {
    to3cx: !!THREE_CX_WEBHOOK_URL,
    toChatwoot: !!CHATWOOT_WEBHOOK_URL
  });
});
