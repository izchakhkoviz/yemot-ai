import express from 'express';
import { YemotRouter } from 'yemot-router2';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { GoogleGenAI } from '@google/genai';
import textToSpeech from '@google-cloud/text-to-speech';
import speech from '@google-cloud/speech';

// ימות דוחה פיסוק בהודעות טקסט להקראה, לכן משאירים רק אותיות, ספרות ורווחים
const ym = (t) => String(t ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() || ' ';

// ===== lib/ai-client.js =====
let creds = null;
try { if (process.env.GOOGLE_CREDENTIALS_JSON) creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
catch (e) { console.error('GOOGLE_CREDENTIALS_JSON is NOT valid JSON, ignoring it:', e.message); }
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = (apiKey && !creds)
  ? new GoogleGenAI({ apiKey })
  : new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT || creds?.project_id,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      ...(creds ? { googleAuthOptions: { credentials: creds } } : {})
    });
const vertexMode = !(apiKey && !creds);
const aiGlobal = vertexMode ? new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || creds?.project_id,
  location: 'global',
  ...(creds ? { googleAuthOptions: { credentials: creds } } : {})
}) : null;
async function gen(params) {
  try { return await ai.models.generateContent(params); }
  catch (e) {
    if (!aiGlobal || !/404|NOT_FOUND|not found/i.test(String(e && e.message))) throw e;
    console.error('MODEL NOT FOUND in configured location, retrying in global:', params.model);
    return await aiGlobal.models.generateContent(params);
  }
}


// ===== lib/config.js =====

const PRESETS = {
  customer_service: { label: 'נציג שירות לקוחות', prompt: 'אתה נציג שירות לקוחות. עזור ללקוח לפתור בעיה או לקבל מידע, התעניין בו, ואם אינך יודע משהו אמור זאת בכנות והצע להעביר את הפנייה לטיפול.' },
  sales: { label: 'נציג מכירות', prompt: 'אתה נציג מכירות אדיב ולא לוחץ. הבן מה הלקוח צריך, הצע את המוצר או השירות המתאים, ענה על התנגדויות בכנות, והצע בסוף צעד הבא ברור (הצעת מחיר, מייל, שיחה חוזרת).' },
  free_chat: { label: 'שיחה חופשית', prompt: 'אתה בן שיח נעים וסקרן לשיחה חופשית. אפשר לדבר על כל נושא, להתבדח, ולשאול שאלות חזרה.' },
  receptionist: { label: 'פקיד קבלה / מזכירות', prompt: 'אתה פקיד קבלה. קבל פרטים מהמתקשר (שם, טלפון, מטרת הפנייה), ענה על שאלות בסיסיות, ושלח סיכום במייל לבעל העסק כשמתבקש.' }
};

const STYLES = {
  warm: 'חם, ידידותי וקליל, כמו שיחה עם אדם נחמד.',
  formal: 'מקצועי ומנומס, בלשון מכובדת, בלי סלנג.',
  brief: 'קצר וענייני מאוד. משפט או שניים לכל תשובה.',
  humorous: 'עם חוש הומור עדין, אבל בלי להגזים ובלי לפגוע.',
  calm: 'רגוע, איטי וסבלני, מתאים לאנשים מבוגרים או לחוצים.',
  energetic: 'אנרגטי ונלהב, עם חיוך בקול.'
};

// קולות Wavenet עבריים של גוגל (משתמשים בקרדיט)
const VOICES = [
  { name: 'he-IL-Wavenet-A', label: 'Wavenet A' },
  { name: 'he-IL-Wavenet-B', label: 'Wavenet B' },
  { name: 'he-IL-Wavenet-C', label: 'Wavenet C' },
  { name: 'he-IL-Wavenet-D', label: 'Wavenet D' },
  { name: 'he-IL-Chirp3-HD-Achernar', label: 'Achernar' },
  { name: 'he-IL-Chirp3-HD-Achird', label: 'Achird' },
  { name: 'he-IL-Chirp3-HD-Algenib', label: 'Algenib' },
  { name: 'he-IL-Chirp3-HD-Algieba', label: 'Algieba' },
  { name: 'he-IL-Chirp3-HD-Alnilam', label: 'Alnilam' },
  { name: 'he-IL-Chirp3-HD-Aoede', label: 'Aoede' },
  { name: 'he-IL-Chirp3-HD-Autonoe', label: 'Autonoe' },
  { name: 'he-IL-Chirp3-HD-Callirrhoe', label: 'Callirrhoe' },
  { name: 'he-IL-Chirp3-HD-Charon', label: 'Charon' },
  { name: 'he-IL-Chirp3-HD-Despina', label: 'Despina' },
  { name: 'he-IL-Chirp3-HD-Enceladus', label: 'Enceladus' },
  { name: 'he-IL-Chirp3-HD-Erinome', label: 'Erinome' },
  { name: 'he-IL-Chirp3-HD-Fenrir', label: 'Fenrir' },
  { name: 'he-IL-Chirp3-HD-Gacrux', label: 'Gacrux' },
  { name: 'he-IL-Chirp3-HD-Iapetus', label: 'Iapetus' },
  { name: 'he-IL-Chirp3-HD-Kore', label: 'Kore' },
  { name: 'he-IL-Chirp3-HD-Laomedeia', label: 'Laomedeia' },
  { name: 'he-IL-Chirp3-HD-Leda', label: 'Leda' },
  { name: 'he-IL-Chirp3-HD-Orus', label: 'Orus' },
  { name: 'he-IL-Chirp3-HD-Pulcherrima', label: 'Pulcherrima' },
  { name: 'he-IL-Chirp3-HD-Puck', label: 'Puck' },
  { name: 'he-IL-Chirp3-HD-Rasalgethi', label: 'Rasalgethi' },
  { name: 'he-IL-Chirp3-HD-Sadachbia', label: 'Sadachbia' },
  { name: 'he-IL-Chirp3-HD-Sadaltager', label: 'Sadaltager' },
  { name: 'he-IL-Chirp3-HD-Schedar', label: 'Schedar' },
  { name: 'he-IL-Chirp3-HD-Sulafat', label: 'Sulafat' },
  { name: 'he-IL-Chirp3-HD-Umbriel', label: 'Umbriel' },
  { name: 'he-IL-Chirp3-HD-Vindemiatrix', label: 'Vindemiatrix' },
  { name: 'he-IL-Chirp3-HD-Zephyr', label: 'Zephyr' }
];

const STYLE_LABELS = { warm: 'חם וידידותי', formal: 'מקצועי', brief: 'קצר ועניני', humorous: 'הומוריסטי', calm: 'רגוע', energetic: 'אנרגטי' };

const days = Array.from({ length: 7 }, (_, i) => ({ open: i !== 6, from: '08:00', to: '20:00' }));

const DEFAULTS = {
  enabled: true,
  role: 'customer_service',
  businessName: '',
  businessInfo: '',
  customInstructions: '',
  topicsMode: 'all',            // all | allowed | blocked
  topics: [],
  offTopicReply: 'סליחה, בנושא הזה אני לא יכול לעזור. אפשר לעזור במשהו אחר?',
  style: 'warm',
  voice: { provider: process.env.VOICE_PROVIDER || 'google', name: 'he-IL-Chirp3-HD-Leda', speakingRate: 1.0 }, // provider: google | yemot
  greeting: 'שלום, איך אפשר לעזור?',
  goodbye: 'תודה רבה ולהתראות.',
  access: { mode: 'all', numbers: [] },  // all | whitelist | blacklist
  deniedMessage: 'מצטערים, אין לך הרשאה להשתמש בשירות זה.',
  closedMessage: 'השירות סגור כעת. אנא חזרו בשעות הפעילות.',
  schedule: { enabled: false, tz: 'Asia/Jerusalem', days }, // days[0]=ראשון
  tools: { email: true, fax: false, images: true, music: true, video: true },
  model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  maxMinutes: 10,
  useNikud: false,
  consentMessage: '',
  endHint: ''
};

