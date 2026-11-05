import express from 'express';
import { YemotRouter } from 'yemot-router2';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
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
  tools: { email: true, fax: false, images: true, music: true, video: true, files: true, transfer: false, outbound: false },
  model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  maxMinutes: 10,
  useNikud: false,
  consentMessage: '',
  endHint: '',
  humanNumber: '',            // מספר הנציג האנושי להעברת שיחה
  chatNumber: '',            // מספר הצ'אט לשיחות יוצאות (אם נבחר)
  outboundCaller: 'system',  // system | chat
  summaryMode: 'off',        // off | every
  summaryTo: ''              // כתובת לסיכומי שיחות
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
    video: !!b.tools.video,
    files: !!b.tools.files,
    transfer: !!b.tools.transfer,
    outbound: !!b.tools.outbound
  };
  if (typeof b.summaryTo === 'string' && (b.summaryTo.trim() === '' || EMAIL_RE.test(b.summaryTo.trim()))) out.summaryTo = b.summaryTo.trim();
  if (['off', 'every'].includes(b.summaryMode)) out.summaryMode = b.summaryMode;
  if (typeof b.humanNumber === 'string') out.humanNumber = norm(b.humanNumber);
  if (typeof b.chatNumber === 'string') out.chatNumber = norm(b.chatNumber);
  if (['system', 'chat'].includes(b.outboundCaller)) out.outboundCaller = b.outboundCaller;
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
  const T = cfg.tools || {};
  const d = [{
    name: 'end_call',
    description: 'סיום השיחה בנימוס, רק אחרי שהמתקשר סיים ונפרדתם.',
    parameters: { type: 'OBJECT', properties: {} }
  }];
  if (T.email || T.fax) d.push({
    name: 'ask_email_by_keypad',
    description: 'מבקש מהמתקשר להקליד כתובת מייל במקלדת הטלפון. אמין יותר מהכתבה בקול. השתמש כשצריך כתובת מייל, או כשהזיהוי הקולי של הכתובת לא ברור.',
    parameters: { type: 'OBJECT', properties: {} }
  });
  if (T.email) d.push({
    name: 'send_email',
    description: 'שולח מייל לכתובת שהמתקשר הקליד או אמר. קרא לפונקציה רק אחרי שהמתקשר אישר את הכתובת ואת התוכן.',
    parameters: { type: 'OBJECT', properties: {
      to: { type: S, description: 'כתובת הנמען' },
      subject: { type: S }, body: { type: S, description: 'גוף המייל המלא' },
      attachment_ids: { type: 'ARRAY', items: { type: S }, description: 'מזהי תמונות שנוצרו בשיחה' }
    }, required: ['to', 'subject', 'body'] }
  });
  if (T.fax) d.push({
    name: 'send_fax',
    description: 'שולח פקס. קרא רק אחרי שהמתקשר אישר את המספר ואת התוכן.',
    parameters: { type: 'OBJECT', properties: {
      fax_number: { type: S }, subject: { type: S }, body: { type: S }
    }, required: ['fax_number', 'body'] }
  });
  if (T.music) d.push({
    name: 'create_song',
    description: 'יוצר שיר שלם בעברית, עם מילים ושירה. השיר נוצר ברקע ונשלח למייל בעוד כמה דקות. קרא רק אחרי שהמתקשר ביקש שיר, אישר את הנושא, את האורך ואת כתובת המייל.',
    parameters: { type: 'OBJECT', properties: {
      topic: { type: S, description: 'נושא השיר בדיוק כפי שהמתקשר אמר אותו, בעברית. אסור לשנות, להוסיף או להחליף נושא' },
      style: { type: S, description: 'סגנון מוזיקלי אם המתקשר ציין, למשל פופ, שירי ילדים, מזרחית או רוק. אופציונלי' },
      lyrics: { type: S, description: 'מילים שהמתקשר הכתיב במדויק, אם הכתיב. אופציונלי' },
      duration: { type: 'INTEGER', description: 'אורך השיר בשניות, בין 30 ל-180. קצר כ-60, בינוני כ-120, ארוך כ-180' },
      to: { type: S, description: 'כתובת המייל לשליחת השיר' }
    }, required: ['topic', 'to'] }
  });
  if (T.video) d.push({
    name: 'create_video',
    description: 'יוצר סרטון קצר (כ-8 שניות). הסרטון לוקח כמה דקות, ולכן הוא נשלח למייל בנפרד, לא בשיחה. קרא רק אחרי שהמתקשר אישר את התיאור ואת כתובת המייל.',
    parameters: { type: 'OBJECT', properties: {
      prompt: { type: S, description: 'תיאור הסרטון באנגלית: מה רואים, איך זה זז, סגנון. שמור על הנושא שהמתקשר ביקש' },
      to: { type: S, description: 'כתובת המייל לשליחה' }
    }, required: ['prompt', 'to'] }
  });
  if (T.images) d.push({
    name: 'generate_image',
    description: 'יוצר תמונה לפי תיאור. מחזיר asset_id שאפשר לצרף למייל.',
    parameters: { type: 'OBJECT', properties: { prompt: { type: S, description: 'תיאור התמונה, באנגלית עדיף' } }, required: ['prompt'] }
  });
  if (T.files) {
    d.push({
      name: 'create_file',
      description: 'יוצר קובץ בעברית: וורד (docx), פי די אף (pdf) או אקסל (xlsx). אם המתקשר ביקש לשלוח למייל, העבר את כתובתו ב-to. אחרת הקובץ נשמר לשיחה הבאה ואפשר לשלוח אותו אחר כך עם send_file.',
      parameters: { type: 'OBJECT', properties: {
        format: { type: S, description: 'docx, pdf או xlsx' },
        title: { type: S, description: 'כותרת הקובץ' },
        request: { type: S, description: 'מה צריך להיות בקובץ, בפירוט, לפי מה שהמתקשר אמר' },
        to: { type: S, description: 'כתובת מייל לשליחה, אופציונלי' }
      }, required: ['format', 'request'] }
    });
    d.push({
      name: 'send_file',
      description: 'שולח למייל קובץ שנוצר קודם בשיחה. אם הקובץ גדול מדי למייל, נשלח קישור להורדה.',
      parameters: { type: 'OBJECT', properties: {
        file_id: { type: S, description: 'המזהה של הקובץ' },
        to: { type: S, description: 'כתובת המייל' }
      }, required: ['file_id', 'to'] }
    });
  }
  if (T.files || T.music || T.video || T.images) d.push({
    name: 'update_creation',
    description: 'מתקן יצירה קודמת (קובץ, שיר, סרטון או תמונה) לפי מה שהמתקשר ביקש לשנות. בקובץ משנה רק את החלקים שביקשו, בלי ליצור הכול מחדש. שיר או סרטון מתוקנים נשלחים למייל אם יש כתובת.',
    parameters: { type: 'OBJECT', properties: {
      id: { type: S, description: 'המזהה של היצירה לתיקון' },
      changes: { type: S, description: 'מה לשנות, בדיוק כפי שהמתקשר ביקש' },
      to: { type: S, description: 'כתובת מייל לשליחה, אופציונלי' }
    }, required: ['id', 'changes'] }
  });
  if (T.transfer && norm(cfg.humanNumber)) d.push({
    name: 'transfer_to_human',
    description: 'מעביר את השיחה לנציג אנושי. קרא רק כשהמתקשר ביקש במפורש לדבר עם אדם. לפני הקריאה אמור למתקשר משפט קצר שאתה מעביר אותו.',
    parameters: { type: 'OBJECT', properties: {} }
  });
  if (T.outbound) d.push({
    name: 'call_phone',
    description: 'מתקשר ליעד מסוים בשם המערכת. קרא רק אחרי שהמתקשר אישר במפורש את המספר ואת הסיבה לשיחה.',
    parameters: { type: 'OBJECT', properties: {
      to_phone: { type: S, description: 'מספר הטלפון ביעד, כמו 0501234567' },
      purpose: { type: S, description: 'מטרת השיחה, לתיעוד' }
    }, required: ['to_phone'] }
  });
  return d;
}

