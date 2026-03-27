import nodemailer from 'nodemailer';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import cron from 'node-cron';
import { chat } from '../core/brain.js';
import { getDb } from '../database/init.js';
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

console.log('[EMAIL] Agent started');

const processedUids = new Set();

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"MARK - AI Marketing Agent" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`[EMAIL] Sent to ${to}: ${subject}`);
    return true;
  } catch (error) {
    console.error('[EMAIL] Send error:', error.message);
    return false;
  }
}

export async function sendOnboardingEmail(clientEmail, clientName) {
  const html = `
    <div style="font-family: monospace; background: #0a0a0a; color: #e0e0e0; padding: 2rem; max-width: 600px;">
      <h1 style="color: #00ff88;">◆ MARK</h1>
      <p>Welcome, ${clientName}.</p>
      <p>Your project is now active. Here's what happens next:</p>
      <ul>
        <li>I'll analyze your brief and build a marketing strategy within 24 hours</li>
        <li>You'll receive a full narrative framework, content calendar, and action plan</li>
        <li>Weekly progress reports will be sent every Monday</li>
      </ul>
      <p>Reply to this email anytime — I'm always on.</p>
      <p style="color: #00ff88;">— MARK</p>
      <p style="font-size: 0.75rem; color: #666;">mark-agent.xyz | Autonomous AI Marketing Agent</p>
    </div>
  `;
  return sendEmail(clientEmail, 'Welcome to MARK — Your project is active', html);
}

function checkInbox() {
  const imap = new Imap({
    user: process.env.GMAIL_USER,
    password: process.env.GMAIL_APP_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        console.error('[EMAIL] Inbox open error:', err.message);
        imap.end();
        return;
      }

      // Search for unseen emails
      imap.search(['UNSEEN'], (err, results) => {
        if (err || !results || results.length === 0) {
          imap.end();
          return;
        }

        const fetch = imap.fetch(results, { bodies: '', markSeen: true });

        fetch.on('message', (msg, seqno) => {
          let uid;
          msg.on('attributes', (attrs) => { uid = attrs.uid; });
          msg.on('body', (stream) => {
            let buffer = '';
            stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            stream.on('end', async () => {
              try {
                if (processedUids.has(uid)) return;
                processedUids.add(uid);

                const parsed = await simpleParser(buffer);
                const from = parsed.from?.value?.[0]?.address;
                const subject = parsed.subject || '';
                const text = parsed.text || '';

                if (!from || from === process.env.GMAIL_USER) return;

                console.log(`[EMAIL] New email from ${from}: ${subject}`);

                // Generate response
                const response = await chat(
                  `Email from ${from} with subject "${subject}":\n\n${text}\n\nWrite a professional email reply as MARK, the AI marketing agent. Be helpful and direct. If they're asking about services, include pricing info and suggest submitting a brief at mark-agent.xyz/brief.`,
                  { channel: 'email', userId: from, username: from }
                );

                // Send reply
                await sendEmail(from, `Re: ${subject}`, `
                  <div style="font-family: monospace; background: #0a0a0a; color: #e0e0e0; padding: 2rem; max-width: 600px;">
                    <h2 style="color: #00ff88;">◆ MARK</h2>
                    <div style="white-space: pre-wrap;">${response}</div>
                    <hr style="border-color: #1a1a1a; margin: 2rem 0;">
                    <p style="font-size: 0.75rem; color: #666;">MARK — AI Marketing Agent | mark-agent.xyz</p>
                  </div>
                `);

                // Save as client inquiry
                const db = getDb();
                try {
                  const existing = db.prepare('SELECT id FROM clients WHERE contact = ?').get(from);
                  if (!existing) {
                    db.prepare('INSERT INTO clients (name, contact, channel, project_brief, status) VALUES (?, ?, ?, ?, ?)')
                      .run(from, from, 'email', `Subject: ${subject}\n\n${text}`, 'inquiry');
                  }
                } finally {
                  db.close();
                }
              } catch (error) {
                console.error('[EMAIL] Processing error:', error.message);
              }
            });
          });
        });

        fetch.once('end', () => { imap.end(); });
      });
    });
  });

  imap.once('error', (err) => {
    console.error('[EMAIL] IMAP error:', err.message);
  });

  imap.connect();
}

// Check inbox every 30 minutes
cron.schedule('*/30 * * * *', () => {
  console.log('[EMAIL] Checking inbox...');
  checkInbox();
});

// Initial check
setTimeout(() => checkInbox(), 5000);

// Weekly report to clients - Monday 9am UTC
cron.schedule('0 9 * * 1', async () => {
  const db = getDb();
  try {
    const activeClients = db.prepare("SELECT * FROM clients WHERE status = 'active' AND contact LIKE '%@%'").all();

    for (const client of activeClients) {
      const conversations = db.prepare(
        "SELECT COUNT(*) as count FROM conversations WHERE user_id = ? AND timestamp > datetime('now', '-7 days')"
      ).get(client.contact);

      const html = `
        <div style="font-family: monospace; background: #0a0a0a; color: #e0e0e0; padding: 2rem; max-width: 600px;">
          <h2 style="color: #00ff88;">◆ MARK — Weekly Report</h2>
          <p>Hey ${client.name},</p>
          <p>Here's your weekly marketing update:</p>
          <ul>
            <li>Interactions this week: ${conversations.count}</li>
            <li>Project status: ${client.status}</li>
          </ul>
          <p>Reply to this email if you need anything adjusted.</p>
          <p style="color: #00ff88;">— MARK</p>
        </div>
      `;
      await sendEmail(client.contact, 'MARK — Weekly Marketing Report', html);
    }
  } catch (error) {
    console.error('[EMAIL] Weekly report error:', error.message);
  } finally {
    db.close();
  }
});

process.on('uncaughtException', (error) => {
  console.error('[EMAIL] Uncaught exception:', error.message);
});