let ref = null;
async function getRef() {
  if (ref || process.env.LOCAL_CONFIG) return ref;
  const { Firestore } = await import('@google-cloud/firestore');
  ref = new Firestore({ ...(creds ? { projectId: creds.project_id, credentials: creds } : {}), databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)' }).collection('ivr').doc('config');
  return ref;
}

let cache = null, cacheAt = 0;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after ' + ms + 'ms')), ms))]);

async function loadStored() {
  if (process.env.LOCAL_CONFIG) {
    return fs.existsSync(process.env.LOCAL_CONFIG) ? JSON.parse(fs.readFileSync(process.env.LOCAL_CONFIG, 'utf8')) : {};
  }
  const s = await (await getRef()).get();
  return s.exists ? s.data() : {};
}

async function getConfig() {
  const tn0 = currentTenant();
  if (tn0.id !== 'default' && tn0.doc) return tenantConfig(tn0.doc);
  if (cache && Date.now() - cacheAt < 10000) return cache;
  let stored = {};
  try {
    stored = await withTimeout(loadStored(), 3000);
    cache = { ...DEFAULTS, ...stored };
    cache.tools = { ...DEFAULTS.tools, ...(stored.tools || {}) };
    // הקול תמיד של גוגל, אלא אם מוגדר במפורש VOICE_PROVIDER=yemot
    cache.voice = { ...DEFAULTS.voice, ...(stored.voice || {}), provider: process.env.VOICE_PROVIDER || 'google' };
    cacheAt = Date.now();
  } catch (e) {
    // המסד לא זמין: ממשיכים עם ההגדרות האחרונות או ברירות המחדל, ומנסים שוב בעוד דקה
    console.error('CONFIG LOAD FAILED, using fallback:', e.message);
    cache = cache || { ...DEFAULTS };
    cacheAt = Date.now() - 10000 + 60000; // תוקף cache של דקה בלבד
  }
  return cache;
}

async function saveConfig(patch) {
  const tn = currentTenant();
  if (tn.id !== 'default' && tn.doc) {
    const merged = { ...(tn.doc.config || {}), ...patch };
    await updateTenant(tn.id, { config: merged });
    tn.doc.config = merged;
    return tenantConfig(tn.doc);
  }
  const next = { ...(await getConfig()), ...patch };
  cache = next; cacheAt = Date.now();
  try {
    if (process.env.LOCAL_CONFIG) fs.writeFileSync(process.env.LOCAL_CONFIG, JSON.stringify(next, null, 2));
    else await withTimeout((await getRef()).set(next), 5000);
  } catch (e) {
    console.error('CONFIG SAVE FAILED (kept in memory only):', e.message);
  }
  return next;
}

// ---------- בדיקות גישה ושעות ----------
const norm = (n) => { let d = String(n || '').replace(/\D/g, ''); if (d.startsWith('972')) d = '0' + d.slice(3); return d; };

function isAllowed(cfg, phone) {
  const p = norm(phone), list = (cfg.access.numbers || []).map(norm);
  if (cfg.access.mode === 'whitelist') return list.includes(p);
  if (cfg.access.mode === 'blacklist') return !list.includes(p);
  return true;
}

function isOpen(cfg) {
  if (!cfg.schedule?.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.schedule.tz || 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = (t) => parts.find((x) => x.type === t).value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  // חצות עלול להופיע כ-24 בחלק מהגרסאות, לכן מנרמלים
  const hh = String(Number(get('hour')) % 24).padStart(2, '0');
  const now = `${hh}:${get('minute')}`;
  const d = cfg.schedule.days[dow];
  return !!d?.open && now >= d.from && now < d.to;
}

// ---------- רב-משתמשים: כל משתמש הוא "דייר" עם מספר ימות, הגדרות, זיכרון ומכסה משלו ----------
const tenantStore = new AsyncLocalStorage();
const currentTenant = () => tenantStore.getStore() || { id: 'default', doc: null };

let dbInstance = null;
async function db() {
  if (dbInstance) return dbInstance;
  const { Firestore } = await import('@google-cloud/firestore');
  dbInstance = new Firestore({ ...(creds ? { projectId: creds.project_id, credentials: creds } : {}), databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)' });
  return dbInstance;
}

const TENANT_ID_RE = /^[a-z0-9-]{3,40}$/;

async function loadTenant(id) {
  if (!TENANT_ID_RE.test(id) || id === 'default' || process.env.LOCAL_CONFIG) return null;
  const s = await withTimeout((await db()).collection('tenants').doc(id).get(), 3000);
  return s.exists ? { id, doc: s.data() } : null;
}

async function updateTenant(id, patch) {
  await withTimeout((await db()).collection('tenants').doc(id).set(patch, { merge: true }), 5000);
}

const hashToken = (token, salt) => scryptSync(String(token), salt, 32).toString('hex');

function checkTenantToken(tenant, token) {
  const { tokenSalt, tokenHash } = tenant.doc || {};
  if (!tokenSalt || !tokenHash || !token) return false;
  const a = Buffer.from(hashToken(token, tokenSalt), 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// טוקן ימות של המשתמש הנוכחי. למשתמש הברירת מחדל נשאר הטוקן מהסביבה
const yemotCred = () => {
  const t = currentTenant().doc || {};
  return t.yemotNumber && t.yemotPassword ? `${t.yemotNumber}:${t.yemotPassword}` : `${process.env.YEMOT_NUMBER}:${process.env.YEMOT_PASSWORD}`;
};

function tenantConfig(doc) {
  const c = doc.config || {};
  return { ...DEFAULTS, ...c, tools: { ...DEFAULTS.tools, ...(c.tools || {}) }, voice: { ...DEFAULTS.voice, ...(c.voice || {}), provider: 'google' } };
}

// מכסת שיחות יומית למשתמש, כדי שלא ייגמר הקרדיט של הבעלים
async function countCall(id, limit) {
  if (id === 'default') return true;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const ref = (await db()).collection('usage').doc(`${id}_${day}`);
    const s = await withTimeout(ref.get(), 3000);
    const n = s.exists ? (s.data().calls || 0) : 0;
    if (n >= (limit || 200)) return false;
    await withTimeout(ref.set({ calls: n + 1, day }, { merge: true }), 3000);
    return true;
  } catch (e) { console.error('USAGE CHECK FAILED:', e.message); return true; }
}

async function usageToday(id) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const s = await (await db()).collection('usage').doc(`${id}_${day}`).get();
    return s.exists ? (s.data().calls || 0) : 0;
  } catch (e) { return null; }
}

// רק השדות שהמשתמש רשאי לשנות בעצמו. מכסה ומפתחות גישה נקבעים על ידי הבעלים בלבד
function pickConfig(b) {
  const out = {};
  for (const k of ['businessName', 'businessInfo', 'customInstructions', 'offTopicReply', 'greeting', 'goodbye', 'deniedMessage', 'closedMessage', 'consentMessage']) {
    if (typeof b[k] === 'string') out[k] = b[k].slice(0, 3000);
  }
  if (typeof b.role === 'string' && PRESETS[b.role]) out.role = b.role;
  if (typeof b.style === 'string' && STYLES[b.style]) out.style = b.style;
  if (['all', 'allowed', 'blocked'].includes(b.topicsMode)) out.topicsMode = b.topicsMode;
  if (Array.isArray(b.topics)) out.topics = b.topics.map(String).slice(0, 50);
  if (typeof b.enabled === 'boolean') out.enabled = b.enabled;
  if (typeof b.useNikud === 'boolean') out.useNikud = b.useNikud;
  if (typeof b.maxMinutes === 'number') out.maxMinutes = Math.min(Math.max(b.maxMinutes, 1), 15);
  if (b.access && typeof b.access === 'object') {
    out.access = {
      mode: ['all', 'whitelist', 'blacklist'].includes(b.access.mode) ? b.access.mode : 'all',
      numbers: Array.isArray(b.access.numbers) ? b.access.numbers.map(String).slice(0, 500) : []
    };
  }
  if (b.schedule && typeof b.schedule === 'object') {
    out.schedule = {
      enabled: !!b.schedule.enabled,
      tz: String(b.schedule.tz || 'Asia/Jerusalem'),
      days: Array.isArray(b.schedule.days) ? b.schedule.days.slice(0, 7).map((d) => ({ open: !!d.open, from: String(d.from || '08:00'), to: String(d.to || '20:00') })) : days
    };
  }
  if (b.tools && typeof b.tools === 'object') out.tools = {
    email: !!b.tools.email,
    fax: !!b.tools.fax && !!process.env.FAX_WEBHOOK_URL,
    images: !!b.tools.images,
    music: !!b.tools.music,
    video: !!b.tools.video
  };
  if (b.voice && typeof b.voice === 'object') {
    const v = VOICES.find((x) => x.name === b.voice.name);
    if (v) out.voice = { provider: 'google', name: v.name, speakingRate: Math.min(Math.max(Number(b.voice.speakingRate) || 1, 0.7), 1.3) };
  }
  return out;
}

// ===== lib/tts.js =====
const client = new textToSpeech.TextToSpeechClient(creds ? { credentials: creds, projectId: creds.project_id } : (apiKey ? { apiKey } : {}));
// זיהוי דיבור של גוגל (Chirp 3). משתמשים באותם אישורים. ברירת מחדל: מיקום us
const SPEECH_LOCATION = process.env.SPEECH_LOCATION || 'us';
const SPEECH_MODEL = process.env.SPEECH_MODEL || 'chirp_3';
// נקודת הקצה חייבת להתאים למיקום: global משתמש בכתובת הכללית, וכל מיקום אחר בכתובת שלו
const speechEndpoint = SPEECH_LOCATION === 'global' ? 'speech.googleapis.com' : `${SPEECH_LOCATION}-speech.googleapis.com`;
const speechClient = new speech.v2.SpeechClient({
  ...(creds ? { credentials: creds, projectId: creds.project_id } : (apiKey ? { apiKey } : {})),
  apiEndpoint: speechEndpoint,
});

const cleanForSpeech = (t) => String(t)
  .replace(/[*_#`>~]/g, '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();

async function synth(text, voice, { encoding = 'LINEAR16', rate = 16000 } = {}) {
  const name = voice.name;
  const languageCode = name.split('-').slice(0, 2).join('-');
  const [r] = await client.synthesizeSpeech({
    input: { text: cleanForSpeech(text) },
    voice: { languageCode, name },
    audioConfig: { audioEncoding: encoding, ...(encoding === 'LINEAR16' ? { sampleRateHertz: rate } : {}), speakingRate: voice.speakingRate || 1 }
  });
  return Buffer.from(r.audioContent);
}

async function listVoices(languageCode = 'he-IL') {
  const [r] = await client.listVoices({ languageCode });
  return r.voices.map((v) => ({ name: v.name, gender: v.ssmlGender }));
}

// ===== lib/yemot.js =====
const token = () => yemotCred();

// מעלה קובץ WAV למערכת ימות כדי שאפשר יהיה להשמיע אותו בשיחה
async function uploadWav(buf, remotePath) {
  const form = new FormData();
  form.append('token', token());
  form.append('path', `ivr2:${remotePath}`);
  form.append('convertAudio', '1');
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'a.wav');
  const res = await fetch('https://www.call2all.co.il/ym/api/UploadFile', { method: 'POST', body: form });
  const j = await res.json().catch(() => ({}));
  if (j.responseStatus && j.responseStatus !== 'OK') throw new Error('Yemot upload: ' + JSON.stringify(j));
}

// ===== lib/tools.js =====

const mailer = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// שליחת מייל: דרך Brevo (HTTP, עובד גם כש-SMTP חסום), ואם אין מפתח - דרך SMTP
const brevoEnabled = () => !!process.env.BREVO_API_KEY;
async function sendMail({ to, subject, text, attachments = [] }) {
  const t = currentTenant();
  const key = (t.doc && t.doc.brevoApiKey) || (t.id === 'default' ? process.env.BREVO_API_KEY : '');
  const from = (t.doc && t.doc.mailFrom) || (t.id === 'default' ? process.env.MAIL_FROM : '');
  if (key) {
    const r = await withTimeout(fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from },
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(attachments.length ? { attachment: attachments.map((a) => ({ name: a.filename, content: a.content.toString('base64') })) } : {})
      })
    }), 15000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return { messageId: j.messageId };
  }
  if (t.id !== 'default') throw new Error('לא הוגדר שולח מייל למשתמש הזה');
  return mailer().sendMail({ from: process.env.MAIL_FROM, to, subject, text, attachments });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_MAILS_PER_CALL = 3;