// ---------- קבצים: יצירה, תיקון ושליחה (וורד, פי די אף, אקסל) ----------
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const BLOCK_TYPES = ['h1', 'h2', 'p', 'bullet', 'table'];

function sanitizeBlock(b) {
  const out = { type: BLOCK_TYPES.includes(b?.type) ? b.type : 'p', text: String(b?.text ?? '').slice(0, 5000) };
  if (Array.isArray(b?.rows)) out.rows = b.rows.slice(0, 200).map((r) => (Array.isArray(r) ? r.slice(0, 30).map((c) => String(c ?? '').slice(0, 500)) : [String(r ?? '')]));
  return out;
}

function parseJsonLoose(s) {
  const t = String(s || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch (e) { /* ננסה לחלץ */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* לא תקין */ } }
  return null;
}

async function generateBlocks(request, format, cfg) {
  const res = await withTimeout(gen({
    model: cfg.model,
    contents: `צור תוכן בעברית לקובץ מסוג ${format}, לפי הבקשה הבאה: ${request}\nהחזר JSON בלבד, בלי הסברים ובלי סימוני markdown, במבנה: {"title":"כותרת הקובץ","blocks":[{"type":"h1","text":"..."},{"type":"p","text":"..."},{"type":"bullet","text":"..."},{"type":"table","rows":[["כותרת עמודה","כותרת נוספת"],["ערך","ערך"]]}]}\nסוגי הבלוקים: h1 כותרת ראשית, h2 כותרת משנה, p פסקה, bullet פריט ברשימה, table טבלה עם rows בלבד, כשהשורה הראשונה בה היא הכותרות. באקסל כל טבלה הופכת לגיליון, לכן שים נתונים בטבלאות.`,
    config: { temperature: 0.4, maxOutputTokens: 16000, responseMimeType: 'application/json' }
  }), 90000);
  const j = parseJsonLoose(res.text);
  if (!j || !Array.isArray(j.blocks) || !j.blocks.length) throw new Error('לא נוצר תוכן לקובץ');
  return { title: String(j.title || '').slice(0, 100), blocks: j.blocks.slice(0, 300).map(sanitizeBlock) };
}

// מחזיר רשימת פעולות לתיקון. כך משנים רק את מה שביקשו ולא יוצרים את כל הקובץ מחדש
async function patchBlocks(blocks, changes, cfg) {
  const res = await withTimeout(gen({
    model: cfg.model,
    contents: `לפניך מסמך כרשימת בלוקים (blocks) בפורמט JSON:\n${JSON.stringify(blocks)}\n\nהשינוי שהמתקשר ביקש:\n${changes}\n\nהחזר JSON בלבד במבנה {"ops":[{"op":"replace","index":N,"block":{...}},{"op":"insert","index":N,"block":{...}},{"op":"delete","index":N}]}. index הוא המיקום בתוך blocks, מ-0. שנה רק את מה שביקשו, ואל תחזיר את כל המסמך.`,
    config: { temperature: 0.2, maxOutputTokens: 4000, responseMimeType: 'application/json' }
  }), 60000);
  const j = parseJsonLoose(res.text);
  return Array.isArray(j?.ops) ? j.ops : [];
}

function applyOps(blocks, ops) {
  const out = blocks.slice();
  for (const o of ops || []) {
    const i = Number(o.index);
    if (!Number.isInteger(i) || i < 0) continue;
    if (o.op === 'delete' && i < out.length) out.splice(i, 1);
    else if (o.op === 'replace' && i < out.length && o.block) out[i] = sanitizeBlock(o.block);
    else if (o.op === 'insert' && i <= out.length && o.block) out.splice(i, 0, sanitizeBlock(o.block));
  }
  return out;
}

// הופך טקסט עברי לסדר ויזואלי עבור PDF, שאין בו תמיכה מובנית ב-RTL. קירוב סביר לעברית רגילה
function visualHebrew(line) {
  const runs = String(line).match(/[\u0590-\u05FF]+|[^\u0590-\u05FF]+/g) || [];
  return runs.reverse().map((r) => (/[\u0590-\u05FF]/.test(r) ? [...r].reverse().join('') : r)).join('');
}

async function renderDocx(title, blocks) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } = await import('docx');
  const rtl = (text, extra = {}) => new Paragraph({
    bidirectional: true, alignment: AlignmentType.RIGHT, ...extra,
    children: [new TextRun({ text, rightToLeft: true })]
  });
  const children = [rtl(title, { heading: HeadingLevel.TITLE })];
  for (const b of blocks) {
    if (b.type === 'h1') children.push(rtl(b.text, { heading: HeadingLevel.HEADING_1 }));
    else if (b.type === 'h2') children.push(rtl(b.text, { heading: HeadingLevel.HEADING_2 }));
    else if (b.type === 'bullet') children.push(new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, bullet: { level: 0 }, children: [new TextRun({ text: b.text, rightToLeft: true })] }));
    else if (b.type === 'table' && b.rows?.length) {
      const rows = b.rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [rtl(String(c ?? ''))] })) }));
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph({ children: [] }));
    } else children.push(rtl(b.text || ''));
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

