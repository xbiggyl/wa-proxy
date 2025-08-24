# Instructions for LLMs & Engineers

This repo implements a WhatsApp **AI-first** gateway (proxy) that sits in front of 3CX and Chatwoot:

- **Inbound:** Meta WhatsApp Cloud API → `/wa` (this proxy).  
- **Fan-out:** The proxy **forwards the raw webhook** to **3CX** and **Chatwoot** (for visibility & agent takeover).  
- **AI-first:** If the conversation is **not** in human-handoff mode, the proxy calls your **n8n AI endpoint** to generate a reply and **sends it to WhatsApp** via the Graph API.  
- **Handoff:** If the user requests a human (keyword intent), the proxy **stops replying** and sends a final “connecting you to a human” + (optional) **summary**. From then on, agents continue the chat in **3CX** (and optionally Chatwoot).

## Core Behaviors

1. **Webhook Verification (GET /wa)**  
   - Responds to the Meta **verification challenge** using `VERIFY_TOKEN` and `hub.challenge` echo.

2. **Signature Verification (POST /wa)**  
   - Validates `X-Hub-Signature-256` via HMAC-SHA256 raw-body using `META_APP_SECRET`.  
   - Returns **200 immediately** to Meta (fast ACK).

3. **Forwarding (non-blocking, parallel)**  
   - Forwards the **exact raw JSON** body to `THREE_CX_WEBHOOK_URL`.  
   - Forwards the **exact raw JSON** body to `CHATWOOT_WEBHOOK_URL` with header `X-Chatwoot-Webhook-Token: CHATWOOT_WEBHOOK_TOKEN` if set.  
   - Errors are logged but **never block** the Meta ACK.

4. **AI Reply (if not in human handoff)**  
   - Calls `OPENAI_ENDPOINT` (your **n8n** webhook) with JSON: `{ "waId": string, "text": string }`.  
   - Optional **Basic Auth** to n8n is supported via `N8N_BASIC_USER`/`N8N_BASIC_PASS`.  
   - Expects JSON `{ "reply": string }`.  
   - Sends the reply to WhatsApp via Graph API `/{META_PHONE_NUMBER_ID}/messages` using `META_PERM_TOKEN`.

5. **Human Handoff**  
   - If inbound text matches `HANDOFF_KEYWORDS` (regex OR on comma-separated words), set per-user flag and:  
     - Send “connecting you with a human” message.  
     - Call optional `OPENAI_SUMMARY_ENDPOINT` (same auth pattern) with `{ "waId": string }`, expects `{ "summary": string }`, then send summary text to user.  
     - **Stop AI replies** for that `waId` going forward.

6. **Health**  
   - `GET /healthz` → `200 ok` if process is alive.

> **Note:** Only **user messages** are mirrored into 3CX/Chatwoot by forwarding Meta’s webhook. Bot-authored messages sent via Graph API will **not** show up in 3CX. Use the one-shot summary during handoff to give agents context.

---

## Environment Variables

| Name | Required | Description |
|---|---|---|
| `PORT` | no (default `3000`) | Internal port the app listens on (Docker maps it). |
| `VERIFY_TOKEN` | yes | Token for Meta webhook verification (GET /wa). |
| `META_APP_SECRET` | yes | App secret used to verify `X-Hub-Signature-256`. |
| `META_PERM_TOKEN` | yes | **Permanent** system-user token with `whatsapp_business_messaging` scope. |
| `META_PHONE_NUMBER_ID` | yes | Phone Number ID used for `/{PNID}/messages`. |
| `THREE_CX_WEBHOOK_URL` | no | 3CX WhatsApp webhook URL to forward **raw** webhook payloads. |
| `CHATWOOT_WEBHOOK_URL` | no | Chatwoot webhook URL to forward **raw** webhook payloads. |
| `CHATWOOT_WEBHOOK_TOKEN` | no | Sent as header `X-Chatwoot-Webhook-Token` to Chatwoot. |
| `OPENAI_ENDPOINT` | yes | n8n endpoint for generating replies; accepts `{waId,text}`; returns `{reply}`. |
| `OPENAI_SUMMARY_ENDPOINT` | no | n8n endpoint for summaries; accepts `{waId}`; returns `{summary}`. |
| `N8N_BASIC_USER` | no | If set with `N8N_BASIC_PASS`, the proxy will send **Basic Auth** to n8n. |
| `N8N_BASIC_PASS` | no | See above. |
| `HANDOFF_KEYWORDS` | no (default `human,agent,representative,support,help`) | Comma-separated keywords; OR’d into a case-insensitive regex. |