const S = 'STRING';
function declarations(cfg) {
  const d = [{
    name: 'end_call',
    description: 'סיום השיחה בנימוס, רק אחרי שהמתקשר סיים ונפרדתם.',
    parameters: { type: 'OBJECT', properties: {} }
  }];
  if (cfg.tools.email || cfg.tools.fax) d.push({
    name: 'ask_email_by_keypad',
    description: 'מבקש מהמתקשר להקליד כתובת מייל במקלדת הטלפון. אמין יותר מהכתבה בקול. השתמש כשצריך כתובת מייל, או כשהזיהוי הקולי של הכתובת לא ברור.',
    parameters: { type: 'OBJECT', properties: {} }
  });
  if (cfg.tools.email) d.push({
    name: 'send_email',
    description: 'שולח מייל לכתובת שהמתקשר הקליד או אמר. קרא לפונקציה רק אחרי שהמתקשר אישר את הכתובת ואת התוכן.',
    parameters: { type: 'OBJECT', properties: {
      to: { type: S, description: 'כתובת הנמען' },
      subject: { type: S }, body: { type: S, description: 'גוף המייל המלא' },
      attachment_ids: { type: 'ARRAY', items: { type: S }, description: 'מזהי קבצים שנוצרו (תמונות או שירים)' }
    }, required: ['to', 'subject', 'body'] }
  });
  if (cfg.tools.fax) d.push({
    name: 'send_fax',
    description: 'שולח פקס. קרא רק אחרי שהמתקשר אישר את המספר ואת התוכן.',
    parameters: { type: 'OBJECT', properties: {
      fax_number: { type: S }, subject: { type: S }, body: { type: S }
    }, required: ['fax_number', 'body'] }
  });
  if (cfg.tools.music) d.push({
    name: 'create_song',
    description: 'יוצר שיר שלם בעברית, עם מילים ושירה, לפי תיאור. השיר נוצר ברקע ונשלח למייל שהמתקשר נתן, בעוד כמה דקות. קרא רק כשהמתקשר ביקש שיר, אישר את התיאור, את אורכו ואת כתובת המייל.',
    parameters: { type: 'OBJECT', properties: {
      prompt: { type: S, description: 'תיאור השיר: על מה הוא, סגנון, מצב רוח, כלים, ומה המילים צריכות לומר. עדיף באנגלית או בעברית' },
      duration: { type: 'INTEGER', description: 'אורך השיר בשניות, בין 30 ל-180. שיר קצר כ-60, בינוני כ-120, ארוך כ-180' },
      to: { type: S, description: 'כתובת המייל לשליחת השיר' }
    }, required: ['prompt', 'to'] }
  });
  if (cfg.tools.video) d.push({
    name: 'create_video',
    description: 'יוצר סרטון קצר (כ-8 שניות). הסרטון לוקח כמה דקות, ולכן הוא נשלח למייל בנפרד, לא בשיחה. קרא רק אחרי שהמתקשר אישר את התיאור ואת כתובת המייל.',
    parameters: { type: 'OBJECT', properties: {
      prompt: { type: S, description: 'תיאור הסרטון באנגלית: מה רואים, איך זה זז, סגנון' },
      to: { type: S, description: 'כתובת המייל לשליחה' }
    }, required: ['prompt', 'to'] }
  });
  if (cfg.tools.images) d.push({
    name: 'generate_image',
    description: 'יוצר תמונה לפי תיאור. מחזיר asset_id שאפשר לצרף למייל.',
    parameters: { type: 'OBJECT', properties: { prompt: { type: S, description: 'תיאור התמונה, באנגלית עדיף' } }, required: ['prompt'] }
  });
  return d;
}

