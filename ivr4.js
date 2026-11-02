import express from 'express';
import { YemotRouter } from 'yemot-router2';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { GoogleGenAI } from '@google/genai';
import textToSpeech from '@google-cloud/text-to-speech';

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
  voice: { provider: process.env.VOICE_PROVIDER || 'yemot', name: 'he-IL-Wavenet-A', speakingRate: 1.05 }, // provider: google | yemot
  greeting: 'שלום, איך אפשר לעזור?',
  goodbye: 'תודה רבה ולהתראות.',
  access: { mode: 'all', numbers: [] },  // all | whitelist | blacklist
  deniedMessage: 'מצטערים, אין לך הרשאה להשתמש בשירות זה.',
  closedMessage: 'השירות סגור כעת. אנא חזרו בשעות הפעילות.',
  schedule: { enabled: false, tz: 'Asia/Jerusalem', days }, // days[0]=ראשון
  tools: { email: true, fax: false, images: true },
  model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  maxMinutes: 10
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
  if (cache && Date.now() - cacheAt < 10000) return cache;
  let stored = {};
  try {
    stored = await withTimeout(loadStored(), 3000);
    cache = { ...DEFAULTS, ...stored };
    cacheAt = Date.now();
  } catch (e) {
    // המסד לא זמין: ממשיכים עם ההגדרות האחרונות או ברירות המחדל, ומנסים שוב בעוד דקה
    console.error('CONFIG LOAD FAILED, using fallback:', e.message);
    cache = cache || { ...DEFAULTS };
    cacheAt = Date.now() + 590000;
  }
  return cache;
}

async function saveConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  cache = next; cacheAt = Date.now();
  try {
    if (process.env.LOCAL_CONFIG) fs.writeFileSync(process.env.LOCAL_CONFIG, JSON.stringify(next, null, 2));
    else await withTimeout((await getRef()).set(next), 5000);
  } catch (e) {
    console.error('CONFIG SAVE FAILED (kept in memory only):', e.message);
    next._notPersisted = true;
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
  const now = `${get('hour')}:${get('minute')}`;
  const d = cfg.schedule.days[dow];
  return !!d?.open && now >= d.from && now < d.to;
}

// ===== lib/tts.js =====
const client = new textToSpeech.TextToSpeechClient(creds ? { credentials: creds, projectId: creds.project_id } : (apiKey ? { apiKey } : {}));

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
const token = () => `${process.env.YEMOT_NUMBER}:${process.env.YEMOT_PASSWORD}`;

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
    description: 'שולח מייל. קרא לפונקציה רק אחרי שהמתקשר אישר את הכתובת ואת התוכן.',
    parameters: { type: 'OBJECT', properties: {
      to: { type: S, description: 'כתובת הנמען' },
      subject: { type: S }, body: { type: S, description: 'גוף המייל המלא' },
      attachment_ids: { type: 'ARRAY', items: { type: S }, description: 'מזהי תמונות שנוצרו' }
    }, required: ['to', 'subject', 'body'] }
  });
  if (cfg.tools.fax) d.push({
    name: 'send_fax',
    description: 'שולח פקס. קרא רק אחרי שהמתקשר אישר את המספר ואת התוכן.',
    parameters: { type: 'OBJECT', properties: {
      fax_number: { type: S }, subject: { type: S }, body: { type: S }
    }, required: ['fax_number', 'body'] }
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
      const attachments = (args.attachment_ids || []).filter((i) => ctx.assets.has(i)).map((i, n) => {
        const a = ctx.assets.get(i); return { filename: `image${n + 1}.${a.mime.split('/')[1] || 'png'}`, content: a.data, contentType: a.mime };
      });
      await mailer().sendMail({ from: process.env.MAIL_FROM, to: args.to, subject: args.subject, text: args.body, attachments });
      return { sent: true };
    }

    case 'send_fax': {
      if (!process.env.FAX_WEBHOOK_URL) return { error: 'שירות הפקס עדיין לא הוגדר' };
      const r = await fetch(process.env.FAX_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: args.fax_number, subject: args.subject || '', text: args.body }) });
      return r.ok ? { sent: true } : { error: 'שליחת הפקס נכשלה: ' + r.status };
    }
    default: return { error: 'פונקציה לא מוכרת' };
  }
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
    `זו שיחת טלפון בעברית עם אדם אמיתי. דבר בדיוק כמו בן אדם בשיחה: משפטים קצרים וטבעיים (עד 2-3 משפטים בתשובה), עברית מדוברת ולא כתובה, בלי רשימות, בלי כוכביות או עיצוב, בלי אימוג'ים. מספרים ותאריכים כתוב במילים. אל תשתמש בתבניות קבועות ואל תחזור על אותם ניסוחים; הגב למה שנאמר, שאל שאלות המשך כשזה טבעי, ואם לא הבנת אל תנחש, שאל שוב.`,
    `כשצריך לשלוח משהו (מייל או פקס), שאל כמו נציג אנושי לאן לשלוח, אשר את הפרטים בקול לפני השליחה, ורק אז שלח. אם אתה צריך כתובת מייל, העדף לבקש מהמתקשר להקליד אותה במקלדת. אחרי השליחה אשר שזה נשלח.`,
    `אם הטקסט שהתקבל מהזיהוי הקולי נראה משובש, שאל בנימוס שוב במקום לנחש. אל תמציא עובדות על העסק.`
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
adminApi.put('/config', async (q, r) => r.json(await saveConfig(q.body)));
adminApi.get('/options', (_q, r) => r.json({
  presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
  styles: Object.keys(STYLES)
}));
adminApi.get('/voices', async (_q, r) => r.json(await listVoices('he-IL')));
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
app.get('/healthz', (_q, r) => r.send('ok'));
app.use('/api', adminApi);

