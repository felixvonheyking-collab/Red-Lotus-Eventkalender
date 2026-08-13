const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const app = admin.initializeApp();
// Wichtig: Die Datenbank heißt bei uns wortwörtlich "default" (nicht die
// intern reservierte Standard-Datenbank "(default)") — deshalb muss die
// ID hier explizit angegeben werden, sonst schlägt jeder Schreibzugriff
// mit "NOT_FOUND" fehl (gleicher Fehler wie damals im Browser-Code).
const db = getFirestore(app, "default");

/* ============================================================
   Red Lotus — Wix-Formular-Webhook
   ============================================================
   Empfängt POST-Anfragen von den drei Wix-Cateringformularen
   (Allgemein, Firmen-Catering, Hochzeitscatering) und legt daraus
   automatisch einen Termin in der Firestore-Datenbank an
   (dieselbe Sammlung "events", die auch der Kalender nutzt).

   WICHTIG: Nach dem Deployment die Funktions-URL bei Wix in der
   "HTTP-Anfrage senden"-Aktion eintragen, siehe EINRICHTUNG_WIX.md.

   Sicherheit: Ein einfacher, geheimer Schlüssel in der URL
   (?key=...) verhindert, dass Fremde beliebig Termine anlegen
   können. Kein Hochsicherheits-Schutz, aber für diesen Zweck
   ausreichend — niemand kennt die URL + den Schlüssel außer dir
   und Wix.
   ============================================================ */

const WEBHOOK_SECRET = "rl_wix_h7k2m9p4"; // <-- kannst du hier durch einen eigenen Text ersetzen

