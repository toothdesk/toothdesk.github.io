/* DentalBot — embeddable FAQ + lead-capture chat widget for dental clinics.
 * One-line install: <script src="https://<pages-host>/<clinic-slug>/bot.js"></script>
 * Per-clinic builds inline the config below via build.js. Zero dependencies.
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
    services: ['Cleanings', 'Fillings', 'Whitening', 'Braces', 'Implants', 'Root canals']
  };
  var __CLINIC_CONFIG__ = {"address":"400 Congress Ave, Austin, TX","clinicName":"Bright Smile Dental","color":"#0d9488","email":"leads@brightsmiledental.example.com","hours":"Mon–Fri 9am–6pm, Sat 9am–2pm","phone":"(512) 555-0142","services":["Cleanings","Fillings","Whitening","Braces","Implants","Root canals","Crowns"],"tagline":"How can we help your smile today?"};
  for (var ck in __CLINIC_CONFIG__) DEFAULTS[ck] = __CLINIC_CONFIG__[ck];
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

  function answer(text) {
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
    return 'Good question! I can help with hours, services, pricing, booking, or contact details — tap a topic below or type "call me" and our team will ring you back.';
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
  var host = document.createElement('div');
  host.id = 'dental-bot-root';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  var css = [
    '.db-fab{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;',
    'background:' + cfg.color + ';color:#fff;border:0;cursor:pointer;font-size:28px;z-index:2147483647;',
    'box-shadow:0 4px 14px rgba(0,0,0,.25)}',
    '.db-panel{position:fixed;right:20px;bottom:92px;width:340px;max-width:calc(100vw - 40px);height:440px;',
    'max-height:calc(100vh - 130px);background:#fff;border-radius:14px;z-index:2147483647;display:none;',
    'flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.25);font-family:system-ui,-apple-system,sans-serif}',
    '.db-panel.open{display:flex}',
    '.db-head{background:' + cfg.color + ';color:#fff;padding:12px 14px;font-size:15px;font-weight:600}',
    '.db-head small{display:block;font-weight:400;font-size:12px;opacity:.9}',
    '.db-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:14px}',
    '.db-b{background:#f1f5f9;border-radius:12px 12px 12px 3px;padding:8px 12px;max-width:85%;align-self:flex-start}',
    '.db-u{background:' + cfg.color + ';color:#fff;border-radius:12px 12px 3px 12px;padding:8px 12px;max-width:85%;align-self:flex-end}',
    '.db-in{display:flex;border-top:1px solid #e5e7eb}',
    '.db-in input{flex:1;border:0;padding:12px;font-size:14px;outline:none}',
    '.db-in button{border:0;background:' + cfg.color + ';color:#fff;padding:0 16px;cursor:pointer;font-size:14px}',
    '.db-foot{font-size:10px;color:#9ca3af;padding:6px 12px;border-top:1px solid #f1f5f9}',
    '.db-chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:95%}',
    '.db-chip{border:1px solid ' + cfg.color + ';color:' + cfg.color + ';background:#fff;border-radius:16px;',
    'padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
    '.db-chip:hover{background:' + cfg.color + ';color:#fff}',
    '.db-typing{background:#f1f5f9;border-radius:12px 12px 12px 3px;padding:8px 14px;max-width:85%;',
    'align-self:flex-start;color:#9ca3af;letter-spacing:2px}',
    '.db-fab.pulse{animation:dbpulse 2s infinite}',
    '@keyframes dbpulse{0%{box-shadow:0 4px 14px rgba(0,0,0,.25)}',
    '50%{box-shadow:0 4px 26px ' + cfg.color + '}100%{box-shadow:0 4px 14px rgba(0,0,0,.25)}}',
    '.db-teaser{position:fixed;right:92px;bottom:36px;background:#fff;border-radius:12px;padding:8px 14px;',
    'font-size:13px;z-index:2147483647;box-shadow:0 4px 14px rgba(0,0,0,.2);display:none;cursor:pointer;',
    'font-family:system-ui,-apple-system,sans-serif;max-width:230px;color:#1f2937}'
  ].join('');

  shadow.innerHTML =
    '<style>' + css + '</style>' +
    '<button class="db-fab" aria-label="Chat with us">💬</button>' +
    '<div class="db-teaser">Questions about your smile? Chat with us 👋</div>' +
    '<div class="db-panel" role="dialog" aria-label="Chat">' +
      '<div class="db-head">' + esc(cfg.clinicName) + '<small>' + esc(cfg.tagline) + '</small></div>' +
      '<div class="db-msgs"></div>' +
      '<div class="db-in"><input type="text" placeholder="Type your question…" aria-label="Type your question"/><button>Send</button></div>' +
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

  function botSay(text, withChips) {
    var typing = document.createElement('div');
    typing.className = 'db-typing';
    typing.textContent = '…';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;
    setTimeout(function () {
      if (typing.remove) typing.remove();
      addMsg(text, 'b');
      lastBotQ = text;
      if (withChips) showChips();
    }, 600);
  }

  function handleUser(text) {
    text = text.trim();
    if (!text) return;
    removeChips();
    addMsg(text, 'u');
    var leadReply = maybeLeadFlow(text);
    if (leadReply) { botSay(leadReply); return; }
    var reply = answer(text);
    botSay(reply, reply.indexOf('Good question!') === 0 || reply.indexOf('Hello! 👋') === 0);
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