async function runTool(name, args, ctx) {
  switch (name) {
    case 'end_call':
      ctx.ended = true;
      return { ok: true };

    case 'ask_email_by_keypad': {
      const v = await ctx.call.read(
        [{ type: 'text', data: ym('אנא הקלידו את כתובת המייל במקלדת ובסיום הקישו סולמית') }],
        'tap', { typing_playback_mode: 'EmailKeyboard', max_digits: 80, min_digits: 5, sec_wait: 30 });
      return { email: String(v || '').trim() };
    }

    case 'generate_image': {
      const r = await gen({
        model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-lite-image', contents: args.prompt });
      const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) return { error: 'לא נוצרה תמונה' };
      const id = randomUUID().slice(0, 8);
      ctx.assets.set(id, { mime: part.inlineData.mimeType, data: Buffer.from(part.inlineData.data, 'base64') });
      return { asset_id: id };
    }

    case 'send_email': {
      const to = String(args.to || '').trim();
      if (!EMAIL_RE.test(to)) return { error: 'כתובת המייל לא תקינה. בקש מהמתקשר להקליד אותה שוב' };
      if ((ctx.mailCount || 0) >= MAX_MAILS_PER_CALL) return { error: 'הגעתם למגבלת המיילים לשיחה הזו' };
      ctx.mailCount = (ctx.mailCount || 0) + 1;

      const attachments = (args.attachment_ids || []).filter((i) => ctx.assets.has(i)).map((i, n) => {
        const a = ctx.assets.get(i);
        const ext = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'image/png': 'png', 'image/jpeg': 'jpg' }[a.mime] || a.mime.split('/')[1] || 'bin';
        return { filename: `file${n + 1}.${ext}`, content: a.data, contentType: a.mime };
      });
      try {
        const info = await sendMail({ to, subject: args.subject || '', text: args.body || '', attachments });
        console.log('MAIL SENT', info.messageId, 'to', to);
        return { sent: true };
      } catch (e) {
        console.error('MAIL FAILED:', e.message);
        return { error: 'שליחת המייל נכשלה: ' + e.message };
      }
    }

    case 'send_fax': {
      if (!process.env.FAX_WEBHOOK_URL) return { error: 'שירות הפקס עדיין לא הוגדר' };
      const r = await fetch(process.env.FAX_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: args.fax_number, subject: args.subject || '', text: args.body }) });
      return r.ok ? { sent: true } : { error: 'שליחת הפקס נכשלה: ' + r.status };
    }
    case 'create_song': {
      const to = String(args.to || '').trim();
      if (!EMAIL_RE.test(to)) return { error: 'כתובת המייל לא תקינה. בקש מהמתקשר להקליד אותה במקלדת' };
      const prompt = String(args.prompt || '').trim().slice(0, 500);
      if (!prompt) return { error: 'חסר תיאור לשיר' };
      const duration = Math.min(Math.max(Number(args.duration) || SONG_DURATION, 30), 180);
      const t = currentTenant();
      if (!(await countGeneration(t.id, t.doc?.dailyGenerationLimit))) return { error: 'הגעתם למכסת היצירות להיום' };
      // השיר נוצר ברקע, והשיחה לא מחכה לו
      runSongJob(prompt, to, duration).catch((e) => console.error('SONG JOB CRASH', e.message));
      return { started: true, note: 'השיר בדרך, הוא יגיע למייל בעוד כמה דקות' };
    }

    case 'create_video': {
      const to = String(args.to || '').trim();
      if (!EMAIL_RE.test(to)) return { error: 'כתובת המייל לא תקינה. בקש מהמתקשר להקליד אותה במקלדת' };
      const prompt = String(args.prompt || '').trim().slice(0, 500);
      if (!prompt) return { error: 'חסר תיאור לסרטון' };
      const t = currentTenant();
      if (!(await countGeneration(t.id, t.doc?.dailyGenerationLimit))) return { error: 'הגעתם למכסת היצירות להיום' };
      // הסרטון נוצר ברקע, והשיחה לא מחכה לו
      runVideoJob(prompt, to).catch((e) => console.error('VIDEO JOB CRASH', e.message));
      return { started: true, note: 'הסרטון בדרך, הוא יגיע למייל בעוד כמה דקות' };
    }

    default: return { error: 'פונקציה לא מוכרת' };
  }
}

// ===== lib/generate.js: יצירת שירים וסרטונים =====
// שמות המודלים ניתנים לשינוי בהגדרות הסביבה. יש לאמת אותם מול התיעוד של Vertex AI
// lyria-002 מנגן רק בלי שירה. Lyria 3 מייצר שירה עם מילים. Pro עד כ-3 דקות, Clip עד 30 שניות
const MUSIC_MODEL = process.env.LYRIA_MODEL || 'lyria-3-pro-preview';
const VIDEO_MODEL = process.env.VEO_MODEL || 'veo-3.0-generate-001';
const MAIL_MAX = 3.5 * 1024 * 1024;   // מעל זה שולחים קישור במקום קובץ מצורף
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// שירה בעברית: ModelsLab (ACE-Step). הלחנה, מילים בעברית ושירה, והפלט הוא קישור להורדה
const SONG_LANGUAGE = process.env.SONG_LANGUAGE || 'he';
const SONG_DURATION = Math.min(Math.max(Number(process.env.SONG_DURATION || 120), 30), 480);

async function makeSongModelsLab(prompt, duration) {
  const key = process.env.MODELSLAB_API_KEY;
  const post = await withTimeout(fetch('https://modelslab.com/api/v6/voice/song_generator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key, lyrics_generation: true, prompt,
      caption: prompt.slice(0, 300),
      language: SONG_LANGUAGE, duration, instrumental: false
    })
  }), 60000);
  let j = await post.json().catch(() => ({}));
  if (!post.ok || j.status === 'error') throw new Error('ModelsLab: ' + String(j.message || post.status).slice(0, 200));

  // כשהשיר בעיבוד, בודקים שוב לפי fetch_result עד שהוא מוכן
  for (let i = 0; i < 40 && j.status === 'processing' && j.fetch_result; i++) {
    await sleep(Math.min(Math.max(Number(j.eta) || 10, 5), 30) * 1000);
    j = await withTimeout(fetch(j.fetch_result, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key })
    }), 30000).then((r) => r.json()).catch(() => ({ status: 'processing' }));
  }
  const url = j.output?.[0] || j.links?.[0] || j.proxy_links?.[0];
  if (j.status !== 'success' || !url) throw new Error('ModelsLab: לא התקבל שיר');

  const audio = await withTimeout(fetch(url), 120000);
  if (!audio.ok) throw new Error('ModelsLab: הורדת השיר נכשלה ' + audio.status);
  return { buf: Buffer.from(await audio.arrayBuffer()), mime: audio.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
}