function firstNonEmpty(...vals){
  for(const v of vals){ if(v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim(); }
  return "";
}

exports.wixFormWebhook = onRequest({ cors: true }, async (req, res) => {
  if(req.method !== "POST"){
    res.status(405).send("Method not allowed");
    return;
  }
  const key = req.query.key || (req.body && req.body.key);
  if(key !== WEBHOOK_SECRET){
    res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
    return;
  }

  try{
    const payload = req.body || {};
    console.log("ROHDATEN von Wix (zur Fehlersuche):", JSON.stringify(payload));

    // Wix schickt die eigentlichen Daten verschachtelt unter "data", inkl.
    // einer "submissions"-Liste mit {label, value}-Paaren — das ist der
    // zuverlässigste Weg, an die Formularfelder zu kommen (unabhängig davon,
    // wie Wix intern die einzelnen Feld-IDs benennt).
    const data = payload.data || payload;
    const submissions = data.submissions || [];
    const byLabel = {};
    submissions.forEach(s => { if(s && s.label) byLabel[s.label.trim()] = s.value; });
    function getField(...labels){
      for(const l of labels){
        const v = byLabel[l];
        if(v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
      }
      return "";
    }

    const vorname = getField("Vorname");
    const nachname = getField("Nachname");
    const firma = getField("Firma");
    const ansprechpartnerRoh = getField("Ansprechpartner");
    const ansprechpartner = ansprechpartnerRoh || [vorname, nachname].filter(Boolean).join(" ");
    const email = getField("Email", "E-Mail");
    const phone = getField("Telefonnummer");
    const people = getField("Anzahl Gäste");
    const anlassRoh = getField("Anlass", "Art der Feier");
    const budget = getField("Budget pro Person");
    const sonder = getField("Sonderleistungen");
    const nachricht = getField("Mehr Informationen und/oder Fragen zum Catering");

    // Formular-Art anhand des Wix-Formularnamens erkennen (kein manuelles
    // Einrichten in Wix nötig).
    const formName = (data.formName || "").toLowerCase();
    let formType = "allgemein";
    if(formName.includes("firm")) formType = "firma";
    else if(formName.includes("hochzeit")) formType = "hochzeit";

    let anlass = anlassRoh;
    if(!anlass){
      if(formType === "hochzeit") anlass = "Hochzeitscatering-Anfrage";
      else if(formType === "firma") anlass = "Firmen-Catering-Anfrage";
      else anlass = "Catering-Anfrage";
    }

    // Datum: Wix liefert für die Tag/Monat/Jahr-Frage zusätzlich ein sauberes
    // ISO-Datum unter einem Schlüssel wie "field:datum_xxxx" — das ist
    // zuverlässiger als den Text ("23. Oktober 2026") selbst zu zerlegen.
    let dateISO = "";
    Object.keys(data).forEach(k=>{
      if(dateISO) return;
      if(/^field:datum/i.test(k) && /^\d{4}-\d{2}-\d{2}$/.test(data[k])) dateISO = data[k];
    });
    if(!dateISO){
      Object.keys(data).forEach(k=>{
        if(dateISO) return;
        if(typeof data[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data[k])) dateISO = data[k];
      });
    }

    const notesParts = [];
    notesParts.push("Automatisch aus Wix-Formular übernommen (" + formType + ").");
    if(budget) notesParts.push("Budget pro Person: " + budget);
    if(sonder) notesParts.push("Sonderleistungen: " + sonder);
    if(nachricht) notesParts.push("Nachricht: " + nachricht);
    if(!dateISO) notesParts.push("⚠️ Datum aus dem Formular konnte nicht gelesen werden — bitte manuell eintragen.");

    const id = "wix-" + Date.now() + "-" + Math.random().toString(36).slice(2,7);
    const todayFallback = new Date().toISOString().slice(0,10);

    const event = {
      id,
      category: "event",
      date: dateISO || todayFallback,
      anlass,
      contactName: ansprechpartner,
      email,
      phone,
      company: firma,
      people,
      art: "Foodtruckcatering",
      address: "",
      notes: notesParts.join("\n"),
      dishes: [],
      nebenkostenOverride: null,
      // Neu eingehende Wix-Anfragen sind noch nicht angenommen -> rot im
      // Kalender, bis Felix sie manuell auf "angenommen" (grün) stellt.
      requestStatus: "anfrage",
      _source: "wix-webhook"
    };

    await db.collection("events").doc(id).set(event);

    // Push-Benachrichtigung an alle Team-Mitglieder, die Push aktiviert haben
    // (Thema "team-all", siehe registerPushToken weiter unten).
    try{
      await admin.messaging().send({
        topic: "team-all",
        notification: {
          title: "Neue Wix-Buchung",
          body: (anlass || "Neue Anfrage") + (dateISO ? " · " + dateISO : "")
        }
      });
    }catch(pushErr){
      console.error("Push bei neuer Wix-Buchung fehlgeschlagen (Termin wurde trotzdem angelegt):", pushErr);
    }

    res.status(200).json({ ok: true, id });
  }catch(err){
    console.error("Fehler beim Verarbeiten der Wix-Anfrage:", err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ============================================================
   Red Lotus — E-Mail-Protokoll per Gemini
   ============================================================
   Empfängt eine Liste von E-Mail-Texten (Betreff/Datum/Absender/
   Inhalt), die der Browser vorher selbst per Gmail-API geholt hat,
   und lässt Gemini daraus eine kurze Fakten-Zusammenfassung
   erstellen. Der Gemini-API-Schlüssel bleibt dabei server-seitig
   (als Firebase-Secret) und wird NIE an den Browser weitergegeben.

   Einrichtung des Secrets (einmalig, im Terminal):
     firebase functions:secrets:set GEMINI_API_KEY
   (dabei den Schlüssel von https://aistudio.google.com/apikey einfügen)
   ============================================================ */
const { defineSecret } = require("firebase-functions/params");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

exports.summarizeEventEmails = onRequest(
  { cors: true, secrets: [GEMINI_API_KEY] },
  async (req, res) => {
    if(req.method !== "POST"){
      res.status(405).send("Method not allowed");
      return;
    }
    const key = req.query.key || (req.body && req.body.key);
    if(key !== "rl_wix_h7k2m9p4"){
      res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
      return;
    }
    try{
      const { emails, eventContext } = req.body || {};
      if(!Array.isArray(emails) || emails.length === 0){
        res.status(200).json({ ok:true, summary: "Keine passenden E-Mails gefunden." });
        return;
      }

      const emailText = emails.map((m, i) =>
        `--- Mail ${i+1} ---\nVon: ${m.from || ""}\nDatum: ${m.date || ""}\nBetreff: ${m.subject || ""}\n\n${(m.body||"").slice(0,3000)}`
      ).join("\n\n");

      const prompt =
`Du bekommst den kompletten E-Mail-Verlauf zu einer Catering-Anfrage bei "Red Lotus Asian Food".
Fasse NUR die konkreten Fakten in Stichpunkten zusammen — keine Höflichkeitsfloskeln, keine Interpretation.
Achte besonders auf: Veranstaltungsdatum, Uhrzeit, Ort/Adresse, Personenzahl, gewünschte Gerichte/Änderungen,
Budget/Preisabsprachen, letzter offener Punkt bzw. wer als Nächstes handeln muss.
Falls eine Angabe widersprüchlich ist (z. B. Personenzahl wurde später geändert), nenne den NEUESTEN Stand
und weise kurz auf die Änderung hin.
Falls etwas nicht in den Mails steht, lass den Punkt einfach weg statt zu raten.

Kontext aus dem Kalender (zum Abgleich, nicht blind übernehmen): ${JSON.stringify(eventContext||{})}

E-Mail-Verlauf:
${emailText}

Gib die Zusammenfassung als kurze Stichpunktliste aus, auf Deutsch.`;

      const apiKey = GEMINI_API_KEY.value();
      // "gemini-flash-latest" ist ein von Google gepflegter Alias, der immer
      // auf das aktuell empfohlene Flash-Modell zeigt — vermeidet, dass die
      // Funktion erneut bricht, wenn ein fest benanntes Modell (wie zuvor
      // "gemini-2.5-flash") abgekündigt/für neue Nutzer gesperrt wird.
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );
      const geminiData = await geminiRes.json();
      const summary = geminiData &&
        geminiData.candidates && geminiData.candidates[0] &&
        geminiData.candidates[0].content && geminiData.candidates[0].content.parts &&
        geminiData.candidates[0].content.parts[0] && geminiData.candidates[0].content.parts[0].text;

      if(!summary){
        console.error("Unerwartete Gemini-Antwort (Status "+geminiRes.status+"):", JSON.stringify(geminiData));
        const geminiErrMsg = geminiData && geminiData.error && geminiData.error.message;
        res.status(500).json({ ok:false, error: "Gemini-Fehler ("+geminiRes.status+"): "+(geminiErrMsg || "keine verwertbare Antwort") });
        return;
      }
      res.status(200).json({ ok:true, summary });
    }catch(err){
      console.error("Fehler beim Erstellen der E-Mail-Zusammenfassung:", err);
      res.status(500).json({ ok:false, error: String(err) });
    }
  }
);

/* ============================================================
   Red Lotus — Team-Zuweisungs-E-Mail
   ============================================================
   Wird vom Kalender aufgerufen, sobald im "Team"-Abschnitt eines
   Termins jemand zugewiesen wird. Verschickt eine kurze
   Benachrichtigungs-Mail per Gmail-SMTP an die zugewiesene Person.

   Einmalige Einrichtung:
   1. Für redlotus.asianfood@gmail.com ein App-Passwort erzeugen:
      Google-Konto -> Sicherheit -> 2-Faktor-Authentifizierung
      aktivieren (falls noch nicht aktiv) -> "App-Passwörter" ->
      neues Passwort für "Mail" erzeugen.
   2. Im Terminal: firebase functions:secrets:set GMAIL_APP_PASSWORD
      (dort das erzeugte App-Passwort einfügen, NICHT das normale
      Gmail-Passwort).
   ============================================================ */
const nodemailer = require("nodemailer");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const SENDER_GMAIL = "redlotus.asianfood@gmail.com";

exports.assignTeamEmail = onRequest(
  { cors: true, secrets: [GMAIL_APP_PASSWORD] },
  async (req, res) => {
    if(req.method !== "POST"){
      res.status(405).send("Method not allowed");
      return;
    }
    const key = req.query.key || (req.body && req.body.key);
    if(key !== WEBHOOK_SECRET){
      res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
      return;
    }
    try{
      const { toEmail, toName, eventName, eventDate, assignedBy, offerSummary } = req.body || {};
      if(!toEmail){
        res.status(400).json({ ok:false, error: "toEmail fehlt" });
        return;
      }

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: SENDER_GMAIL, pass: GMAIL_APP_PASSWORD.value() }
      });

      const dateLabel = eventDate
        ? new Date(eventDate).toLocaleDateString("de-DE", { weekday:"long", day:"2-digit", month:"2-digit", year:"numeric" })
        : "(kein Datum hinterlegt)";

      await transporter.sendMail({
        from: `"Red Lotus Kalender" <${SENDER_GMAIL}>`,
        to: toEmail,
        subject: `Du bist zugewiesen: ${eventName || "Termin"} (${dateLabel})`,
        text:
`Hallo ${toName || ""},

${assignedBy || "Jemand aus dem Team"} hat dich soeben im Kalender folgendem Termin zugewiesen:

Termin: ${eventName || "(ohne Bezeichnung)"}
Datum: ${dateLabel}
${offerSummary ? "\nZusammenfassung des Angebots:\n" + offerSummary + "\n" : ""}
Details findest du im Red-Lotus-Eventkalender.

— Automatische Nachricht aus dem Red-Lotus-Eventkalender, bitte nicht direkt antworten.`
      });

      res.status(200).json({ ok:true });
    }catch(err){
      console.error("Fehler beim Versand der Team-Zuweisungs-Mail:", err);
      res.status(500).json({ ok:false, error: String(err) });
    }
  }
);

/* ============================================================
   Red Lotus — Rechnung per E-Mail an den Kunden
   ============================================================
   Wird vom Kalender aufgerufen, nachdem ein Auftrag über "Auftrag
   abschließen" in eine Rechnung umgewandelt wurde. Felix löst den
   Versand manuell per Klick aus (kein automatischer Versand). Der
   Browser erzeugt das Rechnungs-PDF selbst (html2pdf.js, aus derselben
   Druckansicht, inkl. eventuell manuell angepasster Beträge) und schickt
   es Base64-kodiert hierher — diese Funktion hängt es nur noch an eine
   E-Mail an. Nutzt dieselbe Gmail-SMTP-Einrichtung wie assignTeamEmail
   (GMAIL_APP_PASSWORD).
   ============================================================ */
exports.sendInvoiceEmail = onRequest(
  { cors: true, secrets: [GMAIL_APP_PASSWORD] },
  async (req, res) => {
    if(req.method !== "POST"){
      res.status(405).send("Method not allowed");
      return;
    }
    const key = req.query.key || (req.body && req.body.key);
    if(key !== WEBHOOK_SECRET){
      res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
      return;
    }
    try{
      const { toEmail, toName, eventName, invoiceNo, pdfBase64 } = req.body || {};
      if(!toEmail){
        res.status(400).json({ ok:false, error: "toEmail fehlt" });
        return;
      }
      if(!pdfBase64){
        res.status(400).json({ ok:false, error: "pdfBase64 fehlt" });
        return;
      }

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: SENDER_GMAIL, pass: GMAIL_APP_PASSWORD.value() }
      });

      const pdfBuffer = Buffer.from(pdfBase64, "base64");

      await transporter.sendMail({
        from: `"Red Lotus Asian Food" <${SENDER_GMAIL}>`,
        to: toEmail,
        subject: `Ihre Rechnung${invoiceNo ? " " + invoiceNo : ""} — ${eventName || "Catering"}`,
        text:
`Hallo ${toName || ""},

anbei erhalten Sie die Rechnung${invoiceNo ? " (Nr. " + invoiceNo + ")" : ""} zu Ihrem Catering-Auftrag "${eventName || ""}".

Bei Fragen melden Sie sich gerne jederzeit.

Viele Grüße
Red Lotus Asian Food`,
        attachments: [
          { filename: `Rechnung${invoiceNo ? "-" + invoiceNo : ""}.pdf`, content: pdfBuffer, contentType: "application/pdf" }
        ]
      });

      res.status(200).json({ ok:true });
    }catch(err){
      console.error("Fehler beim Versand der Rechnungs-Mail:", err);
      res.status(500).json({ ok:false, error: String(err) });
    }
  }
);

