# 📸 Media Server — Raspberry Pi

A lightweight Express server that exposes your local `Media` folder over HTTP,
protected by JWT authentication and brute-force rate limiting.

---

## Folder Structure

```
media-server/
├── server.js           ← main server
├── generate-secret.js  ← one-time secret generator
├── package.json
├── .env.example
├── .env                ← create this (never commit it)
└── Media/              ← your photos & videos (or set MEDIA_DIR)
    ├── abc123.jpg
    ├── def456.mp4
    └── ...
```

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Generate your secrets (do this once)
node generate-secret.js

# 3. Create your .env from the example and paste the generated values
cp .env.example .env
nano .env

# 4. Start the server
npm start
```

---

## Authentication Flow

All `/media` routes are protected. Here's how to use the API:

### Step 1 — Get a token

```bash
curl -X POST https://your-tunnel-url/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password": "your-api-password"}'
```

Response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "24h"
}
```

### Step 2 — Use the token on every request

```bash
curl https://your-tunnel-url/media \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## API Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET`  | `/health` | ❌ public | Health check |
| `POST` | `/auth/login` | ❌ public | Get a JWT token |
| `GET`  | `/media` | ✅ required | List all media files |
| `GET`  | `/media?type=photo` | ✅ required | Filter photos only |
| `GET`  | `/media?type=video` | ✅ required | Filter videos only |
| `GET`  | `/media?page=1&limit=50` | ✅ required | Paginated results |
| `GET`  | `/media/:id` | ✅ required | Single file metadata |
| `GET`  | `/media/file/:filename` | ✅ required | Stream a file |

### `GET /media` response example

```json
{
  "total": 120,
  "page": 1,
  "totalPages": 3,
  "limit": 50,
  "data": [
    {
      "id": "abc123",
      "filename": "abc123.jpg",
      "type": "photo",
      "size": 2048576,
      "url": "/media/file/abc123.jpg"
    },
    {
      "id": "def456",
      "filename": "def456.mp4",
      "type": "video",
      "size": 104857600,
      "url": "/media/file/def456.mp4"
    }
  ]
}
```

---

## Security Features

- **JWT tokens** — all media routes require a valid signed token
- **Token expiry** — tokens expire after `TOKEN_EXPIRY` (default 24h)
- **Rate limiting** — login endpoint is limited to 10 attempts per 15 minutes
- **Path traversal protection** — users can't escape the Media directory
- **CORS** — only your frontend origin can make requests

---

## Using in your React frontend

```js
// 1. Login and store the token
const { token } = await fetch(`${PI_URL}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: import.meta.env.VITE_MEDIA_PASSWORD }),
}).then(r => r.json());

// 2. Fetch media list
const { data } = await fetch(`${PI_URL}/media`, {
  headers: { Authorization: `Bearer ${token}` },
}).then(r => r.json());

// 3. Display a photo
<img src={`${PI_URL}/media/file/${item.filename}`}
     // Note: for <img> and <video> tags you need a token workaround
     // since browsers don't send auth headers for src attributes.
     // Best approach: proxy through your Vercel API, or use a pre-signed URL pattern.
/>
```

> **Tip for `<img>` / `<video>` tags:** browsers don't send `Authorization` headers for
> `src` attributes. The cleanest workaround is to fetch the file as a blob in JS and
> create an object URL: `URL.createObjectURL(blob)`.

---

## Run as a systemd service (auto-start on boot)

```bash
sudo nano /etc/systemd/system/media-server.service
```

```ini
[Unit]
Description=Media Server
After=network.target

[Service]
ExecStart=/usr/bin/node /home/pi/media-server/server.js
WorkingDirectory=/home/pi/media-server
Restart=always
User=pi
EnvironmentFile=/home/pi/media-server/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable media-server
sudo systemctl start media-server
sudo systemctl status media-server
```

---

## Supported File Types

**Photos:** `.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp` `.tiff` `.svg` `.heic` `.avif`

**Videos:** `.mp4` `.mkv` `.mov` `.avi` `.webm` `.flv` `.wmv` `.m4v` `.3gp` `.ts`