async function renderXlsx(title, blocks) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.title = title;
  const tables = blocks.filter((b) => b.type === 'table' && b.rows?.length);
  const texts = blocks.filter((b) => b.type !== 'table' && b.text);
  if (texts.length || !tables.length) {
    const ws = wb.addWorksheet('טקסט');
    ws.views = [{ rightToLeft: true }];
    [title, ...texts.map((b) => b.text)].forEach((t) => ws.addRow([t]));
  }
  tables.forEach((t, i) => {
    const ws = wb.addWorksheet(`טבלה ${i + 1}`);
    ws.views = [{ rightToLeft: true }];
    t.rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function renderPdf(title, blocks) {
  const PDFDocument = (await import('pdfkit')).default;
  // בלי פונט עברי, PDF מציג עברית כריבועים או כלום. מומלץ לשים קובץ TTF בתיקיה fonts בפרויקט
  const fontPath = process.env.HEBREW_FONT_PATH || './fonts/NotoSansHebrew-Regular.ttf';
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
  if (fontPath && fs.existsSync(fontPath)) doc.font(fontPath);
  else console.error('NO HEBREW FONT FOUND, PDF Hebrew text will be broken. Path tried:', fontPath);
  const W = doc.page.width - 100;
  const para = (text, size) => {
    doc.fontSize(size);
    const out = [];
    let line = '';
    for (const w of String(text).split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${w}` : w;
      if (line && doc.widthOfString(cand) > W) { out.push(line); line = w; } else line = cand;
    }
    if (line) out.push(line);
    for (const l of (out.length ? out : [''])) doc.text(visualHebrew(l), 50, doc.y, { width: W, align: 'right' });
    doc.moveDown(0.4);
  };
  para(title, 20);
  for (const b of blocks) {
    if (b.type === 'h1') para(b.text, 16);
    else if (b.type === 'h2') para(b.text, 13);
    else if (b.type === 'bullet') para(`• ${b.text}`, 11);
    else if (b.type === 'table') for (const r of b.rows || []) para(r.join(' | '), 10);
    else para(b.text || '', 11);
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

async function renderFile(format, title, blocks) {
  if (format === 'docx') return renderDocx(title, blocks);
  if (format === 'xlsx') return renderXlsx(title, blocks);
  return renderPdf(title, blocks);
}

// קובץ גדול מדי למייל נשמר באחסון ונשלח כקישור חתום. דורש FILES_BUCKET
async function uploadForLink(buf, name, mime) {
  if (!process.env.FILES_BUCKET) return null;
  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage(creds ? { projectId: creds.project_id, credentials: creds } : {});
  const file = storage.bucket(process.env.FILES_BUCKET).file(`${currentTenant().id}/${Date.now()}_${name}`);
  await file.save(buf, { contentType: mime, resumable: false });
  const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 7 * 24 * 3600 * 1000 });
  return url;
}

async function deliverFile(f, to) {
  const buf = await renderFile(f.format, f.title, f.blocks);
  const name = `${f.id}.${f.format}`;
  let text = `שלום, מצורף הקובץ שביקשתם בשיחה טלפונית: ${f.title}.`;
  let attachments = [];
  let result;
  if (buf.length <= MAIL_MAX) {
    attachments = [{ filename: name, content: buf, contentType: MIME[f.format] }];
    result = 'נשלח כקובץ מצורף';
  } else {
    const link = await uploadForLink(buf, name, MIME[f.format]).catch((e) => { console.error('LINK UPLOAD FAILED', e.message); return null; });
    if (link) {
      text += `\n\nהקובץ גדול מדי למייל. אפשר להוריד אותו מכאן, הקישור תקף 7 ימים:\n${link}`;
      result = 'נשלח קישור להורדה';
    } else {
      text += '\n\nהקובץ גדול מדי למייל, ולא הוגדר מקום לשמירה להורדה.';
      result = 'הקובץ גדול מדי ולא נשלח';
    }
  }
  await sendMail({ to, subject: f.title || 'קובץ', text, attachments });
  return result;
}

async function sendFileTo(f, to, ctx) {
  if (!EMAIL_RE.test(to)) return { error: 'כתובת המייל לא תקינה' };
  if ((ctx.mailCount || 0) >= MAX_MAILS_PER_CALL) return { error: 'הגעתם למגבלת המיילים לשיחה הזו' };
  ctx.mailCount = (ctx.mailCount || 0) + 1;
  try { return { sent: true, note: await deliverFile(f, to) }; }
  catch (e) { console.error('FILE MAIL FAILED:', e.message); return { error: 'שליחת הקובץ נכשלה: ' + e.message }; }
}

// ---------- שירים ----------
function buildSongPrompt(topic, style, lyrics) {
  return [
    `שיר בעברית בלבד. הנושא של השיר הוא בדיוק: ${topic}. אסור לשנות, להחליף או להוסיף נושא אחר.`,
    style ? `סגנון מוזיקלי: ${style}.` : '',
    lyrics ? `השתמשו במילים האלה כמו שהן: ${lyrics}` : 'כתבו מילים בעברית על הנושא הזה בלבד.'
  ].filter(Boolean).join(' ');
}

// מבקש מ-Gemini לשנות רק את השדות שהשינוי נוגע בהם
async function reviseSpec(spec, changes, cfg) {
  const res = await withTimeout(gen({
    model: cfg.model,
    contents: `לפניך מפרט של יצירה בפורמט JSON: ${JSON.stringify(spec)}\nהמתקשר ביקש לשנות: ${changes}\nהחזר JSON בלבד עם אותם שדות, כשרק השדות שהשינוי נוגע בהם השתנו. בשיר שמור על שירה בעברית ועל הנושא, אלא אם ביקש במפורש לשנות אותו. בסרטון ובתמונה השדה prompt הוא באנגלית.`,
    config: { temperature: 0.4, maxOutputTokens: 1500, responseMimeType: 'application/json' }
  }), 30000);
  return { ...spec, ...(parseJsonLoose(res.text) || {}) };
}

// ---------- הכלים שהמודל יכול לקרוא להם ----------
async function runTool(name, args, ctx) {
  switch (name) {
    case 'end_call':
      ctx.ended = true;
      return { ok: true };

    case 'transfer_to_human': {
      if (!ctx.cfg.tools.transfer || !norm(ctx.cfg.humanNumber)) return { error: 'העברה לנציג לא מוגדרת' };
      ctx.transferTo = norm(ctx.cfg.humanNumber);
      return { ok: true, note: 'ההעברה מוכנה. אמור למתקשר שאתה מעביר אותו' };
    }

    case 'call_phone': {
      if (!ctx.cfg.tools.outbound) return { error: 'שיחות יוצאות לא מופעלות' };
      const to = norm(args.to_phone);
      if (!/^0\d{8,9}$/.test(to)) return { error: 'מספר הטלפון לא תקין' };
      const r = await dialOut(to, ctx.cfg);
      return r.ok ? { started: true, note: 'החיוג נשלח' } : { error: r.error };
    }

    case 'ask_email_by_keypad': {
      const v = await ctx.call.read(
        [{ type: 'text', data: ym('אנא הקלידו את כתובת המייל במקלדת ובסיום הקישו סולמית') }],
        'tap', { typing_playback_mode: 'EmailKeyboard', max_digits: 80, min_digits: 5, sec_wait: 30 });
      return { email: String(v || '').trim() };
    }

    case 'generate_image': {
      const r = await withTimeout(gen({
        model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image', contents: args.prompt }), 90000);
      const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) return { error: 'לא נוצרה תמונה' };
      const id = randomUUID().slice(0, 8);
      ctx.assets.set(id, { mime: part.inlineData.mimeType, data: Buffer.from(part.inlineData.data, 'base64') });
      ctx.creations.set(id, { id, kind: 'image', prompt: String(args.prompt || '').slice(0, 500), createdAt: new Date().toISOString() });
      return { asset_id: id };
    }

    case 'create_file': {
      const format = String(args.format || '').toLowerCase().trim().replace(/^\./, '');
      if (!MIME[format]) return { error: 'אפשר ליצור וורד, פי די אף או אקסל בלבד' };
      const request = String(args.request || '').trim().slice(0, 4000);
      if (!request) return { error: 'חסר תיאור של תוכן הקובץ' };
      const to = String(args.to || '').trim();
      if (to && !EMAIL_RE.test(to)) return { error: 'כתובת המייל לא תקינה. בקש מהמתקשר להקליד אותה במקלדת' };
      const made = await generateBlocks(request, format, ctx.cfg);
      const id = randomUUID().slice(0, 8);
      const f = { id, kind: 'doc', format, title: String(args.title || made.title || 'מסמך').slice(0, 100), blocks: made.blocks, createdAt: new Date().toISOString() };
      ctx.creations.set(id, f);
      if (!to) return { file_id: id, title: f.title, note: 'הקובץ מוכן. אפשר לשלוח אותו למייל' };
      return { file_id: id, title: f.title, ...(await sendFileTo(f, to, ctx)) };
    }

    case 'send_file': {
      const f = ctx.creations.get(String(args.file_id || '').trim());
      if (!f || f.kind !== 'doc') return { error: 'לא מצאתי קובץ כזה. בקש מהמתקשר לומר איזה קובץ לשלוח' };
      return sendFileTo(f, String(args.to || '').trim(), ctx);
    }

    case 'update_creation': {
      const c = ctx.creations.get(String(args.id || '').trim());
      if (!c) return { error: 'לא מצאתי יצירה כזו. בקש מהמתקשר לומר איזו יצירה לתקן' };
      const changes = String(args.changes || '').trim().slice(0, 2000);
      if (!changes) return { error: 'לא נאמר מה לשנות' };

      if (c.kind === 'doc') {
        const ops = await patchBlocks(c.blocks, changes, ctx.cfg);
        if (!ops.length) return { error: 'לא זיהיתי מה לשנות בקובץ. אפשר לנסח שוב' };
        c.blocks = applyOps(c.blocks, ops);
        c.updatedAt = new Date().toISOString();
        const to = String(args.to || '').trim();
        if (!to) return { file_id: c.id, updated: true, note: 'הקובץ תוקן. אפשר לשלוח אותו למייל' };
        return { file_id: c.id, updated: true, ...(await sendFileTo(c, to, ctx)) };
      }

      if (c.kind === 'image') {
        const nx = await reviseSpec({ prompt: c.prompt }, changes, ctx.cfg);
        return runTool('generate_image', { prompt: String(nx.prompt || c.prompt) }, ctx);
      }

      const t = currentTenant();
      if (!(await countGeneration(t.id, t.doc?.dailyGenerationLimit))) return { error: 'הגעתם למכסת היצירות להיום' };
      const to = String(args.to || c.to || '').trim();
      if (!EMAIL_RE.test(to)) return { error: 'צריך כתובת מייל לשליחת היצירה המתוקנת' };

      if (c.kind === 'song') {
        const nx = await reviseSpec({ topic: c.topic, style: c.style, lyrics: c.lyrics, duration: c.duration }, changes, ctx.cfg);
        const topic = String(nx.topic || c.topic).slice(0, 400);
        const style = String(nx.style || '').slice(0, 200);
        const lyrics = String(nx.lyrics || '').slice(0, 1500);
        const duration = Math.min(Math.max(Number(nx.duration) || c.duration || SONG_DURATION, 30), 180);
        const id = randomUUID().slice(0, 8);
        ctx.creations.set(id, { id, kind: 'song', topic, style, lyrics, duration, to, createdAt: new Date().toISOString() });
        runSongJob(topic, style, lyrics, ctx.cfg, to, duration).catch((e) => console.error('SONG JOB CRASH', e.message));
        return { file_id: id, started: true, note: 'השיר המתוקן בדרך, הוא יגיע למייל בעוד כמה דקות' };
      }

      if (c.kind === 'video') {
        const nx = await reviseSpec({ prompt: c.prompt }, changes, ctx.cfg);
        const prompt = String(nx.prompt || c.prompt).trim().slice(0, 500);
        const id = randomUUID().slice(0, 8);
        ctx.creations.set(id, { id, kind: 'video', prompt, to, createdAt: new Date().toISOString() });
        runVideoJob(prompt, to).catch((e) => console.error('VIDEO JOB CRASH', e.message));
        return { file_id: id, started: true, note: 'הסרטון המתוקן בדרך, הוא יגיע למייל בעוד כמה דקות' };
      }
      return { error: 'סוג היצירה הזה לא ניתן לתיקון' };
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
      const topic = String(args.topic || args.prompt || '').trim().slice(0, 400);
      if (!topic) return { error: 'חסר נושא לשיר. בקש מהמתקשר לומר על מה השיר' };
      const style = String(args.style || '').trim().slice(0, 200);
      const lyrics = String(args.lyrics || '').trim().slice(0, 1500);
      const duration = Math.min(Math.max(Number(args.duration) || SONG_DURATION, 30), 180);
      const t = currentTenant();
      if (!(await countGeneration(t.id, t.doc?.dailyGenerationLimit))) return { error: 'הגעתם למכסת היצירות להיום' };
      const id = randomUUID().slice(0, 8);
      ctx.creations.set(id, { id, kind: 'song', topic, style, lyrics, duration, to, createdAt: new Date().toISOString() });
      // השיר נוצר ברקע, והשיחה לא מחכה לו
      runSongJob(topic, style, lyrics, ctx.cfg, to, duration).catch((e) => console.error('SONG JOB CRASH', e.message));
      return { file_id: id, started: true, note: 'השיר בדרך, הוא יגיע למייל בעוד כמה דקות' };
    }

    case 'create_video': {
      const to = String(args.to || '').trim();
      if (!EMAIL_RE.test(to)) return { error: 'כתובת המייל לא תקינה. בקש מהמתקשר להקליד אותה במקלדת' };
      const prompt = String(args.prompt || '').trim().slice(0, 500);
      if (!prompt) return { error: 'חסר תיאור לסרטון' };
      const t = currentTenant();
      if (!(await countGeneration(t.id, t.doc?.dailyGenerationLimit))) return { error: 'הגעתם למכסת היצירות להיום' };
      const id = randomUUID().slice(0, 8);
      ctx.creations.set(id, { id, kind: 'video', prompt, to, createdAt: new Date().toISOString() });
      // הסרטון נוצר ברקע, והשיחה לא מחכה לו
      runVideoJob(prompt, to).catch((e) => console.error('VIDEO JOB CRASH', e.message));
      return { file_id: id, started: true, note: 'הסרטון בדרך, הוא יגיע למייל בעוד כמה דקות' };
    }

    default: return { error: 'פונקציה לא מוכרת' };
  }
}

// ===== lib/generate.js: יצירת שירים וסרטונים =====
// שמות המודלים ניתנים לשינוי בהגדרות הסביבה. יש לאמת אותם מול התיעוד של Vertex AI
// lyria-002 מנגן רק בלי שירה. Lyria 3 מייצר שירה עם מילים. Pro עד כ-3 דקות, Clip עד 30 שניות
const MUSIC_MODEL = process.env.LYRIA_MODEL || 'lyria-3-pro-preview';
const VIDEO_MODELS = [...new Set([process.env.VEO_MODEL, 'veo-3.1-generate-001', 'veo-3.1-generate-preview', 'veo-3.0-generate-001', 'veo-3.0-fast-generate-001', 'veo-2.0-generate-001'].filter(Boolean))];
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

// ימות שונה בין גרסאות של Veo ובין אזורים. מנסים את הרשימה לפי הסדר, ועוברים למודל הבא רק כשהמודל לא זמין
const videoAi = vertexMode ? new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || creds?.project_id,
  location: process.env.VIDEO_LOCATION || 'us-central1',
  ...(creds ? { googleAuthOptions: { credentials: creds } } : {})
}) : ai;

async function makeVideo(prompt) {
  const config = { numberOfVideos: 1, durationSeconds: 8 };
  if (process.env.VIDEO_GCS_URI) config.outputGcsUri = process.env.VIDEO_GCS_URI;
  let lastErr = null;
  for (const model of VIDEO_MODELS) {
    try {
      let op = await videoAi.models.generateVideos({ model, prompt, config });
      for (let i = 0; i < 60 && !op.done; i++) { await sleep(10000); op = await videoAi.operations.getVideosOperation({ operation: op }); }
      if (!op.done) throw new Error('יצירת הסרטון ארכה יותר מדי');
      if (op.error) throw new Error(JSON.stringify(op.error).slice(0, 200));
      const v = op.response?.generatedVideos?.[0]?.video;
      if (v?.videoBytes) return { buf: Buffer.from(v.videoBytes, 'base64'), ext: 'mp4', model };
      if (v?.uri?.startsWith('gs://')) throw new Error('הסרטון נשמר ב-GCS ולא הורד. בטל את VIDEO_GCS_URI כדי לקבל את הסרטון ישירות');
      throw new Error('לא נוצר סרטון');
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      // שגיאה שאינה "המודל לא זמין" נזרקת מיד, בלי לנסות מודל אחר
      if (!/404|NOT_FOUND|not found|not supported|unavailable|PERMISSION_DENIED|does not exist|no longer available|not enabled/i.test(msg)) throw e;
      console.error('VIDEO MODEL UNAVAILABLE, trying next:', model, msg.slice(0, 200));
    }
  }
  throw lastErr || new Error('לא נמצא מודל סרטון זמין');
}

// רץ ברקע. ההקשר של הדייר נשמר דרך AsyncLocalStorage, ולכן המייל יוצא מהחשבון הנכון
async function runVideoJob(prompt, to) {
  const subject = 'הסרטון שביקשת';
  const text = `שלום, מצורף הסרטון שביקשתם בשיחה טלפונית.\nהתיאור: ${prompt}`;
  try {
    const file = await makeVideo(prompt);
    await sendMediaMail(to, subject, text, file.buf, 'video.mp4', 'video/mp4');
    console.log('VIDEO SENT to', to);
  } catch (e) {
    console.error('VIDEO FAILED', e.message);
    try { await sendMail({ to, subject: 'לא הצלחנו ליצור את הסרטון', text: 'מצטערים, היצירה נכשלה: ' + String(e.message).slice(0, 200) }); } catch (_) {}
  }
}

// מצרף קובץ למייל. אם הוא גדול מהמגבלה, נשלח קישור להורדה (אם הוגדר מקום), ולא מייל בלי קובץ וכתוב שהוא "גדול"
async function sendMediaMail(to, subject, text, buf, name, mime) {
  if (buf.length <= MAIL_MAX) return sendMail({ to, subject, text, attachments: [{ filename: name, content: buf, contentType: mime }] });
  const link = await uploadForLink(buf, name, mime).catch((e) => { console.error('LINK UPLOAD FAILED', e.message); return null; });
  const note = link
    ? `\n\nהקובץ גדול מדי למייל. אפשר להוריד אותו מכאן, הקישור תקף 7 ימים:\n${link}`
    : '\n\nהקובץ גדול מדי למייל ולכן לא צורף, ולא הוגדר מקום להורדה בשרת.';
  return sendMail({ to, subject, text: text + note });
}

// מכווץ שמע ל-MP3 בעזרת ffmpeg, אם הוא מותקן בשרת. אחרת מחזיר null
function toMp3(buf) {
  return new Promise((resolve) => {
    const child = execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-b:a', '128k', '-f', 'mp3', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
      (err, stdout) => {
        if (err) { console.error('FFMPEG FAILED (is ffmpeg installed in the image?)', err.message); return resolve(null); }
        resolve(stdout);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(buf);
  });
}

// Gemini כותב תיאור סגנון באנגלית ומילים בעברית על הנושא המדויק. מודלי השירה מבינים אנגלית הרבה יותר טוב,
// ולכן בלי זה השיר לפעמים לא קשור למה שביקשו
async function makeSongBrief(topic, style, lyrics, cfg) {
  const res = await withTimeout(gen({
    model: cfg.model,
    contents: [
      `המתקשר ביקש שיר. נושא השיר, בדיוק כפי שנאמר: ${topic}`,
      style ? `סגנון שהמתקשר ביקש: ${style}` : '',
      lyrics ? `מילים שהמתקשר הכתיב. השתמש בהן כמו שהן: ${lyrics}` : '',
      'החזר JSON בלבד במבנה {"caption":"...","lyrics":"..."}.',
      'caption: תיאור קצר באנגלית של הז׳אנר, כלי הנגינה, המצב הרוח והקול. לא לתרגם את הנושא.',
      'lyrics: שיר בעברית על הנושא הזה בלבד, עם בתים ופזמון. בלי הוראות במה ובלי סוגריים מרובעים.'
    ].filter(Boolean).join('\n'),
    config: { temperature: 0.7, maxOutputTokens: 4000, responseMimeType: 'application/json' }
  }), 40000);
  const j = parseJsonLoose(res.text) || {};
  const caption = String(j.caption || style || 'pop, vocals').slice(0, 300);
  const finalLyrics = String(j.lyrics || lyrics || topic).slice(0, 3000);
  return `${caption}. Sung in Hebrew.\nLyrics:\n${finalLyrics}`;
}

// רץ ברקע, בדומה לסרטון. השיר נשלח במייל כקובץ מצורף, ואם הוא גדול מדי כקישור
async function runSongJob(topic, style, lyrics, cfg, to, duration) {
  const subject = 'השיר שביקשת';
  try {
    const prompt = await makeSongBrief(topic, style, lyrics, cfg);
    const song = await makeSong(prompt, duration);
    let buf = song.buf, mime = song.mime, ext = song.mime === 'audio/wav' ? 'wav' : 'mp3';
    if (buf.length > MAIL_MAX) {
      // WAV או MP3 כבד עלולים לחרוג מהמגבלה, לכן מכווצים לפני ששולחים קישור
      const small = await toMp3(buf);
      if (small && small.length < buf.length) { buf = small; mime = 'audio/mpeg'; ext = 'mp3'; }
    }
    const text = `שלום, מצורף השיר שביקשתם בשיחה טלפונית.\nהנושא: ${topic}`;
    await sendMediaMail(to, subject, text, buf, `song.${ext}`, mime);
    console.log('SONG SENT to', to, 'bytes', buf.length);
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

function buildSystemPrompt(cfg, ctx) {
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
  ].concat(extraPromptLines(cfg, ctx)).filter(Boolean).join('\n\n');
}

const FALLBACK_REPLY = 'סליחה, לא הבנתי. אפשר לחזור על זה?';

// מסיר מילה שנקטעה בסוף טקסט שנעצר בגבול האורך, כדי שלא ישמיע "מה נש" במקום "מה נשמע"
function trimTruncated(text) {
  const t = text.replace(/\s+\S*$/, '').trim();
  return t || text;
}

// מריץ תור שיחה אחד, כולל כל קריאות הכלים, ומחזיר את הטקסט להשמעה
async function respond(history, cfg, ctx) {
  const tools = declarations(cfg);
  for (let i = 0; i < 5; i++) {
    const res = await gen({
      model: cfg.model, contents: history,
      config: { systemInstruction: buildSystemPrompt(cfg, ctx), temperature: 0.8, maxOutputTokens: 1500,
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}) }
    });
    const content = res.candidates?.[0]?.content;
    if (content?.parts?.length) history.push(content);
    const calls = res.functionCalls;
    const truncated = res.candidates?.[0]?.finishReason === 'MAX_TOKENS';
    if (!calls?.length) {
      let text = (res.text || '').trim();
      if (truncated) { console.error('REPLY TRUNCATED (MAX_TOKENS), trimming'); text = trimTruncated(text); }
      if (text) return text;
      console.error('EMPTY REPLY, finishReason=', res.candidates?.[0]?.finishReason);
      return FALLBACK_REPLY;
    }
    const parts = [];
    for (const c of calls) {
      let out; try { out = await runTool(c.name, c.args || {}, ctx); } catch (e) { out = { error: String(e.message || e) }; }
      parts.push({ functionResponse: { name: c.name, response: out } });
    }
    history.push({ role: 'user', parts });
    if (ctx.ended) { const t = (res.text || '').trim(); if (t) return t; }
  }
  return FALLBACK_REPLY;
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
// קצב הדגימה של הקול. 8000 נשמע מעומם, לכן ברירת המחדל 16000. אפשר לשנות בהגדרות השרת
const TTS_RATE = Number(process.env.TTS_SAMPLE_RATE || 16000);

async function toMessages(cfg, text, callId, n) {
  text = cleanForSpeech(text);
  if (cfg.voice.provider === 'google') {
    // עד שתי הנסיונות בקול של גוגל. הקול המובנה של ימות נשמע רובוטי, ולכן הוא רק מוצא אחרון
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const path = `/ApiAudio/${callId}_${n}_${attempt}`;
        await withTimeout((async () => { await uploadWav(await synth(text, cfg.voice, { rate: TTS_RATE }), `${path}.wav`); })(), 25000);
        console.log('GOOGLE VOICE OK', path);
        return [{ type: 'file', data: path }];
      } catch (e) { console.error(`GOOGLE VOICE FAILED (attempt ${attempt}):`, e.message); }
    }
    console.error('GOOGLE VOICE FAILED TWICE, using Yemot robotic voice for this line');
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
  const empty = { turns: [], creations: [] };
  if (!norm(phone) || process.env.LOCAL_CONFIG) return empty;
  try {
    const s = await withTimeout((await db()).collection('callers').doc(memKey(phone)).get(), 3000);
    if (!s.exists) return empty;
    return { turns: s.data().turns || [], creations: s.data().creations || [] };
  } catch (e) { console.error('MEMORY LOAD FAILED:', e.message); return empty; }
}

// שומר 30 הודעות אחרונות (טקסט בלבד) ו-10 יצירות אחרונות, כדי לתקן אותן בשיחה הבאה
// Firestore לא תומך במערכים מקוננים, לכן התוכן של קבצים נשמר כמחרוזת JSON
async function saveMemory(phone, history, creations) {
  if (!norm(phone) || process.env.LOCAL_CONFIG) return;
  const key = memKey(phone);
  const turns = history
    .map((h) => ({ role: h.role, parts: (h.parts || []).filter((x) => x.text).map((x) => ({ text: x.text })) }))
    .filter((h) => h.parts.length)
    .slice(-30);
  const cr = creations ? [...creations.values()].slice(-10).map((c) => {
    const o = { ...c };
    if (o.blocks) o.blocks = JSON.stringify(o.blocks);
    return o;
  }) : [];
  try {
    await withTimeout((await db()).collection('callers').doc(key).set({ turns, creations: cr, updatedAt: new Date().toISOString() }), 5000);
  } catch (e) { console.error('MEMORY SAVE FAILED:', e.message); }
}

// ---------- עזרי מקלדת והקלטה לשלוחת ההגדרות ----------
const readTap = (call, text, max = 1, min = 1, extra = {}) =>
  call.read([{ type: 'text', data: ym(text) }], 'tap', { max_digits: max, min_digits: min, ...extra });

// מחזיר את מספר האפשרות שנבחרה (מתחיל מ-1), או 0 אם לא נבחרה אפשרות תקינה
const pick = async (call, text, n) => {
  const k = Number(await readTap(call, text));
  return k >= 1 && k <= n ? k : 0;
};

const askNumber = async (call, text, min, max) =>
  String((await readTap(call, text, max, min, { sec_wait: 20 })) || '').replace(/\D/g, '');

async function askEmail(call) {
  const v = await call.read([{ type: 'text', data: ym('אנא הקלידו את כתובת המייל במקלדת ובסיום הקישו סולמית') }], 'tap',
    { typing_playback_mode: 'EmailKeyboard', max_digits: 80, min_digits: 5, sec_wait: 30 });
  return String(v || '').trim();
}

// מקליט את הדיבור של המתקשר ומחזיר טקסט מתומלל. משמש לרקע העסק, להוראות ולברכות
async function recordText(call, cfg, text, seconds = 60) {
  const fname = `rec_${randomUUID().slice(0, 8)}`;
  const rec = await call.read([{ type: 'text', data: ym(text) }], 'record', { path: '/ApiRecords', file_name: fname, no_confirm_menu: true, max_length: seconds, min_length: 1, quiet_max: 4 });
  const got = await downloadRecording([`/ApiRecords/${fname}.wav`, typeof rec === 'string' ? (rec.startsWith('/') ? rec : '/' + rec) : '']);
  if (!got) return '';
  let t = '';
  try { t = await transcribe(got.buf, cfg); } catch (e) { console.error('TRANSCRIBE FAILED (admin):', e.message); }
  deleteRecording(got.p);
  return String(t || '').trim();
}

// משמיע דוגמה של הקול שנבחר לפני השמירה. מחזיר true אם המתקשר אישר
async function previewVoice(call, voice) {
  const path = `/ApiAudio/voice_${randomUUID().slice(0, 8)}`;
  try {
    await withTimeout((async () => {
      await uploadWav(await synth('שלום, כך אני נשמע בשיחה. לאישור הקישו אחת.', { name: voice.name, speakingRate: 1 }, { rate: 8000 }), `${path}.wav`);
    })(), 20000);
  } catch (e) { console.error('VOICE PREVIEW FAILED:', e.message); return true; }
  const c = await call.read([{ type: 'file', data: path }, { type: 'text', data: ym('לאישור הקול הקישו 1, לבחירת קול אחר הקישו 2') }], 'tap', { max_digits: 1, min_digits: 1 });
  return c === '1';
}

const timeLabel = (iso) => new Date(iso).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

// ---------- יומן שיחות וסיכומים ----------
function transcriptOf(history) {
  return history
    .flatMap((h) => (h.parts || []).filter((p) => p.text).map((p) => `${h.role === 'user' ? 'מתקשר' : 'בוט'}: ${p.text}`))
    .join('\n');
}

async function loadCallLog(tenantId) {
  if (process.env.LOCAL_CONFIG) return [];
  try {
    const s = await withTimeout((await db()).collection('calllog').doc(tenantId).get(), 3000);
    return s.exists ? (s.data().calls || []) : [];
  } catch (e) { console.error('CALLLOG LOAD FAILED:', e.message); return []; }
}

async function appendCallLog(tenantId, entry) {
  if (process.env.LOCAL_CONFIG) return;
  const ref = (await db()).collection('calllog').doc(tenantId);
  const s = await withTimeout(ref.get(), 3000);
  const list = s.exists ? (s.data().calls || []) : [];
  list.push(entry);
  await withTimeout(ref.set({ calls: list.slice(-20) }), 5000);
}

async function summarize(transcript, cfg) {
  const res = await withTimeout(gen({
    model: cfg.model,
    contents: `סכם בעברית, בקצרה ובנקודות, את שיחת הטלפון הבאה: מי המתקשר אם נאמר, מה ביקש, מה נענה, ומה נשאר פתוח לטיפול. טקסט השיחה:\n${transcript}`,
    config: { temperature: 0.3, maxOutputTokens: 800 }
  }), 30000);
  return (res.text || '').trim() || 'לא נוצר סיכום';
}

async function sendSummary(to, entry, summaryText) {
  const when = new Date(entry.at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  const text = `סיכום שיחה מתאריך ${when}\nמספר המתקשר: ${entry.phone}\n\n${summaryText}\n\nתמלול השיחה:\n${entry.transcript || '(ללא תמלול)'}`;
  await sendMail({ to, subject: 'סיכום שיחה', text });
}

// רץ בסוף כל שיחה: שומר ביומן, ואם הוגדר כך, שולח סיכום במייל
async function finishCall(ctx) {
  if (!ctx.active) return;
  const transcript = transcriptOf(ctx.history);
  const entry = { id: ctx.callId, phone: norm(ctx.call.phone), at: new Date(ctx.started).toISOString(), transcript: transcript.slice(-6000) };
  await appendCallLog(currentTenant().id, entry);
  if (ctx.cfg?.summaryMode === 'every' && ctx.cfg.summaryTo && transcript) {
    await sendSummary(ctx.cfg.summaryTo, entry, await summarize(transcript, ctx.cfg));
  }
}

// ---------- העברה לנציג אנושי ושיחה יוצאת (מודל הניתוב של ימות) ----------
async function transferCall(call, number) {
  if (typeof call.routing_yemot === 'function') return call.routing_yemot(number);
  // השורה הזו תראה בלוג אילו שיטות קיימות בגרסת הספרייה שלכם, כדי לתקן את ההעברה לפי זה
  console.error('TRANSFER: routing_yemot missing. methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(call) || {}).join(','), '| keys:', Object.keys(call).join(','));
  await call.id_list_message([{ type: 'text', data: ym('לא הצלחתי להעביר את השיחה כרגע, נסו שוב מאוחר יותר') }]);
  return call.hangup();
}

// שיחה יוצאת דרך ימות. ה-endpoint והפרמטרים עדיין לא אומתו מול התיעוד, לכן הפיצ'ר כבוי כברירת מחדל
async function dialOut(to, cfg) {
  const dialogPath = process.env.OUTBOUND_DIALOG_PATH;
  if (!dialogPath) return { ok: false, error: 'השיחות היוצאות עדיין לא הוגדרו במערכת' };
  const callerId = cfg.outboundCaller === 'chat' ? norm(cfg.chatNumber) : norm(currentTenant().doc?.yemotNumber || process.env.YEMOT_NUMBER || '');
  if (!callerId) return { ok: false, error: 'לא הוגדר מספר שולח לשיחה היוצאת' };
  try {
    const url = 'https://www.call2all.co.il/ym/api/ModemCall?' + new URLSearchParams({ token: yemotCred(), phone: to, callerId, dialogPath });
    const r = await withTimeout(fetch(url), 15000);
    const j = await r.json().catch(() => ({}));
    if (j.responseStatus && j.responseStatus !== 'OK') return { ok: false, error: 'ימות דחתה את החיוג: ' + JSON.stringify(j).slice(0, 150) };
    console.log('OUTBOUND CALL started to', to);
    return { ok: true };
  } catch (e) { return { ok: false, error: 'החיוג נכשל: ' + e.message }; }
}

// הוראות נוספות לבוט: קבצים, שירים, העברה, ויצירות קודמות שאפשר לתקן
function extraPromptLines(cfg, ctx) {
  const list = ctx?.creations ? [...ctx.creations.values()].map((c) => {
    const what = c.kind === 'doc' ? `קובץ ${c.format} בשם ${c.title}` : c.kind === 'song' ? `שיר על ${c.topic}` : c.kind === 'video' ? `סרטון: ${c.prompt}` : `תמונה: ${c.prompt}`;
    return `מזהה ${c.id}: ${what}`;
  }).join('\n') : '';
  return [
    ctx?.greetingText ? `הברכה שכבר נאמרה למתקשר בתחילת השיחה, אל תחזור עליה: ${ctx.greetingText}` : '',
    'יצירת קבצים: אם מבקשים קובץ (וורד, פי די אף או אקסל), השתמש ב-create_file. אם אין כתובת מייל, שאל אם לשלוח ואם כן לאן. לשליחת קובץ שכבר נוצר השתמש ב-send_file. כשמבקשים לתקן קובץ, שיר, סרטון או תמונה שכבר נוצרו, השתמש ב-update_creation עם המזהה שלהם ואל תיצור מחדש מההתחלה.',
    'שירים: תמיד בעברית, והנושא בדיוק כפי שהמתקשר אמר אותו. סרטונים ותמונות: אפשר לתאר באנגלית.',
    cfg.tools?.transfer && norm(cfg.humanNumber) ? 'העברה לנציג: אם המתקשר מבקש במפורש לדבר עם אדם, אמור משפט קצר והפעל transfer_to_human.' : '',
    list ? `יצירות שנוצרו קודם למתקשר הזה, אפשר לתקן לפי המזהה:\n${list}` : ''
  ];
}

// ---------------- שלוחת הצ'אט ----------------
router.get('/chat', async (call) => {
  console.log('CALL START', call.phone);
  const ctx = {
    call, cfg: null, history: [], assets: new Map(), creations: new Map(),
    ended: false, mailCount: 0, transferTo: null, active: false,
    callId: randomUUID().slice(0, 8), started: Date.now()
  };
  try {
    return await chatFlow(ctx);
  } finally {
    try { await finishCall(ctx); } catch (e) { console.error('FINISH CALL FAILED:', e.message); }
  }
});

async function chatFlow(ctx) {
  const { call } = ctx;
  const cfg = await getConfig();
  ctx.cfg = cfg;
  const say = (t) => call.id_list_message([{ type: 'text', data: ym(t) }]);

  if (!cfg.enabled) { await say(cfg.closedMessage); return call.hangup(); }
  if (!isAllowed(cfg, call.phone)) { await say(cfg.deniedMessage); return call.hangup(); }
  if (!isOpen(cfg)) { await say(cfg.closedMessage); return call.hangup(); }
  if (!(await countCall(currentTenant().id, currentTenant().doc?.dailyCallLimit))) { await say(cfg.closedMessage); return call.hangup(); }

  ctx.active = true;
  const mem = await loadMemory(call.phone);
  const history = mem.turns;
  for (const c of mem.creations) {
    const o = { ...c };
    if (typeof o.blocks === 'string') { try { o.blocks = JSON.parse(o.blocks); } catch (e) { delete o.blocks; } }
    ctx.creations.set(o.id, o);
  }
  ctx.history = history;

  const callId = ctx.callId;
  let n = 0, silent = 0;
  const greetingText = [cfg.consentMessage, cfg.greeting, cfg.endHint].filter(Boolean).join(' ');
  // הברכה לא נכנסה לשיחה עד היום, אז המודל לא ידע מה כבר נאמר למתקשר ועלול לענות כאילו השיחה מתחילה עכשיו
  ctx.greetingText = greetingText;
  let prompt = await toMessages(cfg, greetingText, callId, n++);

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
    saveMemory(call.phone, history, ctx.creations);
    console.log('REPLY:', reply);
    if (ctx.transferTo) {
      await call.id_list_message(await toMessages(cfg, reply || 'רגע, אני מעביר אותך.', callId, n++));
      return transferCall(call, ctx.transferTo);
    }
    if (ctx.ended || Date.now() - ctx.started > cfg.maxMinutes * 60000) {
      await call.id_list_message(await toMessages(cfg, reply || cfg.goodbye, callId, n++));
      return call.hangup();
    }
    prompt = await toMessages(cfg, reply, callId, n++);
  }
  await call.id_list_message(await toMessages(cfg, cfg.goodbye, callId, n++));
  return call.hangup();
}

// ---------------- שלוחת הגדרות בטלפון (מוגנת ב-PIN) ----------------
// שדות שמוגדרים בהקלטה. המפתח הוא הספרה שבה בוחרים בתפריט
const TEXT_FIELDS = {
  1: { key: 'businessName', label: 'שם העסק', sec: 30 },
  2: { key: 'businessInfo', label: 'רקע על העסק, ספרו בחופשיות', sec: 180 },
  3: { key: 'customInstructions', label: 'הוראות מיוחדות לבוט', sec: 120 },
  4: { key: 'greeting', label: 'ברכת הפתיחה', sec: 40 },
  5: { key: 'goodbye', label: 'ברכת הסיום', sec: 30 },
  6: { key: 'topics', label: 'הנושאים, מופרדים בפסיק', sec: 40, list: true },
  7: { key: 'closedMessage', label: 'הודעה כשהשירות סגור', sec: 40 },
  8: { key: 'deniedMessage', label: 'הודעה למי שאין לו הרשאה', sec: 40 },
  9: { key: 'offTopicReply', label: 'תשובה לנושא שלא מתאים', sec: 40 }
};

router.get('/admin', async (call) => {
  const pin = await call.read([{ type: 'text', data: 'הקישו קוד סודי' }], 'tap', { max_digits: 12, min_digits: 1 });
  if (!process.env.ADMIN_PIN || pin !== process.env.ADMIN_PIN) { await call.id_list_message([{ type: 'text', data: 'קוד שגוי' }]); return call.hangup(); }

  let cfg = await getConfig();
  const say = (t) => call.id_list_message([{ type: 'text', data: ym(t) }]);
  const save = async (patch, msg = 'ההגדרה עודכנה') => {
    await saveConfig(patch);
    cfg = await getConfig();
    if (msg) await say(msg);
  };
  const toggleTool = async (key, label) => {
    const c = await readTap(call, `${label} כרגע ${cfg.tools[key] ? 'פעיל' : 'כבוי'}. להפעלה הקישו 1, לכיבוי הקישו 2`);
    if (c === '1' || c === '2') await save({ tools: { ...cfg.tools, [key]: c === '1' } });
  };

  const choice = await readTap(call, `למצב פעיל או כבוי הקישו 1. לתפקיד הקישו 2. לקול הקישו 3. לסגנון דיבור הקישו 4. לניקוד הקישו 5. לכלים ויכולות הקישו 6. להרשאות גישה הקישו 7. לשעות פעילות הקישו 8. לטקסטים והקלטות הקישו 9. לסיכומי שיחות הקישו 0. כרגע השירות ${cfg.enabled ? 'פעיל' : 'כבוי'}`);

  if (choice === '1') await save({ enabled: !cfg.enabled }, cfg.enabled ? 'השירות כובה' : 'השירות הופעל');

  if (choice === '2') {
    const ids = Object.keys(PRESETS);
    const k = await pick(call, ids.map((id, i) => `${PRESETS[id].label} הקישו ${i + 1}`).join('. '), ids.length);
    if (k) await save({ role: ids[k - 1] }, 'התפקיד עודכן');
  }

  if (choice === '3') {
    const PER = 8;
    let page = 0, picked = null;
    while (!picked) {
      const items = VOICES.slice(page * PER, page * PER + PER);
      const more = (page + 1) * PER < VOICES.length;
      const menu = items.map((v, i) => `${v.label} הקישו ${i + 1}`).join('. ') + (more ? '. לקולות נוספים הקישו 9' : '');
      const c = await readTap(call, menu);
      if (c === '9' && more) { page++; continue; }
      const idx = Number(c) - 1;
      if (idx < 0 || idx >= items.length) break;
      // דוגמה של הקול לפני השמירה. אם לא אושר, חוזרים לאותו עמוד
      if (await previewVoice(call, items[idx])) picked = items[idx];
    }
    if (picked) await save({ voice: { ...cfg.voice, name: picked.name, provider: 'google' } }, 'הקול עודכן');
  }

  if (choice === '4') {
    const keys = Object.keys(STYLES);
    const k = await pick(call, keys.map((key, i) => `${STYLE_LABELS[key]} הקישו ${i + 1}`).join('. '), keys.length);
    if (k) await save({ style: keys[k - 1] }, 'הסגנון עודכן');
  }

  if (choice === '5') {
    const c = await readTap(call, 'ניקוד מלא הקישו 1. בלי ניקוד הקישו 2');
    if (c === '1' || c === '2') await save({ useNikud: c === '1' });
  }

  if (choice === '6') {
    const c = await readTap(call, 'לאימייל הקישו 1. לפקס הקישו 2. ליצירת תמונות הקישו 3. ליצירת שירים הקישו 4. ליצירת סרטונים הקישו 5. להעברה לנציג הקישו 6. לשיחות יוצאות הקישו 7. לקבצים ומסמכים הקישו 8');
    const simple = { '1': ['email', 'אימייל'], '2': ['fax', 'פקס'], '3': ['images', 'תמונות'], '4': ['music', 'שירים'], '5': ['video', 'סרטונים'], '8': ['files', 'קבצים ומסמכים'] };
    if (simple[c]) await toggleTool(simple[c][0], simple[c][1]);
    if (c === '6') {
      const x = await readTap(call, `העברה לנציג ${cfg.tools.transfer ? 'פעילה' : 'כבויה'}. להפעלה הקישו 1, לכיבוי הקישו 2, להגדרת מספר הנציג הקישו 3`);
      if (x === '1' || x === '2') await save({ tools: { ...cfg.tools, transfer: x === '1' } });
      if (x === '3') {
        const num = norm(await askNumber(call, 'הקישו את מספר הנציג ובסיום סולמית', 9, 12));
        if (num.length >= 9) await save({ humanNumber: num }, 'מספר הנציג נשמר');
      }
    }
    if (c === '7') {
      const x = await readTap(call, `שיחות יוצאות ${cfg.tools.outbound ? 'פעילות' : 'כבויות'}. להפעלה הקישו 1, לכיבוי הקישו 2, לבחירת מספר השולח הקישו 3`);
      if (x === '1' || x === '2') await save({ tools: { ...cfg.tools, outbound: x === '1' } });
      if (x === '3') {
        const k = await pick(call, 'לשליחה ממספר המערכת הקישו 1. לשליחה ממספר הצ׳אט הקישו 2', 2);
        if (k === 1) await save({ outboundCaller: 'system' }, 'השולח עודכן');
        if (k === 2) {
          const num = norm(await askNumber(call, 'הקישו את מספר הצ׳אט ובסיום סולמית', 9, 12));
          if (num.length >= 9) await save({ outboundCaller: 'chat', chatNumber: num }, 'השולח עודכן');
        }
      }
    }
  }

  if (choice === '7') {
    const c = await readTap(call, 'לכולם מותר הקישו 1. לרשימה לבנה, רק המספרים ברשימה, הקישו 2. לרשימה שחורה, חסימה למספרים ברשימה, הקישו 3. להוספת מספר לרשימה הקישו 4. לניקוי הרשימה הקישו 5');
    if (c === '1') await save({ access: { ...cfg.access, mode: 'all' } });
    if (c === '2') await save({ access: { ...cfg.access, mode: 'whitelist' } });
    if (c === '3') await save({ access: { ...cfg.access, mode: 'blacklist' } });
    if (c === '4') {
      const num = norm(await askNumber(call, 'הקישו את המספר להוספה ובסיום סולמית', 9, 12));
      if (num.length >= 9) {
        const list = [...new Set([...(cfg.access.numbers || []).map(norm), num])];
        await save({ access: { ...cfg.access, numbers: list } }, 'המספר נוסף לרשימה');
      }
    }
    if (c === '5') await save({ access: { ...cfg.access, numbers: [] } }, 'הרשימה נוקתה');
  }

  if (choice === '8') {
    const c = await readTap(call, `שעות פעילות ${cfg.schedule.enabled ? 'מופעלות' : 'כבויות'}. להפעלה או לכיבוי הקישו 1. לשעת פתיחה הקישו 2. לשעת סגירה הקישו 3. לפתיחה או סגירה של יום מסוים הקישו 4`);
    if (c === '1') await save({ schedule: { ...cfg.schedule, enabled: !cfg.schedule.enabled } });
    if (c === '2' || c === '3') {
      const v = await askNumber(call, 'הקישו את השעה בארבע ספרות, שתי ספרות לשעה ושתי לדקות, ובסיום סולמית', 4, 4);
      const hh = Number(v.slice(0, 2)), mm = Number(v.slice(2, 4));
      if (v.length === 4 && hh < 24 && mm < 60) {
        const t = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        const key = c === '2' ? 'from' : 'to';
        const days = cfg.schedule.days.map((d) => ({ ...d, [key]: t }));
        await save({ schedule: { ...cfg.schedule, days } }, 'השעה עודכנה לכל הימים');
      } else await say('השעה לא תקינה');
    }
    if (c === '4') {
      const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
      const k = await pick(call, names.map((nm, i) => `יום ${nm} הקישו ${i + 1}`).join('. '), 7);
      if (k) {
        const wasOpen = !!cfg.schedule.days[k - 1]?.open;
        const days = cfg.schedule.days.map((d, i) => (i === k - 1 ? { ...d, open: !d.open } : d));
        await save({ schedule: { ...cfg.schedule, days } }, `יום ${names[k - 1]} ${wasOpen ? 'נסגר' : 'נפתח'}`);
      }
    }
  }

  if (choice === '9') {
    const k = await pick(call, Object.entries(TEXT_FIELDS).map(([d, f]) => `${f.label} הקישו ${d}`).join('. '), 9);
    const f = k ? TEXT_FIELDS[String(k)] : null;
    if (f) {
      const txt = await recordText(call, cfg, `אחרי הצליל אמרו ${f.label}. לסיום שתקו`, f.sec);
      if (!txt) await say('לא זיהיתי דיבור, נסו שוב');
      else if (f.list) {
        const topics = txt.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
        const m = await pick(call, 'לנושאים מותרים בלבד הקישו 1. לחסימת הנושאים האלה הקישו 2. לכל הנושאים הקישו 3', 3);
        await save({ topics, topicsMode: m === 1 ? 'allowed' : m === 2 ? 'blocked' : 'all' }, 'הנושאים נשמרו');
      } else {
        await save({ [f.key]: txt.slice(0, 3000) }, 'נשמר');
      }
    }
  }

  if (choice === '0') {
    const c = await readTap(call, 'לכיבוי הסיכומים הקישו 1. לסיכום אחרי כל שיחה הקישו 2. לשליחת סיכום של שיחה קודמת הקישו 3. להגדרת כתובת המייל לסיכומים הקישו 4');
    if (c === '1') await save({ summaryMode: 'off' }, 'הסיכומים כובו');
    if (c === '2') await save({ summaryMode: 'every' }, 'הסיכומים יישלחו אחרי כל שיחה');
    if (c === '4') {
      const to = await askEmail(call);
      if (EMAIL_RE.test(to)) await save({ summaryTo: to }, 'כתובת הסיכומים נשמרה');
      else await say('כתובת לא תקינה');
    }
    if (c === '3') {
      const logs = (await loadCallLog(currentTenant().id)).slice(-5).reverse();
      if (!logs.length) await say('אין שיחות קודמות');
      else {
        const k = await pick(call, logs.map((e, i) => `שיחה ${i + 1} מהשעה ${timeLabel(e.at)} הקישו ${i + 1}`).join('. '), logs.length);
        if (k) {
          const to = cfg.summaryTo || await askEmail(call);
          if (EMAIL_RE.test(to)) {
            await say('הסיכום בדרך למייל');
            await sendSummary(to, logs[k - 1], await summarize(logs[k - 1].transcript, cfg));
          } else await say('כתובת לא תקינה');
        }
      }
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

// יומן שיחות וסיכום לפי בקשה (לאתר הניהול)
tenantApi.get('/calls', async (_q, r) => r.json((await loadCallLog(currentTenant().id)).slice().reverse()));
tenantApi.post('/calls/:id/summary', async (q, r) => {
  const entry = (await loadCallLog(currentTenant().id)).find((e) => e.id === q.params.id);
  if (!entry) return r.status(404).json({ error: 'not found' });
  const to = String(q.body?.to || currentTenant().doc?.summaryTo || '').trim();
  if (!EMAIL_RE.test(to)) return r.status(400).json({ error: 'bad email' });
  await sendSummary(to, entry, await summarize(entry.transcript, await getConfig()));
  r.json({ ok: true });
});

app.use('/tapi', tenantApi);
app.use('/', router);
app.listen(process.env.PORT || 8080, () => console.log('STARTED', JSON.stringify({ credsOk: !!creds, apiKey: !!apiKey, adminTokenLength: (process.env.ADMIN_TOKEN || '').length })));
