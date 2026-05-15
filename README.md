# Jan Awaaz — जन आवाज़
### AI-Powered Public Grievance & Petition Portal

Generates formal petition letters in Indian regional languages + Hindi,
so citizens can submit complaints to government departments in the language
those departments actually work in.

---

## Project Structure

```
jan-awaaz/
├── server.js          ← Express backend (API key lives here — safe)
├── package.json
├── .env.example       ← Copy to .env and add your API key
├── .gitignore
└── public/
    └── index.html     ← Frontend (calls /api/generate-petition, not Anthropic directly)
```

---

## Setup & Run

### 1. Install dependencies
```bash
npm install
```

### 2. Add your API key
```bash
cp .env.example .env
# Edit .env and paste your Anthropic API key
```
Get your key at: https://console.anthropic.com/

### 3. Start the server
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 4. Open in browser
```
http://localhost:3000
```

---

## API Endpoint

### POST /api/generate-petition

**Request** (multipart/form-data):
| Field         | Required | Description                          |
|---------------|----------|--------------------------------------|
| state         | ✅       | Indian state/UT name                 |
| department    | ✅       | Government department to address     |
| complaint     | ✅       | Complaint details                    |
| petitioner    | ❌       | Petitioner name & address            |
| languages[]   | ❌       | Languages (Hindi always included)    |
| attachment    | ❌       | Supporting file (PDF/JPG, max 5MB)   |

**Response** (JSON):
```json
{
  "letters": [
    { "language": "Tamil",  "letter": "தமிழ் மொழியில்..." },
    { "language": "Hindi",  "letter": "हिंदी में पत्र..." }
  ]
}
```

---

## Security

- ✅ API key stored only in `.env` on your server
- ✅ Browser never sees the key
- ✅ `.env` excluded from git via `.gitignore`
- ✅ File upload size limited to 5MB

## Deployment (Render / Railway / VPS)

Set the environment variable `ANTHROPIC_API_KEY` in your hosting dashboard.
No `.env` file needed in production — the platform injects it.

---

*सत्यमेव जयते — Truth Alone Triumphs*