/* ============================================================
   Red Lotus — Inventar-/Ablaufliste per E-Mail an Mitarbeiter
   ============================================================
   Wird vom Kalender aufgerufen, wenn Felix eine Inventar- oder
   Ablaufliste an ausgewählte Team-Mitglieder verschickt. Der Browser
   erzeugt das PDF selbst (html2pdf.js, aus der Druckansicht mit
   aktuellem Abhak-Stand) und schickt es Base64-kodiert hierher — diese
   Funktion hängt es nur noch an eine E-Mail an. Nutzt dieselbe
   Gmail-SMTP-Einrichtung wie assignTeamEmail/sendInvoiceEmail
   (GMAIL_APP_PASSWORD).
   ============================================================ */
exports.sendChecklistEmail = onRequest(
  { cors: true, secrets: [GMAIL_APP_PASSWORD] },
  async (req, res) => {
    if(req.method !== "POST"){
      res.status(405).send("Method not allowed");
      return;
    }
    const key = req.query.key || (req.body && req.body.key);
    if(key !== WEBHOOK_SECRET){
      res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
      return;
    }
    try{
      const { toEmail, toName, listTitle, eventName, eventDate, pdfBase64 } = req.body || {};
      if(!toEmail){
        res.status(400).json({ ok:false, error: "toEmail fehlt" });
        return;
      }
      if(!pdfBase64){
        res.status(400).json({ ok:false, error: "pdfBase64 fehlt" });
        return;
      }

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: SENDER_GMAIL, pass: GMAIL_APP_PASSWORD.value() }
      });

      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      const dateLabel = eventDate
        ? new Date(eventDate).toLocaleDateString("de-DE", { weekday:"long", day:"2-digit", month:"2-digit", year:"numeric" })
        : "(kein Datum hinterlegt)";
      const title = listTitle || "Liste";

      await transporter.sendMail({
        from: `"Red Lotus Kalender" <${SENDER_GMAIL}>`,
        to: toEmail,
        subject: `${title}: ${eventName || "Termin"} (${dateLabel})`,
        text:
`Hallo ${toName || ""},

anbei die ${title} zu "${eventName || "(ohne Bezeichnung)"}" am ${dateLabel}.

— Automatische Nachricht aus dem Red-Lotus-Eventkalender, bitte nicht direkt antworten.`,
        attachments: [
          { filename: `${title}.pdf`, content: pdfBuffer, contentType: "application/pdf" }
        ]
      });

      res.status(200).json({ ok:true });
    }catch(err){
      console.error("Fehler beim Versand der Checklisten-Mail:", err);
      res.status(500).json({ ok:false, error: String(err) });
    }
  }
);