// ACE Music: API חינמי למודל ACE-Step. מצב sample_mode כותב מילים לפי התיאור בשפה vocal_language
async function makeSongAceMusic(prompt, duration) {
  const base = process.env.ACE_MUSIC_BASE_URL || 'https://api.acemusic.ai';
  console.log('ACE REQUEST prompt_len', String(prompt).length, 'prompt_start', JSON.stringify(String(prompt).slice(0, 80)), 'duration', duration);
  let res, body = '';
  // שגיאות 502/503/504 הן בדרך כלל זמניות בצד של השירות, לכן מנסים שוב עם המתנה
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await withTimeout(fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ACEMUSIC_API_KEY}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        sample_mode: true,
        audio_config: { duration, vocal_language: SONG_LANGUAGE, instrumental: false },
        format: 'mp3'
      })
    }), 300000);
    body = await res.text();
    if (res.ok || ![502, 503, 504].includes(res.status)) break;
    console.error(`ACE Music ${res.status} (attempt ${attempt}):`, body.slice(0, 300));
    await sleep(attempt * 5000);
  }
  if (!res.ok) throw new Error('ACE Music ' + res.status + ': ' + body.slice(0, 200));
  let j = {};
  try { j = JSON.parse(body); } catch (e) { /* התשובה לא JSON */ }
  // מחפשים את השמע בתשובה, בפורמט data URI של base64
  const m = JSON.stringify(j).match(/data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/i);
  if (!m) throw new Error('ACE Music: לא נמצא שמע בתשובה');
  return { buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

async function makeSong(prompt, duration = SONG_DURATION) {
  if (process.env.ACEMUSIC_API_KEY) return makeSongAceMusic(prompt, duration);
  if (process.env.MODELSLAB_API_KEY) return makeSongModelsLab(prompt, duration);
  if (MUSIC_MODEL.startsWith('lyria-3')) {
    // Lyria 3: שירה ומילים. ההנחיה מבקשת במפורש שיר שלם עם שירה
    const r = await withTimeout(gen({
      model: MUSIC_MODEL,
      contents: `Create a complete song with sung vocals and lyrics, with a clear intro and a proper ending. ${prompt}`,
      config: { responseModalities: ['AUDIO', 'TEXT'] }
    }), 300000);
    const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error('לא נוצר שיר');
    return { buf: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType || 'audio/mpeg' };
  }
  // מסלול ישן (lyria-002): אינסטרומנטלי בלבד, בערך 30 שניות
  const token = await client.auth.getAccessToken();   // אישור גישה מפורש לגוגל
  const project = process.env.GOOGLE_CLOUD_PROJECT || creds?.project_id;
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${project}/locations/us-central1/publishers/google/models/${MUSIC_MODEL}:predict`;
  const res = await withTimeout(fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sample_count: 1 } })
  }), 120000);
  const r = { data: await res.json().catch(() => ({})) };
  if (!res.ok) throw new Error(JSON.stringify(r.data?.error || r.data).slice(0, 200));
  const p = r.data?.predictions?.[0];
  if (!p?.bytesBase64Encoded) throw new Error('לא נוצר שיר');
  return { buf: Buffer.from(p.bytesBase64Encoded, 'base64'), mime: 'audio/wav' };
}

async function makeVideo(prompt) {
  const config = { numberOfVideos: 1, durationSeconds: 8 };
  if (process.env.VIDEO_GCS_URI) config.outputGcsUri = process.env.VIDEO_GCS_URI;
  let op = await ai.models.generateVideos({ model: VIDEO_MODEL, prompt, config });
  for (let i = 0; i < 60 && !op.done; i++) { await sleep(10000); op = await ai.operations.getVideosOperation({ operation: op }); }
  if (!op.done) throw new Error('יצירת הסרטון ארכה יותר מדי');
  if (op.error) throw new Error(JSON.stringify(op.error).slice(0, 200));
  const v = op.response?.generatedVideos?.[0]?.video;
  if (v?.videoBytes) return { buf: Buffer.from(v.videoBytes, 'base64'), ext: 'mp4' };
  if (v?.uri?.startsWith('gs://')) throw new Error('הסרטון נשמר ב-GCS ולא הורד. בטל את VIDEO_GCS_URI כדי לקבל את הסרטון ישירות');
  throw new Error('לא נוצר סרטון');
}

// רץ ברקע. ההקשר של הדייר נשמר דרך AsyncLocalStorage, ולכן המייל יוצא מהחשבון הנכון
async function runVideoJob(prompt, to) {
  const subject = 'הסרטון שביקשת';
  const text = `שלום, מצורף הסרטון שביקשתם בשיחה טלפונית.\nהתיאור: ${prompt}`;
  try {
    const file = await makeVideo(prompt);
    if (file.buf.length <= MAIL_MAX) {
      await sendMail({ to, subject, text, attachments: [{ filename: 'video.mp4', content: file.buf, contentType: 'video/mp4' }] });
    } else {
      await sendMail({ to, subject, text: text + '\n\nהסרטון גדול מדי לשליחה במייל, לכן לא צורף.' });
    }
    console.log('VIDEO SENT to', to);
  } catch (e) {
    console.error('VIDEO FAILED', e.message);
    try { await sendMail({ to, subject: 'לא הצלחנו ליצור את הסרטון', text: 'מצטערים, היצירה נכשלה: ' + String(e.message).slice(0, 200) }); } catch (_) {}
  }
}

// רץ ברקע, בדומה לסרטון. השיר נשלח במייל כקובץ מצורף אם הוא נכנס למגבלה
async function runSongJob(prompt, to, duration) {
  const subject = 'השיר שביקשת';
  const text = `שלום, מצורף השיר שביקשתם בשיחה טלפונית.\nהתיאור: ${prompt}`;
  try {
    const song = await makeSong(prompt, duration);
    const ext = song.mime === 'audio/wav' ? 'wav' : 'mp3';
    if (song.buf.length <= MAIL_MAX) {
      await sendMail({ to, subject, text, attachments: [{ filename: `song.${ext}`, content: song.buf, contentType: song.mime }] });
    } else {
      await sendMail({ to, subject, text: text + '\n\nהשיר גדול מדי לשליחה במייל, לכן לא צורף. אפשר לבקש שיר קצר יותר.' });
    }
    console.log('SONG SENT to', to, 'bytes', song.buf.length);
  } catch (e) {
    console.error('SONG FAILED', e.message);
    try { await sendMail({ to, subject: 'לא הצלחנו ליצור את השיר', text: 'מצטערים, היצירה נכשלה: ' + String(e.message).slice(0, 200) }); } catch (_) {}
  }
}

// מכסה יומית ליצירות, כדי שלא ייגמר הקרדיט של הבעלים
async function countGeneration(id, limit) {
  if (id === 'default') return true;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const ref = (await db()).collection('usage').doc(`gen_${id}_${day}`);
    const s = await withTimeout(ref.get(), 3000);
    const n = s.exists ? (s.data().n || 0) : 0;
    if (n >= (limit || 5)) return false;
    await withTimeout(ref.set({ n: n + 1 }, { merge: true }), 3000);
    return true;
  } catch (e) { console.error('GEN USAGE FAILED:', e.message); return false; }
}

// ===== lib/ai.js =====

function buildSystemPrompt(cfg) {
  const topics = cfg.topicsMode === 'allowed'
    ? `מותר לך לדבר רק על הנושאים הבאים: ${cfg.topics.join(', ')}. אם מבקשים משהו אחר, ענה בנימוס בערך כך: "${cfg.offTopicReply}"`
    : cfg.topicsMode === 'blocked'
    ? `אסור לך לדבר על: ${cfg.topics.join(', ')}. אם מבקשים, ענה בנימוס בערך כך: "${cfg.offTopicReply}"`
    : 'אפשר לדבר על כל נושא סביר.';
  return [
    PRESETS[cfg.role]?.prompt || PRESETS.free_chat.prompt,
    cfg.businessName && `שם העסק: ${cfg.businessName}.`,
    cfg.businessInfo && `מידע על העסק שמותר לך להסתמך עליו:\n${cfg.businessInfo}`,
    topics,
    `סגנון דיבור: ${STYLES[cfg.style] || STYLES.warm}`,
    cfg.customInstructions,
    cfg.useNikud ? 'כתוב את כל תשובותיך עם ניקוד מלא, כדי שההקראה תהיה ברורה.' : '',
    `זו שיחת טלפון בעברית עם אדם אמיתי. דבר בדיוק כמו בן אדם בשיחה: משפטים קצרים וטבעיים (עד 2-3 משפטים בתשובה), עברית מדוברת ולא כתובה, בלי רשימות, בלי כוכביות או עיצוב, בלי אימוג'ים. מספרים ותאריכים כתוב במילים. אל תשתמש בתבניות קבועות ואל תחזור על אותם ניסוחים; הגב למה שנאמר, שאל שאלות המשך כשזה טבעי, ואם לא הבנת אל תנחש, שאל שוב.`,
    `כשצריך לשלוח מייל, שאל כמו נציג אנושי לאן לשלוח, אשר את הפרטים בקול לפני השליחה, ורק אז שלח. אם אתה צריך כתובת מייל, העדף לבקש מהמתקשר להקליד אותה במקלדת. אחרי השליחה אשר שזה נשלח, או הסבר בקצרה מה השתבש.`,
    'אם מבקשים שיר או סרטון: אסוף תיאור, בקש את כתובת המייל (עדיף במקלדת), אשר את הפרטים, ורק אז הפעל את הכלי. לשיר שאל גם על האורך: קצר, בינוני או ארוך (עד כ-3 דקות). השיר נוצר ברקע ונשלח למייל בעוד כמה דקות, אז אמור זאת למתקשר ואל תחכה לו בשיחה. סרטון לוקח כמה דקות ונשלח למייל בנפרד, אז אמור למתקשר שיגיע למייל בעוד כמה דקות. אפשר ליצור שירים, תמונות וסרטונים על כמעט כל נושא, כולל ביקורת פוליטית וחברתית, הומור, סיפורים כבדים, וסצנות אלימות בסיפור. אסור: תוכן מיני בכל צורה; קטינים בהקשר מיני או אלים; תוכן שמכפיש אדם אמיתי או מציג אותו עושה או אומר דברים שלא עשה; והסתה לאלימות נגד אדם או קבוצה. אם מבקשים משהו אסור, הסבר בנימוס והצע חלופה קרובה שאפשר לעשות.',
    `אם הטקסט שהתקבל מהזיהוי הקולי נראה משובש, שאל בנימוס שוב במקום לנחש. לעולם אל תגיד למתקשר שהוא קטוע, מגמגם או לא ברור, כי ייתכן שהבעיה בהקלטה ולא בו. אם המשפט נראה חלקי, פשוט בקש בנימוס שישלים. אל תמציא עובדות על העסק.`
  ].filter(Boolean).join('\n\n');
}

