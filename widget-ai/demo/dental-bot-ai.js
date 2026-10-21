/* DentalBot AI — hybrid FAQ + lead-capture chat widget for dental clinics.
 * One-line install: <script src="https://<pages-host>/<clinic-slug>/bot.js"></script>
 * Per-clinic builds inline the config below via build.js. Zero dependencies.
 *
 * HYBRID FLOW:
 *   1. Lead-capture flow runs first (same as the rule-based widget).
 *   2. Rule-based FAQ brain runs. A confident match answers instantly,
 *      with NO network call.
 *   3. On no-match, the question goes to the AI proxy (cfg.aiEndpoint,
 *      a Cloudflare Worker) together with the clinic's approved fact sheet.
 *   4. If the AI call fails, times out (> cfg.aiTimeoutMs, default 8s),
 *      or returns an error (e.g. free-tier quota), the widget falls back
 *      to the standard rule-based fallback message + quick-reply chips.
 *      The bot never appears dead.
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
    aiTimeoutMs: 8000        // give up on the AI after this long and fall back
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
    { keys: ['emergency', 'pain', 'hurt', 'ache', 'swollen', 'bleeding', 'broke', 'chipped', 'knocked'],
      reply: function () { return 'Sorry to hear that. For urgent dental pain, please call us right away at ' + cfg.phone + ' — we keep same-day emergency slots.'; } },
    { keys: ['price', 'cost', 'much', 'fee', 'charge', 'insurance', 'insur', 'payment', 'pay'],
      reply: function () { return 'Costs vary by treatment and insurance. Share your number and our front desk will call you with exact pricing — or call us at ' + cfg.phone + '.'; } },
    { keys: ['book', 'appointment', 'appoint', 'visit', 'schedule', 'reserve', 'slot'],
      reply: function () { return 'I can have our team call you back to book! Just share your name and phone number here.'; } },
    { keys: ['hour', 'open', 'close', 'when are you', 'timing'],
      reply: function () { return 'We are open ' + cfg.hours + '. Want us to call you to book a visit?'; } },
    { keys: ['where', 'location', 'address', 'direction', 'park'],
      reply: function () { return 'You can find us at ' + cfg.address + '. Call ' + cfg.phone + ' if you need directions!'; } },
    { keys: ['contact', 'e-mail', 'email'],
      reply: function () { return 'Here is how to reach us:\n📞 ' + cfg.phone + '\n✉️ ' + cfg.email + '\n📍 ' + cfg.address + '\n🕐 ' + cfg.hours; } },
    { keys: ['new patient', 'first visit', 'join'],
      reply: function () { return 'We love welcoming new patients! Leave your name and number and we will call you to set up your first visit.'; } },
    { keys: ['service', 'offer', 'treatment', 'do you do', 'cleaning', 'whiten', 'brace', 'implant', 'filling', 'crown', 'root canal', 'extraction', 'denture', 'veneer'],
      reply: function () { return 'We offer: ' + cfg.services.join(', ') + '. Anything specific I can help with?'; } },
    { keys: ['human', 'person', 'real', 'staff', 'receptionist', 'phone number', 'telephone'],
      reply: function () { return 'Of course — you can reach our front desk at ' + cfg.phone + ' (' + cfg.hours + ').'; } },
    { keys: ['thank', 'thanks', 'great', 'bye', 'goodbye', 'see you'],
      reply: function () { return 'You are very welcome! We look forward to seeing your smile at ' + cfg.clinicName + '. 😊'; } }
  ];
  INTENTS.forEach(function (in_) { in_.res = in_.keys.map(keyRe); });

  function scoreIntents(t) {
    var best = null, bestScore = 0;
    for (var i = 0; i < INTENTS.length; i++) {
      var s = 0;
      for (var j = 0; j < INTENTS[i].res.length; j++) {
        if (INTENTS[i].res[j].test(t)) s++;
      }
      if (s > bestScore) { bestScore = s; best = INTENTS[i]; }
    }
    return best;
  }

  function greetingReply() {
    return 'Hello! 👋 Welcome to ' + cfg.clinicName + '. Ask me about our hours, services, or pricing — or tap below and I\'ll help you book a visit.';
  }

  var FALLBACK_REPLY = 'Good question! I can help with hours, services, pricing, booking, or contact details — tap a topic below or type "call me" and our team will ring you back.';

  /* Returns a confident rule-based reply, or null when the brain has no
   * match (that is the signal to try the AI layer). */
  function matchAnswer(text) {
    var t = text.trim();
    // Pure greeting ("hi", "hey!", "good morning") -> warm hello, never the fallback.
    if (GREETING_RE.test(t) && t.replace(GREETING_RE, '').replace(/[!.,?\s]/g, '').length <= 20) {
      var rest = t.replace(GREETING_RE, '').trim();
      var sub = rest ? scoreIntents(rest) : null;
      if (sub) return sub.reply();          // "hi, what are your hours?" -> hours answer
      return greetingReply();               // "hi" -> hello
    }
    var best = scoreIntents(t.toLowerCase());
    if (best) return best.reply();
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
    var timeoutMs = cfg.aiTimeoutMs || 8000;
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

  /* ---------- Lead capture ---------- */
  var lead = { step: 0, name: '', phone: '' }; // 0 idle, 1 want name, 2 want phone, 3 done
  var phoneRe = /[\d()\-\s+.]{7,}/;

  function maybeLeadFlow(text) {
    var t = text.toLowerCase();
    if (lead.step === 1) {
      lead.name = text.trim().replace(/^(my name is|i'm|i am)\s+/i, '').slice(0, 60) || 'Website visitor';
      lead.step = 2;
      return 'Thanks ' + lead.name.split(' ')[0] + '! What phone number should we call?';
    }
    if (lead.step === 2) {
      var m = text.match(phoneRe);
      if (!m) return 'Hmm, that does not look like a phone number. Could you type it again?';
      lead.phone = m[0].trim();
      lead.step = 3;
      sendLead();
      return 'Got it — our team will call ' + lead.phone + ' shortly. Anything else I can help with?';
    }
    // "my name is ..." -> remember the name, skip straight to phone
    var nameM = t.match(/my name is ([a-z][a-z .'\-]{1,39})/);
    if (lead.step === 0 && nameM) {
      lead.name = nameM[1].trim().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      lead.step = 2;
      return 'Nice to meet you, ' + lead.name.split(' ')[0] + '! What phone number should we call?';
    }
    // "yes" after the bot offered a callback -> start lead flow
    if (lead.step === 0 && /^(yes|yeah|yep|sure|ok|okay|please|definitely)\b/i.test(t) && /call you|call back|ring you/i.test(lastBotQ)) {
      lead.step = 1;
      return 'Great! What is your name?';
    }
    // polite "no" -> don't push, stay helpful
    if (lead.step === 0 && /^(no|nope|not now|no thanks)\b/i.test(t) && lastBotQ) {
      return 'No problem! Is there anything else I can help with?';
    }
    if (/(call me|call back|contact me|my number|reach me)/.test(t)) {
      lead.step = 1;
      return 'Happy to arrange that! What is your name?';
    }
    return null;
  }

  function sendLead() {
    var payload = {
      _subject: 'New website chat lead — ' + cfg.clinicName,
      name: lead.name,
      phone: lead.phone,
      message: 'New lead from the website chat widget. Please call back: ' + lead.name + ' — ' + lead.phone
    };
    try {
      fetch('https://formsubmit.co/ajax/' + encodeURIComponent(cfg.email), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function () { /* silent: widget already confirmed to visitor */ });
    } catch (e) { /* older browsers: skip */ }
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
    var leadReply = maybeLeadFlow(text);
    if (leadReply) { botSay(leadReply); return; }
    var matched = matchAnswer(text);
    if (matched) {
      // Confident rule-based answer: instant, no network call.
      botSay(matched, matched.indexOf('Hello! 👋') === 0);
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