app.get('/', (_q, r) => r.send('ok'));
app.get('/test', async (q, r) => {
  if (!process.env.ADMIN_TOKEN || q.query.token !== process.env.ADMIN_TOKEN) return r.status(401).send('unauthorized');
  const out = {};
  const step = async (name, fn) => { const t = Date.now(); try { out[name] = { ok: true, ms: Date.now() - t, info: await fn() }; } catch (e) { out[name] = { ok: false, ms: Date.now() - t, error: String(e.message || e).slice(0, 300) }; } };
  await step('env', async () => ({ project: process.env.GOOGLE_CLOUD_PROJECT, hasCreds: !!creds, hasApiKey: !!apiKey, adminTokenLength: (process.env.ADMIN_TOKEN || '').length, yemotNumber: !!process.env.YEMOT_NUMBER, yemotPassword: !!process.env.YEMOT_PASSWORD, voice: (await getConfig()).voice.provider }));
  await step('gemini', async () => { const res = await gen({ model: (await getConfig()).model, contents: 'ענה במילה אחת: שלום' }); return res.text; });
  await step('tts', async () => (await synth('שלום', { name: 'he-IL-Wavenet-A' })).length + ' bytes');
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
      await withTimeout((async () => { await uploadWav(await synth(text, cfg.voice), `${path}.wav`); })(), 8000);
      console.log('GOOGLE VOICE OK', path);
      return [{ type: 'file', data: path }];
    } catch (e) { console.error('GOOGLE VOICE FAILED, using Yemot voice:', e.message); }
  }
  return [{ type: 'text', data: ym(text) }];
}

// ---------------- הקלטה ותמלול (בלי יחידות זיהוי דיבור של ימות) ----------------
const ymToken = () => `${process.env.YEMOT_NUMBER}:${process.env.YEMOT_PASSWORD}`;

async function downloadRecording(pathsToTry) {
  for (const p of pathsToTry.filter(Boolean)) {
    try {
      const url = 'https://www.call2all.co.il/ym/api/DownloadFile?' + new URLSearchParams({ token: ymToken(), path: 'ivr2:' + p });
      const r = await withTimeout(fetch(url), 8000);
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && buf.length > 200 && !(buf[0] === 0x7b)) return { buf, p };   // 0x7b = '{' כלומר תשובת שגיאה בפורמט JSON
      console.error('DOWNLOAD not a file for', p, 'status', r.status, 'bytes', buf.length, buf.length < 400 ? buf.toString('utf8') : '');
    } catch (e) { console.error('DOWNLOAD failed for', p, e.message); }
  }
  return null;
}

