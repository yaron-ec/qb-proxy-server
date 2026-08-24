# QuickBooks Proxy Server

A lightweight Express proxy that sits between Base44 and QuickBooks API.
All QB API calls route through this server so only **one static IP** needs to be whitelisted with Intuit Production.

---

## Architecture

```
Base44 CRM (dynamic IP)
        │
        │  POST /api/qb/*  +  X-Proxy-Secret header
        ▼
QB Proxy Server  ◄── STATIC IP (whitelisted with Intuit)
        │
        │  OAuth Bearer token
        ▼
QuickBooks API (Production or Sandbox)
```

---

## Deployment Options

### Option A: VPS (DigitalOcean, Linode, Hetzner — cheapest, ~$5/mo)
```bash
git clone <this-repo>
cd qb-proxy-server
npm install
# Set env vars (see below), then:
node server.js
# Use nginx + certbot for HTTPS
```

### Option B: Google Cloud Run (serverless, static egress IP via Cloud NAT)
1. Build and push Docker image to Google Container Registry
2. Deploy to Cloud Run
3. Create a Cloud NAT gateway with a reserved static IP
4. Route Cloud Run egress through that NAT

```bash
docker build -t gcr.io/YOUR_PROJECT/qb-proxy .
docker push gcr.io/YOUR_PROJECT/qb-proxy
gcloud run deploy qb-proxy --image gcr.io/YOUR_PROJECT/qb-proxy --platform managed
```

### Option C: AWS Lambda + API Gateway + Elastic IP (via NAT Gateway)
1. Package as Lambda function using `serverless-http`
2. Deploy Lambda inside a VPC
3. Attach a NAT Gateway with an Elastic IP to the VPC
4. All Lambda outbound traffic goes through the Elastic IP

---

## Environment Variables

Set these on your server/cloud environment. **Never put these in Base44.**

### QuickBooks

| Variable | Description |
|---|---|
| `QB_CLIENT_ID` | Intuit Developer app Client ID (use Production keys) |
| `QB_CLIENT_SECRET` | Intuit Developer app Client Secret (Production) |
| `QB_REDIRECT_URI` | OAuth redirect URI — must match Intuit app config |
| `QB_ENVIRONMENT` | `"production"` or `"sandbox"` |
| `PROXY_SECRET` | A strong random secret string (e.g. `openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | Strong secret for encrypting stored tokens |
| `PORT` | (optional) defaults to 3000 |

### File Uploads — Cloudflare R2 (recommended, zero-egress-fee)

| Variable | Required | Description |
|---|---|---|
| `R2_ACCOUNT_ID` | ✅ | Cloudflare Account ID (find in Cloudflare dashboard → R2) |
| `R2_ACCESS_KEY_ID` | ✅ | R2 API Token → Access Key ID |
| `R2_SECRET_ACCESS_KEY` | ✅ | R2 API Token → Secret Access Key |
| `R2_BUCKET_NAME` | ✅ | Name of your R2 bucket (e.g. `crm-files`) |
| `R2_PUBLIC_URL` | ✅ | Public base URL for the bucket (e.g. `https://files.ecconstructiongroup.com` or `https://pub-xxxx.r2.dev`) |

#### How to get R2 credentials:
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **R2 Object Storage**
2. Create a bucket named `crm-files` (or whatever you like) and enable **Public Access**
3. Go to **R2 → Manage API Tokens** → Create token with **Object Read & Write** on that bucket
4. Copy `Account ID`, `Access Key ID`, and `Secret Access Key`
5. The `R2_PUBLIC_URL` is the **Public Bucket URL** shown on the bucket's settings page

### File Uploads — AWS S3 (alternative)

| Variable | Required | Description |
|---|---|---|
| `S3_REGION` | ✅ | AWS region (e.g. `us-east-1`) |
| `S3_ACCESS_KEY_ID` | ✅ | AWS IAM Access Key ID |
| `S3_SECRET_ACCESS_KEY` | ✅ | AWS IAM Secret Access Key |
| `S3_BUCKET_NAME` | ✅ | S3 bucket name |
| `S3_PUBLIC_URL` | optional | Public base URL (defaults to `https://<bucket>.s3.<region>.amazonaws.com`) |

---

## Base44 Configuration

In Base44, set these two secrets in **Dashboard → Settings → Secrets**:

| Secret | Value |
|---|---|
| `QB_PROXY_URL` | Your proxy's base URL, e.g. `https://qb-proxy.yourdomain.com` |
| `QB_PROXY_SECRET` | Same value as `PROXY_SECRET` on the server |

Remove from Base44 (no longer needed after proxy is live):
- `QB_CLIENT_ID`
- `QB_CLIENT_SECRET`
- `QB_SANDBOX`

---

## API Endpoints

All endpoints require the header: `X-Proxy-Secret: <PROXY_SECRET>`

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (no auth required) |
| GET | `/auth/connect` | Get Intuit OAuth URL |
| POST | `/auth/callback` | Exchange OAuth code for tokens |
| GET | `/auth/status` | Connection status |
| POST | `/auth/disconnect` | Clear stored tokens |
| GET | `/company` | Get QuickBooks company info |
| GET | `/customers` | List all customers (optional: `?since=ISO_DATE`) |
| GET | `/customers/search` | Search by `?displayName=X` or `?email=Y` |
| POST | `/customers` | Create/update customer |
| GET | `/estimates` | List estimates (`?since=` or `?customerId=`) |
| POST | `/estimates` | Create estimate |
| GET | `/estimates/:id/pdf` | Download estimate PDF |
| GET | `/invoices` | List invoices (`?since=` or `?customerId=`) |
| POST | `/invoices` | Create invoice |
| GET | `/invoices/:id/pdf` | Download invoice PDF |
| **POST** | **`/api/files/upload`** | **Upload file to R2/S3 — returns `{ success, url, key, fileName, contentType, size }`** |
| GET | `/api/files/status` | Check if file storage is configured |

---

## Token Storage Note

By default tokens are stored in memory (lost on restart). For production, replace the `storedTokens` variable in `server.js` with persistent storage:

```js
// Option 1: Write to a local JSON file
const fs = require('fs');
const TOKEN_FILE = '/data/qb-tokens.json';

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveTokens(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t));
}
// Replace storedTokens reads/writes with loadTokens()/saveTokens()

// Option 2: Redis
// const redis = require('redis');
// const client = redis.createClient({ url: process.env.REDIS_URL });
```

---

## Security Checklist

- [ ] Use HTTPS (nginx + Let's Encrypt / Cloud Run default TLS)
- [ ] Set a strong random `PROXY_SECRET` (32+ chars)
- [ ] Firewall: only allow inbound on port 443 from Base44 (or 0.0.0.0 if dynamic)
- [ ] Whitelist only the proxy static IP with Intuit Production
- [ ] Store OAuth tokens persistently (file or Redis) — not in memory