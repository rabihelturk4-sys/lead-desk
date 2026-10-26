# Lead Desk

A fast mobile and desktop CRM for real-estate leads: a briefing before every call, one-tap call / WhatsApp / SMS / email,
ready messages in the lead's language, call windows by country, and follow-up stages
(Pipeline, No answer, Workshop, Pool, Buy later).

Static web app (installable PWA). Data lives in the owner's Firebase project (Firestore + Authentication).

* `index.html` – the whole app
* `config.js` – Firebase web config
* `firestore.rules` – security rules: each user reaches only `users/{their uid}/...`
* `sw.js`, `manifest.webmanifest`, icons – install on the home screen and offline start
