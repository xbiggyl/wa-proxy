# Instructions for Developers

This repo implements a WhatsApp gateway (proxy) that sits in front of your N8N workflow and optionally Chatwoot.

- **Inbound:** Meta WhatsApp Cloud API → `/wa` (this proxy).
- **Forwarding (optional):** The proxy can forward the raw webhook to **Chatwoot** for conversation logging.
- **N8N Workflow:** The proxy calls your **N8N endpoint** for every incoming text message to get a reply, which it then sends back to the user via the Graph API. Your N8N workflow is responsible for all business logic (e.g., AI replies, handoff to human agents, etc.).

## Core Behaviors

1.  **Webhook Verification (GET /wa)**
    -   Responds to the Meta **verification challenge** using `VERIFY_TOKEN`.

2.  **Signature Verification (POST /wa)**
    -   Validates the `X-Hub-Signature-256` HMAC-SHA256 signature of the raw request body using `META_APP_SECRET`.
    -   Returns **200 OK immediately** to Meta to acknowledge receipt.

3.  **Chatwoot Forwarding (optional, non-blocking)**
    -   If `CHATWOOT_WEBHOOK_URL` is set, forwards the **exact raw JSON** body to Chatwoot.
    -   If `CHATWOOT_WEBHOOK_TOKEN` is set, it's sent as the `X-Chatwoot-Webhook-Token` header.
    -   Errors are logged but **do not block** the primary message flow.

4.  **N8N Reply Generation**
    -   Calls your `OPENAI_ENDPOINT` (your **N8N** webhook) with a JSON payload: `{ "waId": string, "text": string }`.
    -   Supports **Basic Auth** to N8N via `N8N_BASIC_USER` and `N8N_BASIC_PASS`.
    -   Expects a JSON response from N8N: `{ "reply": string }`.
    -   Sends the reply to the user via the Graph API using your `META_PERM_TOKEN`.

5.  **Health Check**
    -   `GET /healthz` → responds with `200 ok` if the server is running.

---

## Environment Variables

| Name | Required | Description |
|---|---|---|
| `PORT` | no (default `3000`) | Internal port for the Docker container. |
| `VERIFY_TOKEN` | yes | Your secret token for Meta webhook verification. |
| `META_APP_SECRET` | yes | Your Meta app secret for signature verification. |
| `META_PERM_TOKEN` | yes | A **permanent** system-user token with `whatsapp_business_messaging` scope. |
| `META_PHONE_NUMBER_ID` | yes | The Phone Number ID for sending messages from your number. |
| `CHATWOOT_WEBHOOK_URL` | no | If set, forwards raw Meta webhooks to this Chatwoot URL. |
| `CHATWOOT_WEBHOOK_TOKEN`| no | Sent as the `X-Chatwoot-Webhook-Token` header to Chatwoot. |
| `OPENAI_ENDPOINT` | yes | Your N8N webhook URL for generating replies. |
| `N8N_BASIC_USER` | no | If set with `N8N_BASIC_PASS`, enables Basic Auth for N8N. |
| `N8N_BASIC_PASS` | no | The password for N8N Basic Auth. |

Use `.env` for local development (a `.env.example` is provided), but **do not commit secrets**.

---

## HTTP Contracts

### 1) Meta → Proxy

-   **GET `/wa`** (Verification):
    -   Query: `hub.mode=subscribe`, `hub.verify_token=VERIFY_TOKEN`, `hub.challenge=<string>`
    -   Response: `200` with the `hub.challenge` value if the token matches.
-   **POST `/wa`** (Webhook):
    -   Headers: `X-Hub-Signature-256: sha256=<hmac>`
    -   Body: Raw JSON payload from Meta.
    -   Response: `200 OK` immediately.

### 2) Proxy → Chatwoot (Forwarding)

-   **POST** with headers: `Content-Type: application/json` (+ `X-Chatwoot-Webhook-Token` if configured).
-   **Body:** The exact **raw** JSON body received from Meta.

### 3) Proxy → N8N (Reply Generation)

-   **POST** `OPENAI_ENDPOINT`
-   Headers: `Content-Type: application/json` (+ `Authorization: Basic base64(user:pass)` if configured)
-   Body: `{ "waId": "E164_number", "text": "The user's message" }`
-   Response: `{ "reply": "The response to send to the user" }`

---

## Deployment

The deployment topology remains the same, with an nginx reverse proxy in front of the Node.js container. Refer to `deploy/nginx.sample.conf` for an example configuration.

## Local Development

```bash
# Build and run the container in the background
docker compose up -d --build

# View logs
docker compose logs -f wa-app
```
Check the health of the service:
```bash
curl -I http://127.0.0.1:3000/healthz
```