// מריץ תור שיחה אחד, כולל כל קריאות הכלים, ומחזיר את הטקסט להשמעה
async function respond(history, cfg, ctx) {
  const tools = declarations(cfg);
  for (let i = 0; i < 5; i++) {
    const res = await gen({
      model: cfg.model, contents: history,
      config: { systemInstruction: buildSystemPrompt(cfg), temperature: 0.8, maxOutputTokens: 400,
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}) }
    });
    const content = res.candidates?.[0]?.content;
    if (content) history.push(content);
    const calls = res.functionCalls;
    if (!calls?.length) return (res.text || '').trim();
    const parts = [];
    for (const c of calls) {
      let out; try { out = await runTool(c.name, c.args || {}, ctx); } catch (e) { out = { error: String(e.message || e) }; }
      parts.push({ functionResponse: { name: c.name, response: out } });
    }
    history.push({ role: 'user', parts });
    if (ctx.ended) { const t = (res.text || '').trim(); if (t) return t; }
  }
  return 'סליחה, משהו השתבש אצלי. אפשר לנסות שוב?';
}

// ===== lib/admin.js =====

const adminApi = express.Router();

adminApi.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.ADMIN_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const t = (req.get('Authorization') || '').replace('Bearer ', '');
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

adminApi.get('/config', async (_q, r) => r.json(await getConfig()));
adminApi.put('/config', async (q, r) => r.json(await saveConfig(pickConfig(q.body || {}))));
adminApi.get('/options', (_q, r) => r.json({
  presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
  styles: Object.keys(STYLES),
  voices: VOICES
}));
adminApi.get('/voices', async (_q, r) => r.json(await listVoices('he-IL')));
// ניהול משתמשים (רק הבעלים, עם ADMIN_TOKEN)
adminApi.get('/tenants', async (_q, r) => {
  const s = await (await db()).collection('tenants').get();
  r.json(s.docs.map((d) => ({ id: d.id, name: d.data().name, enabled: d.data().enabled !== false, dailyCallLimit: d.data().dailyCallLimit || 200 })));
});
adminApi.post('/tenants', async (q, r) => {
  const name = String(q.body?.name || '').trim().slice(0, 80);
  if (!name) return r.status(400).json({ error: 'name required' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 25) || 'user';
  const id = `${slug}-${randomUUID().slice(0, 4)}`;
  const token = randomBytes(24).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  await updateTenant(id, {
    name, tokenSalt: salt, tokenHash: hashToken(token, salt), enabled: true, config: {},
    dailyCallLimit: Math.max(1, Math.min(Number(q.body?.dailyCallLimit) || 200, 5000)),
    createdAt: new Date().toISOString()
  });
  r.json({ id, token, note: 'שמור את הטוקן, הוא לא יוצג שוב' });
});
adminApi.put('/tenants/:id', async (q, r) => {
  if (!TENANT_ID_RE.test(q.params.id)) return r.status(400).json({ error: 'bad id' });
  const patch = {};
  if (typeof q.body?.enabled === 'boolean') patch.enabled = q.body.enabled;
  if (typeof q.body?.dailyCallLimit === 'number') patch.dailyCallLimit = Math.max(1, Math.min(q.body.dailyCallLimit, 5000));
  await updateTenant(q.params.id, patch);
  r.json({ ok: true });
});

// האזנה לקול לפני בחירה: מחזיר MP3 ב-base64
adminApi.post('/tts-preview', async (q, r) => {
  const buf = await synth(q.body.text || 'שלום, כך אני נשמע.', q.body.voice, { encoding: 'MP3' });
  r.json({ mime: 'audio/mpeg', base64: buf.toString('base64') });
});

// ===== server.js =====

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const app = express();
app.use(express.json({ limit: '1mb' }));

// ניתוב משתמשים: /chat/<id> ו-/admin/<id> הן השלוחות של המשתמש, /tapi/<id>/... הוא ה-API של המשתמש
app.use(async (req, res, next) => {
  const m = req.url.match(/^\/(chat|admin)\/([a-z0-9-]{3,40})(.*)$/);
  const a = req.url.match(/^\/tapi\/([a-z0-9-]{3,40})(.*)$/);
  if (!m && !a) return next();
  try {
    const t = await loadTenant(m ? m[2] : a[1]);
    if (!t || t.doc.enabled === false) return res.status(404).send('not found');
    req.url = m ? `/${m[1]}${m[3]}` : `/tapi${a[2]}`;
    return tenantStore.run(t, () => next());
  } catch (e) {
    console.error('TENANT ROUTE FAILED:', e.message);
    return res.status(500).send('error');
  }
});
app.get('/healthz', (_q, r) => r.send('ok'));
app.use('/api', adminApi);

app.get('/', (_q, r) => r.send('ok'));
app.get('/test', async (q, r) => {
  if (!process.env.ADMIN_TOKEN || q.query.token !== process.env.ADMIN_TOKEN) return r.status(401).send('unauthorized');
  const out = {};
  const step = async (name, fn) => { const t = Date.now(); try { out[name] = { ok: true, ms: Date.now() - t, info: await fn() }; } catch (e) { out[name] = { ok: false, ms: Date.now() - t, error: String(e.message || e).slice(0, 300) }; } };
  await step('env', async () => ({ project: process.env.GOOGLE_CLOUD_PROJECT, hasCreds: !!creds, hasApiKey: !!apiKey, yemotNumber: !!process.env.YEMOT_NUMBER, yemotPassword: !!process.env.YEMOT_PASSWORD, smtpHost: process.env.SMTP_HOST || null, smtpUserSet: !!process.env.SMTP_USER, smtpPassSet: !!process.env.SMTP_PASS, brevoKeySet: !!process.env.BREVO_API_KEY, mailFromSet: !!process.env.MAIL_FROM, voice: (await getConfig()).voice.provider }));
  await step('mail', async () => {
    if (brevoEnabled()) {
      const r = await withTimeout(fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' } }), 10000);
      if (!r.ok) throw new Error('Brevo key rejected: ' + r.status);
      return 'Brevo ok';
    }
    await mailer().verify();
    return 'SMTP ok';
  });
  await step('voices', async () => (await listVoices('he-IL')).map((v) => v.name).join(', '));
  await step('gemini', async () => { const res = await gen({ model: (await getConfig()).model, contents: 'ענה במילה אחת: שלום' }); return res.text; });
  await step('tts', async () => (await synth('שלום', { name: 'he-IL-Wavenet-A' })).length + ' bytes');
  await step('song', async () => (await makeSong('short calm piano melody')).buf.length + ' bytes');
  await step('yemot_upload', async () => { await uploadWav(await synth('בדיקה', { name: 'he-IL-Wavenet-A' }), '/ApiAudio/test_upload.wav'); return 'uploaded'; });
  r.json(out);
});
// אתר הניהול מתחבר לכאן

const router = YemotRouter({
  printLog: true,
  uncaughtErrorHandler: async (err, call) => {
    console.error('CALL ERROR:', err && err.message);
    try { return await call.id_list_message([{ type: 'text', data: ym('אירעה תקלה אנא נסו שוב מאוחר יותר') }]); }
    catch (e) { console.error('ERROR HANDLER FAILED:', e && e.message); }
  }});

// הופך טקסט להודעה שימות יכולה להשמיע, בקול של גוגל או בקול המובנה
async function toMessages(cfg, text, callId, n) {
  text = cleanForSpeech(text);
  if (cfg.voice.provider === 'google') {
    try {
      const path = `/ApiAudio/${callId}_${n}`;
      // מסנתזים ישירות ב-8kHz, כמו הטלפון, כדי למנוע איכות מדולדלת מהמרה
      await withTimeout((async () => { await uploadWav(await synth(text, cfg.voice, { rate: 8000 }), `${path}.wav`); })(), 15000);
      console.log('GOOGLE VOICE OK', path);
      return [{ type: 'file', data: path }];
    } catch (e) { console.error('GOOGLE VOICE FAILED, using Yemot voice:', e.message); }
  }
  return [{ type: 'text', data: ym(text) }];
}

// ---------------- הקלטה ותמלול (בלי יחידות זיהוי דיבור של ימות) ----------------
const ymToken = () => yemotCred();

async function downloadRecording(pathsToTry) {
  // ימות לפעמים שומרת את ההקלטה אחרי כמה רגעים, לכן מנסים עד 3 פעמים עם המתנה
  for (let attempt = 0; attempt < 3; attempt++) {
  for (const p of pathsToTry.filter(Boolean)) {
    try {
      const url = 'https://www.call2all.co.il/ym/api/DownloadFile?' + new URLSearchParams({ token: ymToken(), path: 'ivr2:' + p });
      const r = await withTimeout(fetch(url), 8000);
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && buf.length > 200 && !(buf[0] === 0x7b)) return { buf, p };   // 0x7b = '{' כלומר תשובת שגיאה בפורמט JSON
      console.error('DOWNLOAD not a file for', p, 'status', r.status, 'bytes', buf.length, buf.length < 400 ? buf.toString('utf8') : '');
    } catch (e) { console.error('DOWNLOAD failed for', p, e.message); }
  }
  await sleep(1500);
  }
  return null;
}

async function deleteRecording(p) {
  try {
    const url = 'https://www.call2all.co.il/ym/api/FileAction?' + new URLSearchParams({ token: ymToken(), action: 'delete', what: 'ivr2:' + p });
    await withTimeout(fetch(url), 5000);
  } catch (e) { /* לא קריטי */ }
}

async function transcribeGemini(buf, cfg) {
  const res = await withTimeout(gen({
    model: cfg.model,
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'audio/wav', data: buf.toString('base64') } },
      { text: 'תמלל במדויק את הדיבור בעברית שבהקלטה. ההקלטה מטלפון, לכן האיכות נמוכה. התעלם מהיסוסים, הפסקות ומילות מילוי, ואל תכתוב אותם. אם המשפט נשמע חלקי, תמלל את מה שנשמע בלי להשלים ובלי להמציא. החזר רק את הטקסט המתומלל, בלי הסברים ובלי מרכאות. אם אין דיבור ברור החזר בדיוק את המילה EMPTY' }
    ] }],
    config: { temperature: 0, maxOutputTokens: 200 }
  }), 15000);
  const t = (res.text || '').trim();
  return (!t || /^EMPTY\b/i.test(t)) ? '' : t;
}

