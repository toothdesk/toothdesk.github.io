/* DentalBot AI — hybrid FAQ + booking chat widget for dental clinics.
 * One-line install: <script src="https://<pages-host>/<clinic-slug>/bot.js"></script>
 * Per-clinic builds inline the config below via build.js. Zero dependencies.
 *
 * FLOW:
 *   1. A deterministic booking engine runs first. It scans EVERY visitor
 *      message for booking fields (name, phone, service, date, time),
 *      remembers them across the whole conversation, validates day/time
 *      against the clinic's structured hours, shows a summary, and only
 *      submits on the visitor's confirmation. A pure callback request
 *      (name + phone only) is still supported and labelled CALLBACK.
 *   2. Rule-based FAQ brain runs. A confident match answers instantly,
 *      with NO network call.
 *   3. On no-match, the question goes to the AI proxy (cfg.aiEndpoint,
 *      a Cloudflare Worker) together with the clinic's approved fact sheet.
 *   4. If the AI call fails, times out (> cfg.aiTimeoutMs, default 20s),
 *      or returns an error (e.g. free-tier quota), the widget falls back
 *      to the standard rule-based fallback message + quick-reply chips.
 *      The bot never appears dead.
 *
 * HONEST CONFIRMATION: the bot NEVER claims a slot is guaranteed or
 * that a clinic calendar was updated. A confirmed booking is submitted
 * to the clinic instantly (FormSubmit relay) and the visitor is told
 * the clinic will confirm the slot by phone/text shortly.
 */
