const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cors = require('cors');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();

// Load env
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || './data/messages.sqlite';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Ensure data dir exists
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// DB
const db = new sqlite3.Database(DATABASE_URL);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT CHECK(direction IN ('in','out')) NOT NULL,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    body TEXT,
    status TEXT,
    telnyx_message_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Telnyx client (SDK v3)

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(compression());
app.use(morgan('combined'));
app.use('/public', express.static(path.join(__dirname, 'public')));

// API JSON
app.use('/api', cors({ origin: ALLOWED_ORIGIN }));
app.use('/api', express.json());

// Send message

app.post('/api/send', async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });

    const sendParams = { to, text: body };
    if (process.env.TELNYX_MESSAGING_PROFILE_ID) {
      sendParams.messaging_profile_id = process.env.TELNYX_MESSAGING_PROFILE_ID;
    } else if (process.env.FROM_NUMBER) {
      sendParams.from = process.env.FROM_NUMBER;
    } else {
      return res.status(400).json({
        error: 'Configure FROM_NUMBER or TELNYX_MESSAGING_PROFILE_ID in .env'
      });
    }

    const r = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sendParams)
    });

    const json = await r.json();

    if (!r.ok) {
      console.error('Telnyx send error:', JSON.stringify(json, null, 2));
      return res.status(500).json({ error: 'Failed to send', detail: json });
    }

    const data = json.data || {};
    db.run(
      `INSERT INTO messages(direction, from_number, to_number, body, status, telnyx_message_id)
       VALUES(?,?,?,?,?,?)`,
      [
        'out',
        data.from || process.env.FROM_NUMBER || '',
        data.to || to,
        body,
        data.status || 'queued',
        data.id || null
      ]
    );

    res.json({ ok: true, id: data.id, status: data.status || 'queued' });
  } catch (err) {
    const detail = err?.message || err;
    console.error('Send handler exception:', detail);
    res.status(500).json({ error: 'Failed to send', detail });
  }
});



//List messages
app.get('/api/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  db.all(
    `SELECT id, direction, from_number, to_number, body, status, telnyx_message_id, created_at
     FROM messages ORDER BY id DESC LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json(rows);
    }
  );
});

// Serve UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Telnyx webhook (raw body). Add signature verification when ready. ---
app.post('/webhooks/telnyx', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    // Optional verification (Ed25519) with account Public Key:
    // const signature = req.get('telnyx-signature-ed25519');
    // const timestamp = req.get('telnyx-timestamp');
    // const publicKey = process.env.TELNYX_WEBHOOK_PUBLIC_KEY;
    // telnyx.webhooks.constructEvent(req.body, signature, timestamp, publicKey);

    const event = JSON.parse(req.body.toString());
    const type = event.data?.event_type;
    const payload = event.data?.payload || {};

    if (type === 'message.received') {
      const from = payload.from?.phone_number || payload.from || '';
      const to = payload.to?.phone_number || payload.to || '';
      const body = payload.text || '';
      db.run(
        `INSERT INTO messages(direction, from_number, to_number, body, status, telnyx_message_id)
         VALUES(?,?,?,?,?,?)`,
        ['in', from, to, body, payload.status || 'received', payload.id || null]
      );
    } else if (type === 'message.delivery_status') {
      const status = payload.to?.[0]?.status || payload?.to?.status || payload?.delivery_status || payload?.status;
      const msgId = payload.id || payload.message_id || null;
      if (msgId) {
        db.run(`UPDATE messages SET status = ? WHERE telnyx_message_id = ?`, [status, msgId]);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error', err.message);
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
});

app.listen(PORT, () => {
  console.log(`SMS app listening on :${PORT}`);
});