async function deleteRecording(p) {
  try {
    const url = 'https://www.call2all.co.il/ym/api/FileAction?' + new URLSearchParams({ token: ymToken(), action: 'delete', what: 'ivr2:' + p });
    await withTimeout(fetch(url), 5000);
  } catch (e) { /* לא קריטי */ }
}

async function transcribe(buf, cfg) {
  const res = await withTimeout(gen({
    model: cfg.model,
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'audio/wav', data: buf.toString('base64') } },
      { text: 'תמלל במדויק את הדיבור בעברית שבהקלטה. החזר רק את הטקסט המתומלל, בלי הסברים ובלי מרכאות. אם אין דיבור ברור החזר בדיוק את המילה EMPTY' }
    ] }],
    config: { temperature: 0, maxOutputTokens: 200 }
  }), 15000);
  const t = (res.text || '').trim();
  return (!t || /^EMPTY\b/i.test(t)) ? '' : t;
}

// ---------------- שלוחת הצ'אט ----------------
router.get('/chat', async (call) => {
  console.log('CALL START', call.phone);
  const cfg = await getConfig();
  const say = (t) => call.id_list_message([{ type: 'text', data: ym(t) }]);

  if (!cfg.enabled) { await say(cfg.closedMessage); return call.hangup(); }
  if (!isAllowed(cfg, call.phone)) { await say(cfg.deniedMessage); return call.hangup(); }
  if (!isOpen(cfg)) { await say(cfg.closedMessage); return call.hangup(); }

  const callId = randomUUID().slice(0, 8);
  const ctx = { call, assets: new Map(), ended: false };
  const history = [];
  const started = Date.now();
  let n = 0, silent = 0;
  let prompt = await toMessages(cfg, cfg.greeting + ' ' + (cfg.endHint ?? 'בסיום הדיבור הקישו סולמית'), callId, n++);

  while (true) {
    // ההשמעה והאזנה באותה בקשה, כדי לחסוך זמן תגובה
    const fname = `${callId}_${n}`;
    const rec = await call.read(prompt, 'record', { path: '/ApiRecords', file_name: fname, no_confirm_menu: true, max_length: 40, min_length: 1 });
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
    console.log('REPLY:', reply);
    if (ctx.ended || Date.now() - started > cfg.maxMinutes * 60000) {
      await call.id_list_message(await toMessages(cfg, reply || cfg.goodbye, callId, n++));
      return call.hangup();
    }
    prompt = await toMessages(cfg, reply, callId, n++);
  }
  await say(cfg.goodbye);
  return call.hangup();
});

// ---------------- שלוחת הגדרות בטלפון (מוגנת ב-PIN) ----------------
router.get('/admin', async (call) => {
  const pin = await call.read([{ type: 'text', data: 'הקישו קוד סודי' }], 'tap', { max_digits: 12, min_digits: 1 });
  if (!process.env.ADMIN_PIN || pin !== process.env.ADMIN_PIN) { await call.id_list_message([{ type: 'text', data: 'קוד שגוי' }]); return call.hangup(); }
  const cfg = await getConfig();
  const ids = Object.keys(PRESETS);
  const choice = await call.read([{ type: 'text',
    data: ym(`למצב פעיל או כבוי הקישו 1 לבחירת תפקיד הקישו 2 כרגע השירות ${cfg.enabled ? 'פעיל' : 'כבוי'}`) }], 'tap', { max_digits: 1, min_digits: 1 });
  if (choice === '1') { await saveConfig({ enabled: !cfg.enabled }); await call.id_list_message([{ type: 'text', data: cfg.enabled ? 'השירות כובה' : 'השירות הופעל' }]); }
  if (choice === '2') {
    const menu = ids.map((id, i) => `${PRESETS[id].label} הקישו ${i + 1}`).join('. ');
    const c = await call.read([{ type: 'text', data: ym(menu) }], 'tap', { max_digits: 1, min_digits: 1 });
    const id = ids[Number(c) - 1];
    if (id) { await saveConfig({ role: id }); await call.id_list_message([{ type: 'text', data: 'התפקיד עודכן' }]); }
  }
  return call.hangup();
});

app.use('/', router);
app.listen(process.env.PORT || 8080, () => console.log('STARTED', JSON.stringify({ credsOk: !!creds, apiKey: !!apiKey, adminTokenLength: (process.env.ADMIN_TOKEN || '').length })));