(function () {
  'use strict';

  var DEFAULTS = {
    clinicName: 'Bright Smile Dental',
    tagline: 'How can we help your smile today?',
    phone: '(555) 123-4567',
    email: 'hello@example.com',   // leads are emailed here (free FormSubmit relay)
    address: '123 Main St',
    hours: 'Mon–Fri 9am–5pm',
    color: '#0d9488',
    services: ['Cleanings', 'Fillings', 'Whitening', 'Braces', 'Implants', 'Root canals'],
    /* --- AI layer (new in this variant) --- */
    prices: '',              // clinic-approved prices ONLY, e.g. "Exam & cleaning: $99"
    insuranceNote: '',       // clinic-approved insurance note, e.g. "In-network with Delta Dental"
    aiEndpoint: '',          // Cloudflare Worker URL; empty = AI disabled, pure rule-based
    aiClinicId: '',          // must match a key in the Worker's CLINICS map
    aiToken: '',             // per-clinic token checked by the Worker
    aiTimeoutMs: 20000,      // give up on the AI after this long and fall back
    hoursStructured: null    // {mon:[openMin,closeMin],...,sun:null} — enables booking day/time validation
  };
  /*__CLINIC_CONFIG__*/
  var cfg = {};
  for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
  var userCfg = (typeof window !== 'undefined' && window.__DENTAL_BOT__) || {};
  for (var k2 in userCfg) cfg[k2] = userCfg[k2];

  /* ---------- FAQ brain (word-boundary keyword scoring) ---------- */
  function keyRe(key) {
    // word-boundary match with optional plural "s" ("hour" matches "hours", "patient" matches "patients")
    return new RegExp('\\b' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + 's?\\b', 'i');
  }

  var GREETING_RE = /^(hi|hey|hello|hiya|howdy|yo|good\s?morning|good\s?afternoon|good\s?evening|how are you|how\'s it going)\b/i;

  var INTENTS = [
    { id: 'emergency', keys: ['emergency', 'pain', 'hurt', 'hurting', 'hurts', 'ache', 'toothache', 'sore', 'throbbing', 'painful', 'swollen', 'swelling', 'bleeding', 'broke', 'chipped', 'knocked'],
      reply: function () { return 'Sorry to hear that. For urgent dental pain, please call us right away at ' + cfg.phone + ' — we keep same-day emergency slots.'; } },
    { id: 'identity', keys: ['robot', 'chatbot', 'real person', 'human being', 'automated', 'actual person'],
      reply: function () { return 'I\'m an automated assistant for ' + cfg.clinicName + ' — I can answer questions here and help you book a visit. If you\'d rather talk to a person, our front desk is at ' + cfg.phone + ' (' + cfg.hours + ').'; } },
    { id: 'pricing', keys: ['price', 'cost', 'much', 'fee', 'charge', 'insurance', 'insur', 'payment', 'pay'],
      reply: function () { return 'Costs vary by treatment and insurance, so I don\'t want to guess at an exact price. Our front desk can give you exact pricing for a specific treatment — call ' + cfg.phone + '.'; } },
    { id: 'booking', keys: ['book', 'appointment', 'appoint', 'visit', 'schedule', 'reserve', 'slot'],
      reply: function () { return 'I can help you book a visit right here — just tell me the service, the day and time you\'d like, and your name and phone number.'; } },
    { id: 'hours', keys: ['hour', 'open', 'close', 'when are you', 'timing'],
      reply: function () { return 'We are open ' + cfg.hours + '.'; } },
    { id: 'location', keys: ['where', 'location', 'address', 'direction', 'park'],
      reply: function () { return 'You can find us at ' + cfg.address + '. Call ' + cfg.phone + ' if you need directions!'; } },
    { id: 'contact', keys: ['contact', 'e-mail', 'email'],
      reply: function () { return 'Here is how to reach us:\n📞 ' + cfg.phone + '\n✉️ ' + cfg.email + '\n📍 ' + cfg.address + '\n🕐 ' + cfg.hours; } },
    { id: 'newpatient', keys: ['new patient', 'first visit', 'join'],
      reply: function () { return 'We love welcoming new patients! I can help you book your first visit right here — just tell me a day and time that suits you.'; } },
    { id: 'services', keys: ['service', 'offer', 'treatment', 'do you do', 'cleaning', 'whiten', 'brace', 'implant', 'filling', 'crown', 'root canal', 'extraction', 'denture', 'veneer'],
      reply: function () { return 'We offer: ' + cfg.services.join(', ') + '. Anything specific I can help with?'; } },
    { id: 'human', keys: ['human', 'person', 'real', 'staff', 'receptionist', 'phone number', 'telephone'],
      reply: function () { return 'Of course — you can reach our front desk at ' + cfg.phone + ' (' + cfg.hours + ').'; } },
    { id: 'thanks', keys: ['thank', 'thanks', 'great', 'bye', 'goodbye', 'see you'],
      reply: function () { return 'You are very welcome! We look forward to seeing your smile at ' + cfg.clinicName + '. 😊'; } }
  ];
  INTENTS.forEach(function (in_) { in_.res = in_.keys.map(keyRe); });

  function scoreIntents(t, skipId) {
    var best = null, bestScore = 0;
    for (var i = 0; i < INTENTS.length; i++) {
      if (skipId && INTENTS[i].id === skipId) continue;
      var s = 0;
      for (var j = 0; j < INTENTS[i].res.length; j++) {
        if (INTENTS[i].res[j].test(t)) s++;
      }
      // The emergency intent wins ties: a pain message must never lose
      // to a generic intent with the same keyword count.
      if (s > bestScore || (s === bestScore && s > 0 && INTENTS[i].id === 'emergency')) { bestScore = s; best = INTENTS[i]; }
    }
    return best;
  }

  function greetingReply() {
    return 'Hello! 👋 Welcome to ' + cfg.clinicName + '. Ask me about our hours, services, or pricing — or tap below and I\'ll help you book a visit.';
  }

  var FALLBACK_REPLY = 'Good question! I can help with hours, services, pricing, booking, or contact details — tap a topic below or type "call me" and our team will ring you back.';

  /* Returns { text, id, greeting } for a confident rule-based answer,
   * or null when the brain has no match (that is the signal to try the
   * AI layer). skipBooking=true ignores the booking intent (used when
   * the booking engine is already handling the message and only wants
   * the FAQ part of a mixed message). */
  function matchAnswer(text, skipBooking) {
    var t = text.trim();
    // Pure greeting ("hi", "hey!", "good morning") -> warm hello, never the fallback.
    if (GREETING_RE.test(t) && t.replace(GREETING_RE, '').replace(/[!.,?\s]/g, '').length <= 20) {
      var rest = t.replace(GREETING_RE, '').trim();
      var sub = rest ? scoreIntents(rest, skipBooking ? 'booking' : null) : null;
      if (sub) return { text: sub.reply(), id: sub.id, greeting: false };  // "hi, what are your hours?" -> hours answer
      return { text: greetingReply(), id: 'greeting', greeting: true };    // "hi" -> hello
    }
    // "Are you a robot / a real person?" -> always the honest identity answer.
    if (/(are you|you're|you are)\b[^.!?]{0,24}\b(robot|bot|chatbot|real person|human|person|ai|automated)\b/i.test(t) || /\b(robot|chatbot)\b/i.test(t)) {
      var idn = null;
      for (var ii = 0; ii < INTENTS.length; ii++) if (INTENTS[ii].id === 'identity') idn = INTENTS[ii];
      return { text: idn.reply(), id: 'identity', greeting: false };
    }
    var best = scoreIntents(t.toLowerCase(), skipBooking ? 'booking' : null);
    if (best) return { text: best.reply(), id: best.id, greeting: false };
    return null;
  }

  /* ---------- AI layer ---------- */
  var history = []; // [{role:'user'|'bot', text:'...'}], capped, sent for context

  /* The clinic's approved fact sheet. This is ALL the AI is allowed to
   * answer from — it is sent with every request and the Worker locks the
   * model to it in the system prompt. Nothing here, no answer. */
  function buildFacts() {
    return {
      clinic: cfg.clinicName,
      phone: cfg.phone,
      email: cfg.email,
      address: cfg.address,
      hours: cfg.hours,
      services: cfg.services,
      prices: cfg.prices || 'not provided — the front desk will confirm pricing',
      insurance: cfg.insuranceNote || 'not provided — the front desk will confirm coverage'
    };
  }

  /* Ask the AI proxy. Resolves with the reply string, or null on ANY
   * problem (no endpoint configured, network error, timeout, HTTP error,
   * quota, malformed response) so the caller can fall back gracefully. */
  function callAI(userText) {
    if (!cfg.aiEndpoint) return Promise.resolve(null);
    var timeoutMs = cfg.aiTimeoutMs || 20000;
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var body = {
      clinicId: cfg.aiClinicId,
      token: cfg.aiToken,
      message: userText,
      // Prior turns only: history already ends with this user message
      // (addMsg pushed it), and the Worker appends `message` itself.
      history: history.slice(-11, -1),
      facts: buildFacts()
    };
    var fetchPromise;
    try {
      fetchPromise = fetch(cfg.aiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      }).then(function (r) {
        if (!r.ok) throw new Error('ai http ' + r.status);
        return r.json();
      }).then(function (j) {
        if (j && typeof j.reply === 'string' && j.reply.replace(/\s+/g, '').length) {
          // Client-side guardrail: hard-cap the displayed length.
          return j.reply.trim().slice(0, 900);
        }
        throw new Error('ai bad reply');
      });
    } catch (e) {
      return Promise.resolve(null);
    }
    var timeoutPromise = new Promise(function (resolve) {
      setTimeout(function () {
        if (controller) { try { controller.abort(); } catch (e) { /* noop */ } }
        resolve(null);
      }, timeoutMs);
    });
    return Promise.race([fetchPromise, timeoutPromise]).then(function (v) {
      return (typeof v === 'string' && v) ? v : null;
    }, function () { return null; });
  }

  /* ---------- Booking engine ----------
   * Deterministic state layer alongside the FAQ brain. A persistent
   * `booking` object remembers name / phone / service / date / time /
   * note across the WHOLE conversation. EVERY visitor message is
   * scanned for any of those fields, in any state, so a visitor can
   * give everything in one message, answer questions out of order, or
   * correct a detail at any point (including after completion)
   * without ever restarting the flow.
   *
   * Dates/times are validated against cfg.hoursStructured when the
   * clinic provides it: closed days and out-of-hours times are called
   * out plainly with the nearest valid alternatives. Impossible dates
   * (February 30) and impossible times (25:00) are rejected with a
   * friendly re-ask. Holidays are never validated (unknown) — a
   * specific-date request is fine; the clinic confirms.
   *
   * HONEST CONFIRMATION: nothing is submitted until the visitor
   * confirms the summary. The submission goes to the clinic instantly
   * via the FormSubmit relay; the visitor is told the clinic will
   * confirm the slot by phone/text shortly. The bot never claims a
   * slot is guaranteed or a calendar was updated. */
  var booking = null;
  function freshBooking() {
    return {
      mode: 'booking',           // 'booking' | 'callback'
      state: 'idle',             // idle | collecting | confirm | done | cancelled
      name: '', phone: '', service: '',
      dateISO: '', dateText: '', timeMin: null, timeText: '',
      note: '', ref: '', transcript: [],
      lastAsked: null, suggestion: null
    };
  }
  booking = freshBooking();
  var softOfferUsed = false;   // rule templates: at most ONE soft booking offer per conversation
  var softOfferOpen = false;   // a soft offer is on the table (a "yes" starts the booking flow)
  var visitorDeclined = false; // visitor declined an offer -> never offer again

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function capName(s) { return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function fmtMin(min) {
    var h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + pad2(m) + ' ' + ap;
  }
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function fmtDate(dt) { return DAY_NAMES[dt.getDay()] + ', ' + MONTH_NAMES[dt.getMonth()] + ' ' + dt.getDate(); }
  function todayStart() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function mkDate(y, m, d) { var dt = new Date(y, m, d); return (dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d) ? dt : null; }
  function isoOf(dt) { return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()); }
  function dateFromISO(iso) { var p = String(iso).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dayKey(dt) { return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()]; }
  /* hoursFor: undefined = no structured hours configured (no validation);
   * null = clinic closed that day; [openMin, closeMin] otherwise. */
  function hoursFor(dt) {
    if (!cfg.hoursStructured) return undefined;
    var r = cfg.hoursStructured[dayKey(dt)];
    return r ? r : null;
  }
  function nextOpenDay(fromDt, wantMin) {
    for (var i = 1; i <= 7; i++) {
      var d = new Date(fromDt.getFullYear(), fromDt.getMonth(), fromDt.getDate() + i);
      var hrs = hoursFor(d);
      if (hrs) {
        var t = (wantMin !== null && wantMin !== undefined && wantMin >= hrs[0] && wantMin < hrs[1]) ? wantMin : hrs[0];
        return { dateISO: isoOf(d), dateText: fmtDate(d), timeMin: t, timeText: fmtMin(t), hrs: hrs };
      }
    }
    return null;
  }

  /* ----- field scanners (run on EVERY message) ----- */
  function sanitizePhone(raw) {
    var s = String(raw).trim();
    s = s.replace(/^[^+\d(]+/, '').replace(/[^0-9)]+$/, ''); // strips a trailing sentence period etc.
    return s.replace(/\s+/g, ' ');
  }
  function scanPhone(text) {
    var masked = String(text).replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, ' '); // hide ISO dates first
    var cands = masked.match(/\+?[\d(][\d\s().\-]{5,}\d/g) || [];
    for (var i = 0; i < cands.length; i++) {
      var digits = cands[i].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) return sanitizePhone(cands[i]);
    }
    return null;
  }
  function cleanName(raw) {
    var s = String(raw).replace(/[^a-zA-Z .'\-]/g, ' ').replace(/\s+/g, ' ').trim();
    var words = s.split(' ').filter(function (w) { return w && !/^(and|my|the|i|a|an|phone|number|is)$/i.test(w); });
    s = words.slice(0, 3).join(' ');
    return s ? capName(s) : '';
  }
  function scanName(text) {
    var m = text.match(/my name is\s+([a-zA-Z][a-zA-Z .'\-]{1,39})/i);
    if (m) return cleanName(m[1]) || null;
    m = text.match(/(?:[Tt]his is|[Ii]t'?s|[Ii] am|[Ii]'m)\s+([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)?)/);
    if (m && !/^(interested|looking|calling|here|a|an|the|new|not|just|trying|wondering|hoping|fine|good|ok|sick|hurt|hurting)$/i.test(m[1].split(' ')[0])) {
      return cleanName(m[1]) || null;
    }
    return null;
  }
  var SERVICE_ALIASES = {
    'cleanings': ['cleaning', 'clean', 'checkup', 'check-up', 'check up', 'exam'],
    'whitening': ['whitening', 'whiten', 'bleaching'],
    'braces': ['braces', 'brace', 'orthodontics'],
    'implants': ['implant'],
    'fillings': ['filling', 'cavity'],
    'crowns': ['crown'],
    'root canals': ['root canal']
  };
  function scanService(text) {
    var t = text.toLowerCase();
    for (var i = 0; i < cfg.services.length; i++) {
      var svc = cfg.services[i], key = svc.toLowerCase();
      var keys = [key, key.replace(/s$/, '')];
      if (SERVICE_ALIASES[key]) keys = keys.concat(SERVICE_ALIASES[key]);
      for (var j = 0; j < keys.length; j++) {
        var re = new RegExp('\\b' + keys[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (re.test(t)) return svc;
      }
    }
    var m = t.match(/\bfor an?\s+([a-z][a-z\- ]{2,28}?)(?=\s+(?:on|at|next|this|tomorrow|today)\b|[.,!?;]|$)/) ||
            t.match(/\bbook(?:ing)?\s+(?:me\s+)?(?:for\s+)?an?\s+([a-z][a-z\- ]{2,28}?)(?=\s+(?:on|at|next|this|tomorrow|today)\b|[.,!?;]|$)/);
    if (m) {
      var phrase = m[1].trim();
      if (phrase && phrase.split(' ').length <= 4 &&
          !/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(phrase) &&
          !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(phrase)) {
        return capName(phrase);
      }
    }
    return null;
  }
  var MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  var WEEKDAY_IDX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  /* parseDate -> { iso, text } | { error: 'impossible' | 'past' } | null */
  function parseDate(text) {
    var t = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
    var today = todayStart();
    var m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      var d0 = mkDate(+m[1], +m[2] - 1, +m[3]);
      if (!d0) return { error: 'impossible' };
      if (d0 < today) return { error: 'past' };
      return { iso: isoOf(d0), text: fmtDate(d0) };
    }
    var MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)';
    var mA = t.match(new RegExp('\\b' + MON + '[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4}))?'));
    var mB = t.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MON + '[a-z]*\\b(?:\\s*,?\\s*(\\d{4}))?'));
    if (mA || mB) {
      var monIdx = mA ? MONTH_IDX[mA[1]] : MONTH_IDX[mB[2]];
      var day = mA ? +mA[2] : +mB[1];
      var year = (mA ? mA[3] : mB[3]) ? +(mA ? mA[3] : mB[3]) : null;
      var y = year || today.getFullYear();
      var d1 = mkDate(y, monIdx, day);
      if (!d1) return { error: 'impossible' };
      if (!year && d1 < today) { d1 = mkDate(y + 1, monIdx, day); if (!d1) return { error: 'impossible' }; }
      if (year && d1 < today) return { error: 'past' };
      return { iso: isoOf(d1), text: fmtDate(d1) };
    }
    if (/\btomorrow\b/.test(t)) { var tm = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1); return { iso: isoOf(tm), text: fmtDate(tm) }; }
    if (/\btoday\b/.test(t)) return { iso: isoOf(today), text: fmtDate(today) };
    m = t.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)\b/);
    if (m) {
      var delta = (WEEKDAY_IDX[m[2]] - today.getDay() + 7) % 7;
      if (m[1] && delta === 0) delta = 7;
      var d3 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta);
      return { iso: isoOf(d3), text: fmtDate(d3) };
    }
    return null;
  }
  /* parseTime -> { min, text } | { error: 'invalid' } | null */
  function parseTime(text, corr) {
    var t = ' ' + text.toLowerCase() + ' ';
    if (/\bnoon\b/.test(t)) return { min: 720, text: fmtMin(720) };
    if (/\bmidnight\b/.test(t)) return { min: 0, text: fmtMin(0) };
    var m = t.match(/(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
    if (m) {
      var h = parseInt(m[1], 10), mi = parseInt(m[2], 10), ap = m[3];
      if (mi > 59 || h > 23 || (ap && (h < 1 || h > 12))) return { error: 'invalid' };
      if (ap) { if (h === 12) h = 0; if (ap === 'pm') h += 12; }
      return { min: h * 60 + mi, text: fmtMin(h * 60 + mi) };
    }
    m = t.match(/(\d{1,2})\s*(am|pm)\b/);
    if (m) {
      var h2 = parseInt(m[1], 10);
      if (h2 < 1 || h2 > 12) return { error: 'invalid' };
      var hh = h2 % 12 + (m[2] === 'pm' ? 12 : 0);
      return { min: hh * 60, text: fmtMin(hh * 60) };
    }
    m = t.match(/(\d{1,2})\s*o'?clock\s*(am|pm)?\b/);
    if (m) {
      var h3 = parseInt(m[1], 10);
      if (h3 > 23 || (m[2] && (h3 < 1 || h3 > 12))) return { error: 'invalid' };
      var h4 = m[2] ? (h3 % 12 + (m[2] === 'pm' ? 12 : 0)) : h3;
      return { min: h4 * 60, text: fmtMin(h4 * 60) };
    }
    if (corr) {
      m = t.match(/make it\s+(\d{1,2})(?::(\d{2}))?\b/);
      if (m) {
        var h5 = parseInt(m[1], 10), m5 = m[2] ? parseInt(m[2], 10) : 0;
        if (h5 > 23 || m5 > 59) return { error: 'invalid' };
        if (h5 < 12 && booking.timeMin !== null && booking.timeMin >= 720) h5 += 12; // keep PM when correcting a PM time
        return { min: h5 * 60 + m5, text: fmtMin(h5 * 60 + m5) };
      }
    }
    return null;
  }
  function scanFields(text) {
    var t = text.toLowerCase();
    var scan = { correction: /\b(actually|wrong|instead|change|changed|correction|meant|oops)\b/.test(t) };
    var ph = scanPhone(text); if (ph) scan.phone = ph;
    var nm = scanName(text); if (nm) scan.name = nm;
    var dt = parseDate(text); if (dt) scan.date = dt;
    var tm = parseTime(text, scan.correction); if (tm) scan.time = tm;
    var sv = scanService(text); if (sv) scan.service = sv;
    var nt = text.match(/\bnote[:\-]\s*(.+)/i); if (nt) scan.note = nt[1].trim().slice(0, 200);
    scan.any = !!(scan.phone || scan.name || scan.date || scan.time || scan.service);
    return scan;
  }

  /* Validate + commit a scanned date/time against the structured hours.
   * Returns a rejection reply string, or null when committed (or when
   * there was nothing to validate). On rejection the offending field
   * is NOT committed and a one-tap alternative is stored as a
   * suggestion (a "yes" from the visitor applies it). */
  function applyDateTime(scan) {
    if (scan.date && scan.date.error) {
      return scan.date.error === 'past'
        ? 'That date has already passed — could you pick another day?'
        : 'That date doesn\'t exist on the calendar — months don\'t have that many days. What other day works for you?';
    }
    if (scan.date) {
      var dt = dateFromISO(scan.date.iso);
      if (hoursFor(dt) === null) {
        var alt = nextOpenDay(dt, booking.timeMin);
        booking.suggestion = alt;
        return 'We\'re closed on ' + DAY_NAMES[dt.getDay()] + 's.' + (alt
          ? ' The next open day is ' + alt.dateText + ' — would ' + alt.dateText + ' at ' + alt.timeText + ' work instead?'
          : ' What other day works for you?');
      }
      booking.dateISO = scan.date.iso;
      booking.dateText = scan.date.text;
    }
    if (scan.time && scan.time.error) {
      return 'That time doesn\'t look right — could you give me a time like 10am or 2:30pm?';
    }
    if (scan.time) {
      if (booking.dateISO) {
        var dt2 = dateFromISO(booking.dateISO);
        var hrs = hoursFor(dt2);
        if (hrs && (scan.time.min < hrs[0] || scan.time.min >= hrs[1])) {
          var when = booking.dateText;
          if (scan.time.min < hrs[0]) {
            booking.suggestion = { dateISO: booking.dateISO, dateText: when, timeMin: hrs[0], timeText: fmtMin(hrs[0]) };
            return 'We open at ' + fmtMin(hrs[0]) + ' on ' + when + ', so ' + scan.time.text + ' is a bit early. Would ' + fmtMin(hrs[0]) + ' work instead?';
          }
          var lastSlot = hrs[1] - 60;
          booking.suggestion = { dateISO: booking.dateISO, dateText: when, timeMin: lastSlot, timeText: fmtMin(lastSlot) };
          return 'We close at ' + fmtMin(hrs[1]) + ' on ' + when + ', so ' + scan.time.text + ' is outside our hours. Our last appointment that day starts ' + fmtMin(lastSlot) + ' — would that work, or would another day suit better?';
        }
      }
      booking.timeMin = scan.time.min;
      booking.timeText = scan.time.text;
    }
    if (scan.date || scan.time) booking.suggestion = null;
    return null;
  }

  /* ----- flow helpers ----- */
  function askFor(field) {
    if (field === 'service') return 'What service would you like to book?';
    if (field === 'date') return 'What day works for you?';
    if (field === 'time') return booking.dateText ? ('What time on ' + booking.dateText + '?') : 'What time works for you?';
    if (field === 'name') return 'What is your name?';
    if (field === 'phone') return booking.mode === 'callback' ? 'What phone number should we call?' : 'What phone number should the clinic use to confirm your booking?';
    return '';
  }
  function askList() {
    if (booking.mode === 'callback') {
      var cm = [];
      if (!booking.name) cm.push('name');
      if (!booking.phone) cm.push('phone');
      return cm;
    }
    var list = [];
    var anyRequired = booking.dateISO || booking.timeMin !== null || booking.name || booking.phone;
    if (!booking.service && !anyRequired) list.push('service');
    if (!booking.dateISO) list.push('date');
    if (booking.timeMin === null) list.push('time');
    if (!booking.name) list.push('name');
    if (!booking.phone) list.push('phone');
    return list;
  }
  function nextQuestion() {
    var list = askList();
    if (!list.length) return null;
    var pick = list[0];
    if (list.length > 1 && booking.lastAsked === pick) pick = list[1]; // rotate so a skipped optional field doesn't block
    booking.lastAsked = pick;
    return askFor(pick);
  }
  function isComplete() {
    if (booking.mode === 'callback') return !!(booking.name && booking.phone);
    return !!(booking.name && booking.phone && booking.dateISO && booking.timeMin !== null);
  }
  function summaryText() {
    var lines = ['Here\'s what I have — please check it:'];
    lines.push('Name: ' + (booking.name || '—'));
    if (booking.service) lines.push('Service: ' + booking.service);
    lines.push('Date: ' + (booking.dateText || '—'));
    lines.push('Time: ' + (booking.timeText || '—'));
    lines.push('Phone: ' + (booking.phone || '—'));
    if (booking.note) lines.push('Note: ' + booking.note);
    return lines.join('\n');
  }
  function oneLineSummary() {
    var parts = [];
    if (booking.service) parts.push(booking.service);
    if (booking.dateText) parts.push(booking.dateText);
    if (booking.timeText) parts.push('at ' + booking.timeText);
    return parts.length ? parts.join(' — ') : 'Callback request';
  }
  function statusLine() {
    var have = [], need = [];
    if (booking.service) have.push(booking.service);
    if (booking.dateText) have.push(booking.dateText);
    if (booking.timeText) have.push(booking.timeText);
    var list = askList();
    for (var i = 0; i < list.length; i++) need.push(list[i]);
    return '(Your booking so far: ' + (have.length ? have.join(', ') : 'nothing yet') + ' — I still need: ' + (need.length ? need.join(', ') : 'nothing, ready to confirm') + '.)';
  }
  function progressReply(prefix) {
    if (isComplete()) {
      if (booking.mode === 'callback') return submitCallback(prefix);
      booking.state = 'confirm';
      return (prefix ? prefix + '\n' : '') + summaryText() + '\nReply "confirm" to send this to the clinic, or tell me what to change.';
    }
    var q = nextQuestion();
    return (prefix ? prefix + ' ' : '') + (q || '');
  }
  function resetBooking(keepIdentity) {
    var n = keepIdentity ? booking.name : '', p = keepIdentity ? booking.phone : '';
    booking = freshBooking();
    booking.name = n; booking.phone = p;
  }

  /* ----- submission (FormSubmit relay, same as the rule-based widget) ----- */
  function submitForm(payload) {
    try {
      fetch('https://formsubmit.co/ajax/' + encodeURIComponent(cfg.email), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function () { /* silent: widget already confirmed to visitor */ });
    } catch (e) { /* older browsers: skip */ }
  }
  function bookingMessage(header) {
    var lines = [header];
    if (booking.ref) lines.push('Reference: ' + booking.ref);
    lines.push('Name: ' + (booking.name || ''));
    lines.push('Phone: ' + (booking.phone || ''));
    if (booking.service) lines.push('Service: ' + booking.service);
    if (booking.dateText) lines.push('Date: ' + booking.dateText + (booking.dateISO ? ' (' + booking.dateISO + ')' : ''));
    if (booking.timeText) lines.push('Time: ' + booking.timeText);
    if (booking.note) lines.push('Note: ' + booking.note);
    if (booking.transcript.length) lines.push('Visitor\'s own words: ' + booking.transcript.join(' | '));
    return lines.join('\n');
  }
  function genRef() {
    var words = cfg.clinicName.replace(/[^a-zA-Z ]/g, '').split(/\s+/).filter(Boolean);
    var prefix = words.slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || 'BK';
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', out = '';
    for (var i = 0; i < 6; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return prefix + '-' + out;
  }
  function submitCallback(prefix) {
    submitForm({
      _subject: 'CALLBACK request — ' + cfg.clinicName,
      type: 'CALLBACK',
      name: booking.name,
      phone: booking.phone,
      message: bookingMessage('CALLBACK request from the website chat widget. Please call the visitor back.')
    });
    booking.state = 'done';
    return (prefix ? prefix + ' ' : '') + 'Got it — our team will call ' + booking.phone + ' shortly. Anything else I can help with?';
  }
  function submitBooking() {
    if (!booking.ref) booking.ref = genRef();
    submitForm({
      _subject: 'BOOKING — ' + cfg.clinicName + ' (' + booking.ref + ')',
      type: 'BOOKING',
      reference: booking.ref,
      name: booking.name,
      phone: booking.phone,
      service: booking.service || '',
      date: booking.dateText,
      time: booking.timeText,
      note: booking.note || '',
      message: bookingMessage('New booking from the website chat widget.')
    });
    booking.state = 'done';
    return 'Thanks' + (booking.name ? ', ' + booking.name.split(' ')[0] : '') + ' — your booking request has been sent to ' + cfg.clinicName + '.\n' +
      'Reference: ' + booking.ref + '\n' + oneLineSummary() + '\n' +
      'The clinic will confirm your slot by phone or text shortly at ' + booking.phone + '. If they need to adjust anything, they\'ll let you know. You can also reach them at ' + cfg.phone + '.';
  }
  function submitBookingUpdate(kind, noteLine) {
    submitForm({
      _subject: kind + ' — ' + cfg.clinicName + (booking.ref ? ' (' + booking.ref + ')' : ''),
      type: kind,
      reference: booking.ref,
      name: booking.name,
      phone: booking.phone,
      service: booking.service || '',
      date: booking.dateText,
      time: booking.timeText,
      note: booking.note || '',
      message: bookingMessage(kind + ' for a booking made via the website chat widget.') + (noteLine ? '\n' + noteLine : '')
    });
  }

  /* ----- the engine: returns a reply string, or null to fall through
   * to the FAQ brain / AI layer ----- */
  function bookingHandle(text) {
    var t = text.toLowerCase();
    var scan = scanFields(text);

    /* Completed booking: changes + cancellations, never a restart. */
    if (booking.state === 'done' && booking.ref) {
      if (/\bcancel\b/.test(t) && /\b(appointment|booking|visit|it|that)\b/.test(t)) {
        booking.transcript.push(text);
        submitBookingUpdate('CANCELLATION REQUEST', 'The visitor asked to cancel this booking.');
        booking.state = 'cancelled';
        return 'I\'ve noted that and sent it to ' + cfg.clinicName + ' — they\'ll confirm the cancellation by phone or text shortly. Your reference is ' + booking.ref + '.';
      }
      if (scan.any) {
        var snap = { dateISO: booking.dateISO, dateText: booking.dateText, timeMin: booking.timeMin, timeText: booking.timeText };
        var rejD = applyDateTime(scan);
        if (rejD) {
          booking.dateISO = snap.dateISO; booking.dateText = snap.dateText;
          booking.timeMin = snap.timeMin; booking.timeText = snap.timeText;
          return 'Your booking (' + booking.ref + ') is unchanged. ' + rejD;
        }
        var changedD = [];
        if (scan.name && scan.name !== booking.name) { booking.name = scan.name; changedD.push('name'); }
        if (scan.phone && scan.phone !== booking.phone) { booking.phone = scan.phone; changedD.push('phone'); }
        if (scan.service && scan.service !== booking.service) { booking.service = scan.service; changedD.push('service'); }
        if (booking.dateISO !== snap.dateISO) changedD.push('date');
        if (booking.timeMin !== snap.timeMin) changedD.push('time');
        if (scan.note) { booking.note = scan.note; changedD.push('note'); }
        if (changedD.length) {
          booking.transcript.push(text);
          submitBookingUpdate('BOOKING CHANGE', 'The visitor asked to change their booking (' + changedD.join(', ') + ').');
          return 'Updated — I\'ve sent the change to ' + cfg.clinicName + ': ' + oneLineSummary() + ' (reference ' + booking.ref + '). They\'ll confirm the change by phone or text shortly.';
        }
      }
      if (/\b(change|move|reschedule)\b/.test(t) && /\b(appointment|booking|visit)\b/.test(t)) {
        return 'Of course — what would you like to change? You can tell me a new day, time, service, or phone number, and I\'ll send the update to the clinic.';
      }
      return null;
    }
    if (booking.state === 'done' || booking.state === 'cancelled') resetBooking(true); // a finished callback, or a cancelled booking: start fresh, keep identity

    /* Awaiting confirmation: corrections re-show the summary, "confirm" submits. */
    if (booking.state === 'confirm') {
      if (scan.any) {
        var rejC = applyDateTime(scan);
        if (rejC) return rejC + ' Your details are unchanged — reply "confirm" to send them as they are, or tell me a different day or time.';
        var anyField = scan.name || scan.phone || scan.service || scan.date || scan.time;
        if (scan.name) booking.name = scan.name;
        if (scan.phone) booking.phone = scan.phone;
        if (scan.service) booking.service = scan.service;
        if (scan.note) booking.note = scan.note;
        if (anyField) return 'Updated:\n' + summaryText() + '\nReply "confirm" to send this to the clinic, or tell me what else to change.';
      }
      if (/^(confirm|confirmed|yes|yeah|yep|yup|sure|ok|okay|book it|looks good|that'?s right|correct|please do|go ahead)\b/i.test(t)) {
        booking.transcript.push(text);
        return submitBooking();
      }
      if (/^(no|nope|cancel|never ?mind|stop|don'?t)\b/i.test(t)) {
        resetBooking(false);
        return 'No problem — I\'ve dropped that booking request. Nothing was sent to the clinic.';
      }
      var faqC = matchAnswer(text);
      if (faqC) return faqC.text + '\n(Your booking is ready when you are — reply "confirm", or tell me what to change.)';
      return 'Just reply "confirm" to send this booking to the clinic, or tell me what you\'d like to change.';
    }

    /* A stored alternative (closed day / outside hours): a bare "yes"
     * with no new fields in it applies the suggestion. */
    if (booking.state === 'collecting' && booking.suggestion && !scan.any) {
      if (/^(yes|yeah|yep|sure|ok|okay|sounds good|that works|fine)\b/i.test(t)) {
        var sg = booking.suggestion;
        booking.suggestion = null;
        booking.dateISO = sg.dateISO; booking.dateText = sg.dateText;
        if (sg.timeMin !== null && sg.timeMin !== undefined) { booking.timeMin = sg.timeMin; booking.timeText = sg.timeText; }
        booking.transcript.push(text);
        return progressReply('Done — set to ' + sg.dateText + (sg.timeText ? ' at ' + sg.timeText : '') + '.');
      }
      if (/^(no|nope|not)\b/i.test(t)) {
        booking.suggestion = null;
        booking.lastAsked = null;
        return 'No problem. ' + (nextQuestion() || 'What day and time would you prefer?');
      }
    }

    /* A bare "yes" (the whole message is just the affirmation) in
     * reply to a soft rule-template offer starts the booking flow. */
    if (booking.state === 'idle' && softOfferOpen && /^\s*(yes|yeah|yep|yup|sure|ok|okay|definitely|sounds good|that works|please do)[.!]?\s*$/i.test(t)) {
      softOfferOpen = false;
      booking.state = 'collecting';
      booking.mode = 'booking';
      booking.transcript.push(text);
      return 'Great! ' + (nextQuestion() || '');
    }

    /* Polite refusal: never push again. */
    if (/^(no|nope|not now|no thanks)\b/i.test(t) && lastBotQ && booking.state !== 'collecting') {
      visitorDeclined = true;
      softOfferOpen = false;
      return 'No problem! Is there anything else I can help with?';
    }

    var wantsBooking = /\b(book|booking|appointment|appointments|schedule|reserve|reschedule)\b/.test(t);
    var wantsCallback = /\b(call me back|call me|call back|ring me|give me a call|callback|my number|reach me|contact me)\b/.test(t);
    var changeAsk = /\b(change|move|reschedule)\b[^.!?]{0,24}\b(appointment|booking|visit)\b/.test(t);
    var context = wantsBooking || wantsCallback || changeAsk || booking.state === 'collecting' ||
                  !!(scan.name && scan.phone) || !!((scan.date || scan.time) && scan.phone);
    if (!context) return null;

    var wasCollecting = booking.state === 'collecting';
    if (booking.state === 'idle') {
      booking.state = 'collecting';
      booking.mode = (wantsCallback && !wantsBooking && !scan.date && !scan.time) ? 'callback' : 'booking';
    }
    if (wantsBooking) booking.mode = 'booking';
    booking.transcript.push(text);
    if (booking.transcript.length > 12) booking.transcript.shift();

    if (changeAsk && !wasCollecting && !scan.any) {
      return 'I don\'t have a booking started in this chat yet — let\'s set up the new one. ' + (nextQuestion() || '');
    }

    /* Validate + commit date/time first (rejections keep other fields). */
    var rej = applyDateTime(scan);
    if (rej) {
      if (scan.name) booking.name = scan.name;
      if (scan.phone) booking.phone = scan.phone;
      if (scan.service) booking.service = scan.service;
      if (scan.note) booking.note = scan.note;
      return rej;
    }
    var captured = [];
    if (scan.name && scan.name !== booking.name) { booking.name = scan.name; captured.push('name'); }
    if (scan.phone && scan.phone !== booking.phone) { booking.phone = scan.phone; captured.push('phone'); }
    if (scan.service && scan.service !== booking.service) { booking.service = scan.service; captured.push('service'); }
    if (scan.note) booking.note = scan.note;
    if (scan.date) captured.push('date');
    if (scan.time) captured.push('time');

    /* Bare answer to a question we asked ("Jane" after "What is your name?"). */
    if (!scan.any && wasCollecting && booking.lastAsked === 'name' && text.length <= 40 && !/[?]/.test(text)) {
      var bn = cleanName(text.replace(/^(my name is|i'm|i am|this is)\s+/i, ''));
      if (bn) { booking.name = bn; captured.push('name'); }
    }
    if (!scan.any && !captured.length && wasCollecting) {
      var faq = matchAnswer(text, true);
      if (faq && (/\?/.test(text) || /^(what|when|where|how|do|does|is|are|can|will|who)\b/i.test(text))) {
        return faq.text + '\n' + statusLine();
      }
      return 'Sorry, I didn\'t catch that. ' + (booking.lastAsked ? askFor(booking.lastAsked) : (nextQuestion() || ''));
    }
    if (booking.mode === 'callback' && (booking.dateISO || booking.timeMin !== null || booking.service)) booking.mode = 'booking';

    /* A mixed message (FAQ question + booking details): answer the
     * question AND keep the booking moving. */
    var faqPrefix = '';
    var faqM = matchAnswer(text, true);
    if (faqM && /\?/.test(text)) faqPrefix = faqM.text;
    var intro = wasCollecting ? '' : (booking.mode === 'callback' ? 'Happy to arrange that.' : 'I can book that for you.');
    var pr = progressReply(captured.length ? 'Got it.' : intro);
    return faqPrefix ? faqPrefix + '\n' + pr : pr;
  }

  /* Rule templates may append at most ONE soft booking offer per
   * conversation — never after a decline, and never once a booking is
   * under way or completed. */
  function withSoftOffer(m) {
    if ((m.id === 'hours' || m.id === 'services' || m.id === 'location') &&
        !softOfferUsed && !visitorDeclined && booking.state === 'idle') {
      softOfferUsed = true;
      softOfferOpen = true;
      return m.text + '\nHappy to help you book a visit too — just say the word.';
    }
    return m.text;
  }

  /* ---------- UI (shadow DOM, no conflicts) ---------- */
  function shade(hex, pct) {
    var n = hex.replace('#', '');
    if (n.length === 3) n = n.split('').map(function (c) { return c + c; }).join('');
    var num = parseInt(n, 16);
    var r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    var t = pct < 0 ? 0 : 255, p = Math.abs(pct) / 100;
    r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  var cDark = shade(cfg.color, -20);
  var cGrad = 'linear-gradient(135deg,' + cfg.color + ',' + cDark + ')';

  var host = document.createElement('div');
  host.id = 'dental-bot-root';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  var css = [
    '.db-fab{position:fixed;right:20px;bottom:20px;width:62px;height:62px;border-radius:50%;',
    'background:' + cGrad + ';color:#fff;border:0;cursor:pointer;font-size:28px;z-index:2147483647;',
    'box-shadow:0 6px 20px rgba(0,0,0,.28);transition:transform .15s}',
    '.db-fab:hover{transform:scale(1.07)}',
    '.db-panel{position:fixed;right:20px;bottom:94px;width:360px;max-width:calc(100vw - 40px);height:480px;',
    'max-height:calc(100vh - 140px);background:#f8fafc;border-radius:20px;z-index:2147483647;display:none;',
    'flex-direction:column;overflow:hidden;box-shadow:0 16px 50px rgba(0,0,0,.28);',
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.db-panel.open{display:flex;animation:dbin .18s ease-out}',
    '@keyframes dbin{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
    '.db-head{background:' + cGrad + ';color:#fff;padding:14px;display:flex;align-items:center;gap:11px}',
    '.db-ava{width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,.22);flex:none;',
    'display:flex;align-items:center;justify-content:center;font-size:22px}',
    '.db-hinfo{line-height:1.3}',
    '.db-hname{font-size:15px;font-weight:700}',
    '.db-hsub{font-size:11.5px;opacity:.93;display:flex;align-items:center;gap:6px}',
    '.db-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80}',
    '.db-msgs{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.45}',
    '.db-b{background:#fff;border:1px solid #edf1f6;border-radius:16px 16px 16px 4px;padding:9px 13px;',
    'max-width:85%;align-self:flex-start;box-shadow:0 1px 3px rgba(0,0,0,.06);white-space:pre-line}',
    '.db-u{background:' + cGrad + ';color:#fff;border-radius:16px 16px 4px 16px;padding:9px 13px;',
    'max-width:85%;align-self:flex-end;box-shadow:0 1px 4px rgba(0,0,0,.14);white-space:pre-line}',
    '.db-in{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#fff;border-top:1px solid #eef2f7}',
    '.db-in input{flex:1;border:1.5px solid #e5e7eb;border-radius:24px;padding:10px 16px;font-size:14px;',
    'outline:none;font-family:inherit;transition:border-color .15s;min-width:0}',
    '.db-in input:focus{border-color:' + cfg.color + '}',
    '.db-send{width:42px;height:42px;flex:none;border:0;border-radius:50%;cursor:pointer;color:#fff;font-size:16px;',
    'background:' + cGrad + ';box-shadow:0 3px 10px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;transition:transform .15s}',
    '.db-send:hover{transform:scale(1.07)}',
    '.db-foot{font-size:10px;color:#9ca3af;padding:7px 14px;border-top:1px solid #f1f5f9;background:#fff}',
    '.db-chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:95%}',
    '.db-chip{border:1.5px solid ' + cfg.color + ';color:' + cfg.color + ';background:#fff;border-radius:20px;',
    'padding:7px 13px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s}',
    '.db-chip:hover{background:' + cfg.color + ';color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15)}',
    '.db-typing{background:#fff;border:1px solid #edf1f6;border-radius:16px 16px 16px 4px;padding:11px 15px;',
    'align-self:flex-start;display:flex;gap:5px}',
    '.db-typing i{width:7px;height:7px;border-radius:50%;background:#9ca3af;animation:dbblink 1.2s infinite}',
    '.db-typing i:nth-child(2){animation-delay:.2s}',
    '.db-typing i:nth-child(3){animation-delay:.4s}',
    '@keyframes dbblink{0%,60%,100%{opacity:.25;transform:none}30%{opacity:1;transform:translateY(-3px)}}',
    '.db-fab.pulse{animation:dbpulse 2s infinite}',
    '@keyframes dbpulse{0%{box-shadow:0 6px 20px rgba(0,0,0,.28)}',
    '50%{box-shadow:0 6px 28px ' + cfg.color + '}100%{box-shadow:0 6px 20px rgba(0,0,0,.28)}}',
    '.db-teaser{position:fixed;right:94px;bottom:38px;background:#fff;border-radius:14px 14px 4px 14px;padding:10px 15px;',
    'font-size:13px;z-index:2147483647;box-shadow:0 6px 20px rgba(0,0,0,.18);display:none;cursor:pointer;',
    'font-family:system-ui,-apple-system,sans-serif;max-width:230px;color:#1f2937;border:1px solid #eef2f7}'
  ].join('');

  shadow.innerHTML =
    '<style>' + css + '</style>' +
    '<button class="db-fab" aria-label="Chat with us">💬</button>' +
    '<div class="db-teaser">Questions about your smile? Chat with us 👋</div>' +
    '<div class="db-panel" role="dialog" aria-label="Chat">' +
      '<div class="db-head"><div class="db-ava">🦷</div><div class="db-hinfo">' +
        '<div class="db-hname">' + esc(cfg.clinicName) + '</div>' +
        '<div class="db-hsub"><span class="db-dot"></span>Online — replies instantly</div>' +
      '</div></div>' +
      '<div class="db-msgs"></div>' +
      '<div class="db-in"><input type="text" placeholder="Type your question…" aria-label="Type your question"/>' +
      '<button class="db-send" aria-label="Send">➤</button></div>' +
      '<div class="db-foot">Automated assistant — not dental advice. Emergencies: call ' + esc(cfg.phone) + '.</div>' +
    '</div>';

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  var fab = shadow.querySelector('.db-fab');
  var teaser = shadow.querySelector('.db-teaser');
  var panel = shadow.querySelector('.db-panel');
  var msgs = shadow.querySelector('.db-msgs');
  var input = shadow.querySelector('.db-in input');
  var sendBtn = shadow.querySelector('.db-in button');

  var CHIPS = [
    { label: '🕐 Hours', q: 'What are your hours?' },
    { label: '🦷 Services', q: 'What services do you offer?' },
    { label: '💲 Pricing', q: 'How much does it cost?' },
    { label: '📞 Call me back', q: 'Please call me back' }
  ];
  var lastBotQ = '';

  function addMsg(text, who) {
    var d = document.createElement('div');
    d.className = who === 'u' ? 'db-u' : 'db-b';
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    history.push({ role: who === 'u' ? 'user' : 'bot', text: text });
    if (history.length > 24) history.splice(0, history.length - 24);
  }

  function removeChips() {
    var old = shadow.querySelector('.db-chips');
    if (old && old.remove) old.remove();
  }

  function showChips() {
    removeChips();
    var wrap = document.createElement('div');
    wrap.className = 'db-chips';
    CHIPS.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'db-chip';
      b.textContent = c.label;
      b.addEventListener('click', function () { removeChips(); handleUser(c.q); });
      wrap.appendChild(b);
    });
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping() {
    var typing = document.createElement('div');
    typing.className = 'db-typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;
    return typing;
  }

  function hideTyping(typing) {
    if (typing && typing.remove) typing.remove();
  }

  function botSay(text, withChips) {
    var typing = showTyping();
    setTimeout(function () {
      hideTyping(typing);
      addMsg(text, 'b');
      lastBotQ = text;
      if (withChips) showChips();
    }, 600);
  }

  /* AI path: typing indicator stays up while the proxy answers. ANY
   * failure lands on the standard fallback + chips — never a dead chat. */
  function botSayAI(userText) {
    var typing = showTyping();
    callAI(userText).then(function (reply) {
      hideTyping(typing);
      var finalText = reply || FALLBACK_REPLY;
      addMsg(finalText, 'b');
      lastBotQ = finalText;
      if (!reply) showChips();
    });
  }

  function handleUser(text) {
    text = text.trim();
    if (!text) return;
    removeChips();
    addMsg(text, 'u');
    var bookingReply = bookingHandle(text);
    if (bookingReply) { botSay(bookingReply); return; }
    var matched = matchAnswer(text);
    if (matched) {
      // Confident rule-based answer: instant, no network call.
      botSay(withSoftOffer(matched), matched.greeting);
      return;
    }
    // No rule-based match: try the AI, fall back gracefully.
    botSayAI(text);
  }

  fab.addEventListener('click', function () {
    teaser.style.display = 'none';
    fab.classList.remove('pulse');
    var open = panel.classList.toggle('open');
    if (open && !msgs.children.length) {
      botSay('Hi! Welcome to ' + cfg.clinicName + '. Ask me about hours, services, or booking — or tap a topic below.', true);
    }
  });
  teaser.addEventListener('click', function () {
    teaser.style.display = 'none';
    fab.click();
  });
  // Gentle nudge: teaser bubble + pulsing button after 6s if never opened
  setTimeout(function () {
    if (!panel.classList.contains('open')) {
      teaser.style.display = 'block';
      if (fab.classList.add) fab.classList.add('pulse');
    }
  }, 6000);
  sendBtn.addEventListener('click', function () { handleUser(input.value); input.value = ''; });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { handleUser(input.value); input.value = ''; } });
})();
