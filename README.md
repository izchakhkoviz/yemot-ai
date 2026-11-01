# שלוחת צ'אט AI לימות המשיח

## מה יש כאן
- `/chat` שלוחת השיחה. Gemini (Vertex AI), קול של גוגל, כלים: מייל, פקס, תמונות, סיום שיחה.
- `/admin` שלוחה טלפונית להגדרות מהירות (מוגנת ב-PIN).
- `/api/*` ממשק REST לאתר הניהול שתבנה ב-AI Studio.
- הגדרות נשמרות ב-Firestore: תפקיד, נושאים, קול, סגנון, שעות פעילות, מספרים מורשים, כלים.

## התקנה
```bash
npm i express yemot-router2 @google/genai @google-cloud/text-to-speech @google-cloud/firestore nodemailer
cp .env.example .env   # ומלא את הערכים
```

## Google Cloud (על הקרדיט)
1. הפעל APIs: Vertex AI, Cloud Text-to-Speech, Firestore (Native mode), Cloud Run.
2. ודא בחשבון החיוב שהקרדיט חל על השירותים האלה.
3. פריסה:
```bash
gcloud run deploy yemot-ai --source . --region us-central1 --allow-unauthenticated \
  --min-instances 1 --set-env-vars "$(grep -v '^#' .env | xargs | tr ' ' ',')"
```
(או הגדר את המשתנים בקונסולה. שמור סודות ב-Secret Manager בפרודקשן.)
חשוב: `--min-instances 1`, כי מצב השיחה נשמר בזיכרון.
לחשבון השירות של Cloud Run צריך הרשאות Vertex AI User, Cloud Datastore User.

## ימות המשיח
1. בשלוחה לצ'אט: סוג שלוחה API, כתובת `https://<cloud-run-url>/chat`.
2. בשלוחה להגדרות: סוג API, כתובת `https://<cloud-run-url>/admin`.
3. אל תגדיר `api_hangup_send=no` (המלצת הספרייה).
4. פקס: אין לי אימות ל-API פקס של ימות, לכן `send_fax` קורא ל-`FAX_WEBHOOK_URL` שתכוון לספק הפקס שלך. לא נבדק.

## בדיקות ראשונות
- אם הקול נשמע בקול של ימות ולא של גוגל, בדוק לוגים של `uploadWav` (נתיב או הרשאות).
- אם זיהוי הדיבור לא עובד, בדוק בתיעוד של yemot-router2 את אפשרויות ה-stt בגרסה שהותקנה.
- קבצי השמע נצברים ב-`/ApiAudio` בימות, כדאי למחוק אותם מדי פעם.

## פרומפט ל-Google AI Studio (אתר הניהול)
> בנה אתר ניהול בעברית (RTL) לשלוחת צ'אט טלפונית עם AI. האתר מתחבר ל-API שכתובתו בהגדרות, עם כותרת `Authorization: Bearer <TOKEN>` שמוזנת בכניסה.
> נקודות קצה: GET/PUT `/api/config`, GET `/api/options`, GET `/api/voices`, POST `/api/tts-preview` (גוף: `{text, voice}` מחזיר `{mime, base64}` להשמעה).
> מסכים: (1) תפקיד, שם עסק, מידע על העסק, הוראות מותאמות. (2) נושאים: כולם / מותרים בלבד / חסומים + רשימה. (3) קול: רשימה מ-`/api/voices`, מהירות דיבור, כפתור האזנה. (4) סגנון דיבור. (5) שעות פעילות לכל יום + מחוץ לשעות. (6) מספרי טלפון: כולם / רשימה לבנה / רשימה שחורה. (7) כלים: מייל, פקס, תמונות. (8) הודעות פתיחה, סיום וחסימה, ומשך שיחה מקסימלי.
> מבנה ה-config כמו שמחזיר GET `/api/config`. שמירה בכפתור אחד.

## שדרוג עתידי לזמן-אמת (דרך ב')
כל ההגדרות, הכלים והפרומפט (`lib/ai.js`, `lib/tools.js`, `lib/config.js`) ניתנים לשימוש חוזר מול Gemini Live API. מחליפים רק את לולאת השיחה ב-`server.js` בגשר אודיו.