async function transcribeGoogle(buf) {
  const project = process.env.GOOGLE_CLOUD_PROJECT || creds?.project_id;
  if (!project) throw new Error('חסר project id ל-Speech');
  const [resp] = await withTimeout(speechClient.recognize({
    recognizer: `projects/${project}/locations/${SPEECH_LOCATION}/recognizers/_`,
    config: { autoDecodingConfig: {}, model: SPEECH_MODEL, languageCodes: ['he-IL'] },
    content: buf
  }), 15000);
  return (resp.results || []).map((r) => r.alternatives?.[0]?.transcript || '').join(' ').trim();
}

// ראשית זיהוי הדיבור של גוגל. אם הוא נכשל, עוברים ל-Gemini. SPEECH_ENGINE=gemini מכבה את גוגל
async function transcribe(buf, cfg) {
  if (process.env.SPEECH_ENGINE !== 'gemini') {
    try {
      const t = await transcribeGoogle(buf);
      console.log('SPEECH ENGINE: google');
      return t;
    } catch (e) {
      console.error('GOOGLE SPEECH FAILED, falling back to Gemini:', e.message);
    }
  }
  console.log('SPEECH ENGINE: gemini');
  return transcribeGemini(buf, cfg);
}

// ---------------- זיכרון שיחות לכל מספר (נפרד לכל משתמש) ----------------
const memKey = (phone) => `${currentTenant().id}_${norm(phone)}`;

async function loadMemory(phone) {
  if (!norm(phone) || process.env.LOCAL_CONFIG) return [];
  try {
    const s = await withTimeout((await db()).collection('callers').doc(memKey(phone)).get(), 3000);
    return s.exists ? (s.data().turns || []) : [];
  } catch (e) { console.error('MEMORY LOAD FAILED:', e.message); return []; }
}

// שומר את 30 ההודעות האחרונות (טקסט בלבד)
async function saveMemory(phone, history) {
  if (!norm(phone) || process.env.LOCAL_CONFIG) return;
  const key = memKey(phone);
  const turns = history
    .map((h) => ({ role: h.role, parts: (h.parts || []).filter((x) => x.text).map((x) => ({ text: x.text })) }))
    .filter((h) => h.parts.length)
    .slice(-30);
  try {
    await withTimeout((await db()).collection('callers').doc(key).set({ turns, updatedAt: new Date().toISOString() }), 5000);
  } catch (e) { console.error('MEMORY SAVE FAILED:', e.message); }
}

// ---------------- שלוחת הצ'אט ----------------
router.get('/chat', async (call) => {
  console.log('CALL START', call.phone);
  const cfg = await getConfig();
  const say = (t) => call.id_list_message([{ type: 'text', data: ym(t) }]);

  if (!cfg.enabled) { await say(cfg.closedMessage); return call.hangup(); }
  if (!isAllowed(cfg, call.phone)) { await say(cfg.deniedMessage); return call.hangup(); }
  if (!isOpen(cfg)) { await say(cfg.closedMessage); return call.hangup(); }
  if (!(await countCall(currentTenant().id, currentTenant().doc?.dailyCallLimit))) { await say(cfg.closedMessage); return call.hangup(); }

  const callId = randomUUID().slice(0, 8);
  const ctx = { call, assets: new Map(), ended: false, mailCount: 0 };
  const history = await loadMemory(call.phone);
  const started = Date.now();
  let n = 0, silent = 0;
  let prompt = await toMessages(cfg, [cfg.consentMessage, cfg.greeting, cfg.endHint].filter(Boolean).join(' '), callId, n++);

  while (true) {
    // ההשמעה והאזנה באותה בקשה, כדי לחסוך זמן תגובה
    const fname = `${callId}_${n}`;
    const rec = await call.read(prompt, 'record', { path: '/ApiRecords', file_name: fname, no_confirm_menu: true, max_length: 40, min_length: 1, quiet_max: 4, ...(process.env.QUIET_ENGINE === 'yes' ? { use_records_recognition_engine: true } : {}) });
    console.log('RECORD RETURNED:', JSON.stringify(rec));
    let text = '';
    const got = await downloadRecording([`/ApiRecords/${fname}.wav`, typeof rec === 'string' ? (rec.startsWith('/') ? rec : '/' + rec) : '']);
    if (got) {
      try { text = await transcribe(got.buf, cfg); } catch (e) { console.error('TRANSCRIBE FAILED:', e.message); }
      deleteRecording(got.p);
    }
    console.log('HEARD:', JSON.stringify(text));

    if (!text) {
      if (++silent >= 3) break;
      prompt = await toMessages(cfg, silent === 1 ? 'אני כאן, אפשר לדבר.' : 'לא שמעתי אותך, אתה עדיין שם?', callId, n++);
      continue;
    }
    silent = 0;
    history.push({ role: 'user', parts: [{ text }] });

    const reply = await respond(history, cfg, ctx);
    saveMemory(call.phone, history);
    console.log('REPLY:', reply);
    if (ctx.ended || Date.now() - started > cfg.maxMinutes * 60000) {
      await call.id_list_message(await toMessages(cfg, reply || cfg.goodbye, callId, n++));
      return call.hangup();
    }
    prompt = await toMessages(cfg, reply, callId, n++);
  }
  await call.id_list_message(await toMessages(cfg, cfg.goodbye, callId, n++));
  return call.hangup();
});

