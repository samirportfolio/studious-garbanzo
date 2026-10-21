# Personal WhatsApp Bot - Pairing Code Connect (FREE)

Tumi shudhu number diba, ami code dibo, tumi Linked Devices e code boshaba - bas!

## Kivabe cholbe
1. Dashboard khulo (engine cholle): number box e WhatsApp Business number din (017XXXXXXXX)
2. "Get Pairing Code" chapo - boro code dekhabe
3. Phone e: WhatsApp > ⋮ > Linked Devices > Link a Device > Link with phone number > code ta boshain (tarari, code expire hoy)
4. Status Connected holei hoye geche.

## Tarpor ki hobe?
Linked howar por jekono ID theke message ashle bot nije bujhe reply dibe:
- hello / product / dam / delivery / payment / order / amar order / help / human
- Bangla (script + Roman) ar English
- Proti customer alada alada order flow e thakbe, ekjoner order arekjoner sathe milbe na
- Order hole Order ID dibe, dashboard e order + chat dekhabe

## Chalano
```
npm install
node index.js
# dashboard: http://localhost:3000
```
Free host e (Render free) deploy korle: buildCommand `npm install`, startCommand `node index.js`.
Note: WhatsApp Web engine ke cholte thakte hobe (persistent server). Vercel serverless e eta cholbe na.
Risk: Unofficial WhatsApp Web engine - beshi/spam message pathale number ban hote pare, tai normal customer reply er jonno use korun.