Use `.env` during local/dev, but **do not commit secrets**. Provide `.env.example` in the repo.

---

## HTTP Contracts

### 1) Meta → Proxy

- **GET `/wa`** (Verification):  
  - Query: `hub.mode=subscribe`, `hub.verify_token=VERIFY_TOKEN`, `hub.challenge=<string>`  
  - Response: `200` body=`hub.challenge` when token matches.  
- **POST `/wa`** (Webhook):  
  - Headers: `X-Hub-Signature-256: sha256=<hmac>`  
  - Body: Raw JSON payload from Meta.  
  - Response: `200 OK` immediately.

### 2) Proxy → 3CX / Chatwoot (Forwarding)

- **POST** with headers: `Content-Type: application/json` (+ `X-Chatwoot-Webhook-Token` if configured).  
- **Body:** The exact **raw** JSON body received from Meta (no mutation).

### 3) Proxy → n8n (AI reply)

- **POST** `OPENAI_ENDPOINT`  
- Headers: `Content-Type: application/json` (+ `Authorization: Basic base64(user:pass)` if configured)  
- Body: `{ "waId": "E164", "text": "..." }`  
- Response: `{ "reply": "..." }`

### 4) Proxy → n8n (Summary) *(optional)*

- **POST** `OPENAI_SUMMARY_ENDPOINT`  
- Body: `{ "waId": "E164" }`  
- Response: `{ "summary": "..." }`

---

## Deployment Topology (nginx in front)

You likely already run **nginx** on the host (port 80/443). The container binds to **localhost only**, and nginx proxies to it.

- **docker-compose.yml** exposes `127.0.0.1:3333 -> 3333`.  
- **nginx** terminates TLS on `https://wa.yourdomain.com`, then:  
  `proxy_pass http://127.0.0.1:3333;`

Sample nginx server block (TLS handled by certbot/your method):

```nginx
server {
    listen 80;
    server_name wa.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
    }
}
```

Then issue certs:
```
sudo certbot --nginx -d wa.yourdomain.com --redirect -m you@example.com --agree-tos -n
```

---

## Local Build & Run

```bash
docker compose up -d --build
docker compose logs -f wa-app
```

Health check:
```bash
curl -I http://127.0.0.1:3333/healthz
```

Public (through nginx):
```bash
curl -I https://wa.yourdomain.com/healthz
```

---

## Testing the n8n contract independently

```bash
curl -i 'https://n8n.yourdomain.com/webhook/ai/reply'   -H 'Content-Type: application/json'   -u 'N8N_BASIC_USER:N8N_BASIC_PASS'   -d '{"waId":"15551234567","text":"ping"}'
# Expect: {"reply":"..."}
```

---

## Repository Layout

```
.
├─ server.js            # Proxy logic
├─ package.json
├─ Dockerfile
├─ docker-compose.yml
├─ .env.example         # Template for required env vars (no secrets)
├─ deploy/
│  └─ nginx.sample.conf # Example nginx vhost
├─ README.md
└─ instructions.md      # Full spec for LLMs/Engineers
```

---

## Notes for LLMs

- Prioritize **fast ACK** to Meta; never block on AI/forwards.  
- All forwarding is **best-effort** and must not impact the primary webhook flow.  
- The proxy logs partial error bodies (first 300 chars) for observability.  
- Replace the in-memory `handoff` map with Redis/Postgres for multi-instance deployments.  
- Extend media handling as needed (`m.type !== "text"`).  
- Ensure **outbound** WhatsApp sends use correct PNID and Permanent Token.