/* ============================================================
   Red Lotus — Push-Token registrieren
   ============================================================
   Wird vom Kalender aufgerufen, nachdem im Browser die Push-
   Berechtigung erteilt und ein FCM-Token erzeugt wurde. Abonniert
   das Gerät serverseitig für das Thema "team-all" — darüber laufen
   alle Broadcast-Benachrichtigungen (neue Wix-Buchung, Termin-
   Erinnerung). Eine feinere Zuordnung nach Person/Team-Zuweisung
   gibt es aktuell nicht — alle mit aktivierten Push-Benachrichtigungen
   bekommen alle Broadcasts.
   ============================================================ */
exports.registerPushToken = onRequest({ cors: true }, async (req, res) => {
  if(req.method !== "POST"){
    res.status(405).send("Method not allowed");
    return;
  }
  const key = req.query.key || (req.body && req.body.key);
  if(key !== WEBHOOK_SECRET){
    res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
    return;
  }
  try{
    const { token, email } = req.body || {};
    if(!token){
      res.status(400).json({ ok:false, error: "token fehlt" });
      return;
    }
    await admin.messaging().subscribeToTopic([token], "team-all");
    // Token zusätzlich in Firestore ablegen (nützlich für spätere Auswertung/Debugging).
    await db.collection("pushTokens").doc(token).set({
      token, email: email || "", updatedAt: new Date().toISOString()
    });
    res.status(200).json({ ok:true });
  }catch(err){
    console.error("Fehler beim Registrieren des Push-Tokens:", err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ============================================================
   Red Lotus — Bestellsystem (Preisrechner -> Küchen-/Kundenbildschirm)
   ============================================================
   Legt eine neue Bestellung an und vergibt eine Nummer, die jeden
   Tag (Europe/Berlin) wieder bei 1 beginnt. Läuft bewusst über
   diese Cloud Function statt über einen direkten Firestore-Schreib-
   zugriff vom Preisrechner aus — so können Küchen- und Kunden-
   bildschirm ohne Login nur LESEN (siehe firestore.rules: "create"
   auf der Collection "orders" ist dort komplett gesperrt, nur diese
   Funktion darf per Admin-SDK schreiben).
   ============================================================ */
function berlinDateISO(){
  // Datumsteil in der Zeitzone Europe/Berlin, unabhängig vom Server-Standort
  // der Cloud Function (die läuft standardmäßig in UTC).
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}

exports.createOrder = onRequest({ cors: true }, async (req, res) => {
  if(req.method !== "POST"){
    res.status(405).send("Method not allowed");
    return;
  }
  const key = req.query.key || (req.body && req.body.key);
  if(key !== WEBHOOK_SECRET){
    res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
    return;
  }
  try{
    const { items, total, box, dineMode, isVorbestellung, pickupTime, customerName } = req.body || {};
    if(!Array.isArray(items) || items.length === 0){
      res.status(400).json({ ok:false, error: "items fehlt oder leer" });
      return;
    }
    const today = berlinDateISO();

    // Tagesnummer atomar per Transaktion vergeben (verhindert doppelte
    // Nummern, falls zwei Bestellungen im selben Moment reinkommen).
    const counterRef = db.collection("orderCounters").doc(today);
    const number = await db.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef);
      const next = (snap.exists ? snap.data().count : 0) + 1;
      tx.set(counterRef, { count: next, date: today }, { merge: true });
      return next;
    });

    const id = "order-" + Date.now() + "-" + Math.random().toString(36).slice(2,7);
    const order = {
      id,
      number,
      date: today,
      items,
      total: total || 0,
      box: box || null,
      // 'togo' oder 'hier' — steuert Verpackung/Ausgabe, wird auf Küchen-
      // und Kundenbildschirm neben der Bestellnummer angezeigt.
      dineMode: dineMode === "hier" ? "hier" : "togo",
      isVorbestellung: !!isVorbestellung,
      pickupTime: pickupTime || null,
      customerName: customerName || null,
      // Sofortbestellungen werden bei Aufnahme direkt kassiert -> gelten
      // ab Anlage als bezahlt. Vorbestellungen werden erst bei Abholung
      // bezahlt -> "paid" bleibt false, bis im Preisrechner "💰 Bezahlt"
      // in der Vorbestellungen-Liste gedrückt wird.
      paid: !isVorbestellung,
      // Sofortbestellungen sind sofort auf dem Küchenboard sichtbar.
      // Vorbestellungen starten "unreleased" (versteckt in der
      // Vorbestellungen-Vorschau), damit sie das Board nicht Stunden vor
      // Abholung zumüllen. Felix setzt "released" im Preisrechner manuell,
      // sobald der Kunde tatsächlich da ist/sich meldet.
      released: !isVorbestellung,
      status: "offen",
      createdAt: new Date().toISOString(),
      readyAt: null
    };
    await db.collection("orders").doc(id).set(order);
    res.status(200).json({ ok:true, id, number });
  }catch(err){
    console.error("Fehler beim Anlegen der Bestellung:", err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ============================================================
   Red Lotus — Bestellstatus für Kunden (öffentlich, ohne Login)
   ============================================================
   Wird von bestellstatus.html aufgerufen — der Kunde scannt einen fest
   aufgestellten QR-Code, tippt seine Bestellnummer ein und sieht live,
   ob seine Bestellung noch zubereitet wird oder schon fertig ist.
   Bewusst OHNE WEBHOOK_SECRET (öffentlich erreichbar, kein Login/Cookie
   nötig) und liefert nur die für den Kunden nötigen, unkritischen Felder
   zurück — keine internen Preise, keine Team-/Kalenderdaten.
   ============================================================ */
exports.getOrderStatus = onRequest({ cors: true }, async (req, res) => {
  try{
    const numberRaw = req.query.nr;
    const number = parseInt(numberRaw, 10);
    if(!numberRaw || isNaN(number) || number <= 0){
      res.status(400).json({ ok:false, error: "Ungültige oder fehlende Bestellnummer." });
      return;
    }
    // Ohne Datumsangabe wird der aktuelle Tag (Europe/Berlin) angenommen —
    // deckt den normalen Fall ab, dass der Kunde kurz nach der Bestellung
    // scannt. "gestern" wird als Fallback mitgeprüft, falls kurz nach
    // Mitternacht bestellt und gescannt wird.
    const today = berlinDateISO();
    const yesterday = (() => {
      const d = new Date(today + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    let snap = await db.collection("orders")
      .where("date", "==", today)
      .where("number", "==", number)
      .limit(1)
      .get();
    if(snap.empty){
      snap = await db.collection("orders")
        .where("date", "==", yesterday)
        .where("number", "==", number)
        .limit(1)
        .get();
    }
    if(snap.empty){
      res.status(200).json({ ok:true, found:false });
      return;
    }
    const o = snap.docs[0].data();
    res.status(200).json({
      ok:true,
      found:true,
      number: o.number,
      status: o.status, // 'offen' | 'fertig' | 'archiviert'
      dineMode: o.dineMode,
      isVorbestellung: !!o.isVorbestellung,
      pickupTime: o.pickupTime || null,
      items: Array.isArray(o.items) ? o.items.map(it => it.label || "Posten") : []
    });
  }catch(err){
    console.error("Fehler bei getOrderStatus:", err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ============================================================
   Red Lotus — Bestellsystem: Session zurücksetzen
   ============================================================
   Wird vom Küchenbildschirm aufgerufen (Button "Neue Session"),
   z. B. wenn ein Verkauf/Markt vorbei ist und die Nummerierung für
   den nächsten wieder bei 1 starten soll. Archiviert alle aktuell
   offenen/fertigen Bestellungen (Status "archiviert", verschwinden
   damit von Küchen- und Kundenbildschirm) und setzt den Tages-
   zähler auf 0 zurück.
   ============================================================ */
exports.resetOrders = onRequest({ cors: true }, async (req, res) => {
  if(req.method !== "POST"){
    res.status(405).send("Method not allowed");
    return;
  }
  const key = req.query.key || (req.body && req.body.key);
  if(key !== WEBHOOK_SECRET){
    res.status(403).send("Forbidden — falscher oder fehlender Schlüssel");
    return;
  }
  try{
    const today = berlinDateISO();

    const snap = await db.collection("orders").where("status", "in", ["offen", "fertig"]).get();
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { status: "archiviert" }));
    await batch.commit();

    await db.collection("orderCounters").doc(today).set({ count: 0, date: today }, { merge: true });

    res.status(200).json({ ok:true, archiviert: snap.size });
  }catch(err){
    console.error("Fehler beim Zurücksetzen der Bestellungen:", err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

/* ============================================================
   Red Lotus — Erinnerung an bevorstehende Termine
   ============================================================
   Läuft automatisch jeden Morgen um 8:00 Uhr (Europe/Berlin) und
   schickt eine Push-Benachrichtigung für jeden Termin, der GENAU
   morgen stattfindet, an alle Geräte mit aktivierten Push-
   Benachrichtigungen (Thema "team-all").
   ============================================================ */
exports.sendUpcomingEventReminders = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Europe/Berlin" },
  async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = tomorrow.toISOString().slice(0, 10);

    const snap = await db.collection("events").where("date", "==", tomorrowISO).get();
    if(snap.empty){
      console.log("Keine Termine morgen (" + tomorrowISO + ") — keine Erinnerung nötig.");
      return;
    }
    for(const doc of snap.docs){
      const evt = doc.data();
      try{
        await admin.messaging().send({
          topic: "team-all",
          notification: {
            title: "Termin morgen: " + (evt.anlass || "Ohne Bezeichnung"),
            body: (evt.people ? evt.people + " Personen · " : "") + tomorrowISO
          }
        });
      }catch(pushErr){
        console.error("Erinnerung für Termin " + doc.id + " fehlgeschlagen:", pushErr);
      }
    }
    console.log(tomorrowISO + ": " + snap.size + " Erinnerung(en) verschickt.");
  }
);

/* ============================================================
   Red Lotus — Alice: fällige Erinnerungen als Push verschicken
   ============================================================
   Läuft alle 10 Minuten. Sucht in "reminders" nach Einträgen, deren
   dueAt (ISO-String "YYYY-MM-DDTHH:MM") erreicht ist und die noch
   nicht verschickt wurden, und schickt eine gezielte Push-
   Benachrichtigung NUR an die Geräte der Person, die die Erinnerung
   angelegt hat (forEmail) — nicht an das ganze Team, wie bei den
   allgemeinen Termin-Erinnerungen weiter unten.
   ============================================================ */
exports.sendDueReminders = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Europe/Berlin" },
  async () => {
    const nowISO = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date()).replace(" ", "T");

    // Nur eine Gleichheits-Filterbedingung in der Query (kein zweiter
    // Bereichsfilter auf "dueAt") — so ist kein zusätzlicher Firestore-
    // Composite-Index nötig. Der Zeitvergleich passiert stattdessen im Code;
    // bei der überschaubaren Anzahl gleichzeitig offener Erinnerungen ist
    // das unproblematisch.
    const snap = await db.collection("reminders").where("sent", "==", false).get();
    const due = snap.docs.filter((d) => (d.data().dueAt || "") <= nowISO);
    if(!due.length) return;

    for(const doc of due){
      const r = doc.data();
      try{
        if(r.forEmail){
          const tokensSnap = await db.collection("pushTokens").where("email", "==", r.forEmail).get();
          for(const tDoc of tokensSnap.docs){
            try{
              await admin.messaging().send({
                token: tDoc.id,
                notification: { title: "⏰ Erinnerung", body: r.text || "" }
              });
            }catch(sendErr){
              console.error("Erinnerung-Push an Token " + tDoc.id + " fehlgeschlagen:", sendErr);
            }
          }
        }
        await doc.ref.set({ sent: true }, { merge: true });
      }catch(e){
        console.error("Erinnerung " + doc.id + " konnte nicht verarbeitet werden:", e);
      }
    }
  }
);

/* ============================================================
   Red Lotus — Alice (E-Mail-Sekretärin): Brücke zwischen dem
   täglichen Claude-Scheduled-Task (hat Gmail-/Kalender-Zugriff,
   aber keinen Firebase-Login) und der Firestore-Datenbank.
   ============================================================
   Ein einfacher, geheimer Schlüssel (Header "x-secretary-secret"
   oder ?secret=...) schützt den Endpunkt — gleiches Prinzip wie
   beim Wix-Webhook oben. Aktionen (im JSON-Body "action"):

   - upsertItems              { items:[{id (=threadId), subject, sender,
                                 herkunft, dringlichkeit, summary, hasDraft},
                                 ...] } — ein Dokument pro Mail-Thread in
                                 "secretary_items", source wird auf "mail"
                                 gesetzt, status startet bei "inbox".
   - writeCalendarSuggestions { suggestions:[{id?,title,date,startTime,
                                 endTime,notes,sourceThreadId,
                                 sourceSubject,status?}, ...] }
   - listApprovedSuggestions  liefert alle mit status "freigegeben"
   - markSuggestionDone       { id, eventId?, status? } (Default "angelegt")
   ============================================================ */
const SECRETARY_SECRET = "rl_alice_q8n4x2wj7t";

exports.secretaryApi = onRequest({ cors: true }, async (req, res) => {
  try{
    const secret = req.get("x-secretary-secret") || req.query.secret;
    if(secret !== SECRETARY_SECRET){
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const body = req.body || {};
    const action = body.action || req.query.action;

    if(action === "upsertItems"){
      const items = body.items || [];
      if(!items.length){ res.json({ ok: true, count: 0 }); return; }
      const batch = db.batch();
      items.forEach((it) => {
        if(!it.id) return; // threadId ist Pflicht — sonst keine stabile Dokument-ID
        const { id, ...rest } = it;
        const ref = db.collection("secretary_items").doc(id);
        batch.set(ref, {
          ...rest,
          source: "mail",
          status: "inbox",
          snoozeUntil: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });
      await batch.commit();
      res.json({ ok: true, count: items.length });
      return;
    }

    if(action === "writeCalendarSuggestions"){
      const suggestions = body.suggestions || [];
      const batch = db.batch();
      suggestions.forEach((s) => {
        const ref = s.id
          ? db.collection("calendar_suggestions").doc(s.id)
          : db.collection("calendar_suggestions").doc();
        const { id, ...rest } = s;
        batch.set(ref, {
          ...rest,
          status: rest.status || "vorgeschlagen",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });
      await batch.commit();
      res.json({ ok: true });
      return;
    }

    if(action === "listApprovedSuggestions"){
      const snap = await db.collection("calendar_suggestions").where("status", "==", "freigegeben").get();
      res.json({ suggestions: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
      return;
    }

    if(action === "markSuggestionDone"){
      const { id, eventId, status } = body;
      if(!id){ res.status(400).json({ error: "id fehlt" }); return; }
      await db.collection("calendar_suggestions").doc(id).set({
        status: status || "angelegt",
        createdEventId: eventId || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      res.json({ ok: true });
      return;
    }

    res.status(400).json({ error: "unbekannte action" });
  }catch(e){
    console.error("secretaryApi Fehler:", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});