// ---------------- שלוחת הגדרות בטלפון (מוגנת ב-PIN) ----------------
router.get('/admin', async (call) => {
  const pin = await call.read([{ type: 'text', data: 'הקישו קוד סודי' }], 'tap', { max_digits: 12, min_digits: 1 });
  if (!process.env.ADMIN_PIN || pin !== process.env.ADMIN_PIN) { await call.id_list_message([{ type: 'text', data: 'קוד שגוי' }]); return call.hangup(); }
  const cfg = await getConfig();
  const choice = await call.read([{ type: 'text', data: ym(
    `למצב פעיל או כבוי הקישו 1. לתפקיד הקישו 2. לקול הקישו 3. לסגנון דיבור הקישו 4. לניקוד הקישו 5. ליצירת שירים וסרטונים הקישו 6. כרגע השירות ${cfg.enabled ? 'פעיל' : 'כבוי'}`) }], 'tap', { max_digits: 1, min_digits: 1 });

  if (choice === '1') {
    await saveConfig({ enabled: !cfg.enabled });
    await call.id_list_message([{ type: 'text', data: cfg.enabled ? 'השירות כובה' : 'השירות הופעל' }]);
  }

  if (choice === '2') {
    const ids = Object.keys(PRESETS);
    const menu = ids.map((id, i) => `${PRESETS[id].label} הקישו ${i + 1}`).join('. ');
    const c = await call.read([{ type: 'text', data: ym(menu) }], 'tap', { max_digits: 1, min_digits: 1 });
    const id = ids[Number(c) - 1];
    if (id) { await saveConfig({ role: id }); await call.id_list_message([{ type: 'text', data: 'התפקיד עודכן' }]); }
  }

  if (choice === '3') {
    const PER = 8;
    let page = 0, picked = null;
    while (!picked) {
      const items = VOICES.slice(page * PER, page * PER + PER);
      const more = (page + 1) * PER < VOICES.length;
      const menu = items.map((v, i) => `${v.label} הקישו ${i + 1}`).join('. ') + (more ? '. לקולות נוספים הקישו 9' : '');
      const c = await call.read([{ type: 'text', data: ym(menu) }], 'tap', { max_digits: 1, min_digits: 1 });
      if (c === '9' && more) { page++; continue; }
      const idx = Number(c) - 1;
      if (idx >= 0 && idx < items.length) picked = items[idx];
      else break;
    }
    if (picked) {
      await saveConfig({ voice: { ...cfg.voice, name: picked.name, provider: 'google' } });
      await call.id_list_message([{ type: 'text', data: 'הקול עודכן' }]);
    }
  }

  if (choice === '4') {
    const keys = Object.keys(STYLES);
    const menu = keys.map((k, i) => `${STYLE_LABELS[k]} הקישו ${i + 1}`).join('. ');
    const c = await call.read([{ type: 'text', data: ym(menu) }], 'tap', { max_digits: 1, min_digits: 1 });
    const k = keys[Number(c) - 1];
    if (k) { await saveConfig({ style: k }); await call.id_list_message([{ type: 'text', data: 'הסגנון עודכן' }]); }
  }

  if (choice === '6') {
    const c = await call.read([{ type: 'text', data: ym('להפעלת יצירת שירים וסרטונים הקישו 1, לכיבוי הקישו 2') }], 'tap', { max_digits: 1, min_digits: 1 });
    if (c === '1' || c === '2') {
      await saveConfig({ tools: { ...cfg.tools, music: c === '1', video: c === '1' } });
      await call.id_list_message([{ type: 'text', data: 'ההגדרה עודכנה' }]);
    }
  }

  if (choice === '5') {
    const c = await call.read([{ type: 'text', data: ym('ניקוד מלא הקישו 1. בלי ניקוד הקישו 2') }], 'tap', { max_digits: 1, min_digits: 1 });
    if (c === '1' || c === '2') {
      await saveConfig({ useNikud: c === '1' });
      await call.id_list_message([{ type: 'text', data: 'ההגדרה עודכנה' }]);
    }
  }

  return call.hangup();
});

// ---------------- ה-API של המשתמש (לאתר הניהול) ----------------
const tenantApi = express.Router();

tenantApi.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.ADMIN_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const tok = (req.get('Authorization') || '').replace('Bearer ', '');
  if (!checkTenantToken(currentTenant(), tok)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

tenantApi.get('/status', async (_q, r) => {
  const t = currentTenant();
  r.json({
    id: t.id, name: t.doc.name,
    yemotNumberSet: !!t.doc.yemotNumber, yemotPasswordSet: !!t.doc.yemotPassword,
    brevoKeySet: !!t.doc.brevoApiKey, mailFrom: t.doc.mailFrom || null,
    callsToday: await usageToday(t.id), dailyCallLimit: t.doc.dailyCallLimit || 200
  });
});
tenantApi.get('/config', async (_q, r) => r.json(await getConfig()));
tenantApi.put('/config', async (q, r) => r.json(await saveConfig(pickConfig(q.body || {}))));
tenantApi.put('/secrets', async (q, r) => {
  const patch = {};
  for (const k of ['yemotNumber', 'yemotPassword', 'brevoApiKey', 'mailFrom']) {
    if (typeof q.body?.[k] === 'string') patch[k] = q.body[k].trim();
  }
  await updateTenant(currentTenant().id, patch);
  Object.assign(currentTenant().doc, patch);
  r.json({ ok: true });
});
tenantApi.get('/options', (_q, r) => r.json({
  presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
  styles: Object.keys(STYLES),
  voices: VOICES
}));
tenantApi.post('/tts-preview', async (q, r) => {
  const v = VOICES.find((x) => x.name === q.body?.voice);
  if (!v) return r.status(400).json({ error: 'unknown voice' });
  const buf = await synth(String(q.body?.text || 'שלום, כך אני נשמע.').slice(0, 300), { name: v.name, speakingRate: 1.0 }, { encoding: 'MP3' });
  r.json({ mime: 'audio/mpeg', base64: buf.toString('base64') });
});
// מחיקת הזיכרון של מספר מסוים (לבקשת מתקשר, ולפי מדיניות הפרטיות)
tenantApi.delete('/memory/:phone', async (q, r) => {
  await (await db()).collection('callers').doc(`${currentTenant().id}_${norm(q.params.phone)}`).delete();
  r.json({ ok: true });
});

app.use('/tapi', tenantApi);
app.use('/', router);
app.listen(process.env.PORT || 8080, () => console.log('STARTED', JSON.stringify({ credsOk: !!creds, apiKey: !!apiKey, adminTokenLength: (process.env.ADMIN_TOKEN || '').length })));
