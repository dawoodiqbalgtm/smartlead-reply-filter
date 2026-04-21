// Smartlead reply webhook -> OOO filter -> Slack
// Deploy to Vercel: `vercel --prod`
//
// Env vars required:
//   SLACK_WEBHOOK_URL    Incoming webhook from slack.com/apps/A0F7XDUAZ
//   SMARTLEAD_SECRET     (optional) shared secret; if set, request must include ?secret=...

const OOO_PATTERNS = [
  // English
  /\bout\s+of\s+(the\s+)?office\b/i,
  /\bon\s+(vacation|holiday|leave|pto|annual\s+leave|parental\s+leave|maternity|paternity|sabbatical)\b/i,
  /\b(away|unavailable)\s+(from|until|through|between|this\s+week)\b/i,
  /\bI\s+am\s+currently\s+(out|away|unavailable|travel(l)?ing)\b/i,
  /\bI\s+will\s+be\s+(out|away|unavailable|back)\b/i,
  /\breturn(ing)?\s+(to\s+the\s+office\s+)?on\b/i,
  /\bback\s+in\s+the\s+office\s+on\b/i,
  /\blimited\s+access\s+to\s+(email|my\s+inbox)\b/i,
  /\bauto(matic)?[-\s]?reply\b/i,
  /\bautomated\s+(response|reply|message)\b/i,
  /\bthank\s+you\s+for\s+your\s+(email|message).{0,40}(out\s+of|away|unavailable)/i,
  /\bno\s+longer\s+(with|employed)\b/i,
  /\bhas\s+left\s+the\s+company\b/i,
  /\bis\s+no\s+longer\s+with\s+(us|the\s+company|.{0,40})/i,
  // Subject line markers
  /\b(auto:|automatic reply:|autoreply:|out of office:|ooo:)/i,
];

// Header-level signals (most reliable)
const OOO_HEADER_KEYS = [
  "auto-submitted",       // RFC 3834: any value other than "no" = auto
  "x-autoreply",
  "x-autorespond",
  "x-auto-response-suppress",
  "precedence",           // "auto_reply", "bulk", "junk"
];

function isOOO({ subject = "", body = "", headers = {} }) {
  const hay = `${subject}\n${body}`.slice(0, 4000);

  // 1. Header check
  const h = {};
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) h[String(k).toLowerCase()] = String(v ?? "");
  }
  if (h["auto-submitted"] && h["auto-submitted"].toLowerCase() !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"]) return true;
  if (/auto[_-]?reply|bulk/i.test(h["precedence"] || "")) return true;

  // 2. Pattern check
  return OOO_PATTERNS.some((re) => re.test(hay));
}

function stripQuoted(text = "") {
  if (!text) return "";
  // Cut at common reply/forward markers
  const markers = [
    /\n?On .{0,80} wrote:\s*\n/,
    /\n?-----\s*Original Message\s*-----/i,
    /\n?From:\s+.+\nSent:\s+.+\nTo:/i,
    /\n?>{1,}\s/,
  ];
  let cut = text.length;
  for (const m of markers) {
    const match = text.match(m);
    if (match && match.index < cut) cut = match.index;
  }
  return text.slice(0, cut).trim();
}

function buildSlackMessage(payload) {
  const leadName = [payload.lead_first_name, payload.lead_last_name].filter(Boolean).join(" ") || payload.lead_name || "(unknown)";
  const leadEmail = payload.lead_email || payload.from_email || "";
  const company = payload.lead_company || payload.company_name || "";
  const campaign = payload.campaign_name || payload.campaign_id || "";
  const subject = payload.subject || payload.reply_subject || "";
  const body = stripQuoted(payload.reply_message || payload.reply_body || payload.message || payload.body || "");
  const threadLink = payload.message_url || payload.thread_url || payload.smartlead_url ||
    (payload.campaign_id && payload.lead_id
      ? `https://app.smartlead.ai/app/master-inbox/${payload.campaign_id}/${payload.lead_id}`
      : "");

  const headerLine = `📬 *New reply from ${leadName}* <mailto:${leadEmail}|${leadEmail}>`;
  const metaLine = [company && `*Company:* ${company}`, campaign && `*Campaign:* ${campaign}`, subject && `*Subject:* ${subject}`]
    .filter(Boolean)
    .join("  |  ");

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: headerLine } },
  ];
  if (metaLine) blocks.push({ type: "section", text: { type: "mrkdwn", text: metaLine } });
  blocks.push({ type: "divider" });
  // Slack mrkdwn block text cap is 3000 chars; split the body if needed.
  const chunks = [];
  let rest = body || "(empty body)";
  while (rest.length > 2900) {
    chunks.push(rest.slice(0, 2900));
    rest = rest.slice(2900);
  }
  chunks.push(rest);
  for (const c of chunks) blocks.push({ type: "section", text: { type: "mrkdwn", text: c } });
  if (threadLink) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "View in Smartlead" }, url: threadLink }],
    });
  }

  return { text: `New reply from ${leadName}`, blocks };
}

async function postToSlack(message) {
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Slack ${res.status}: ${txt}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (process.env.SMARTLEAD_SECRET) {
    const got = req.query.secret || req.headers["x-webhook-secret"];
    if (got !== process.env.SMARTLEAD_SECRET) return res.status(401).json({ error: "bad secret" });
  }

  const p = req.body || {};
  console.log("payload:", JSON.stringify(p).slice(0, 2000));

  try {
    const eventType = String(p.event_type || p.event || p.webhook_type || "").toLowerCase();
    if (eventType && !eventType.includes("reply")) {
      return res.status(200).json({ skipped: "non-reply event", eventType });
    }

    const subject = String(p.subject || p.reply_subject || "");
    const body = String(p.reply_message || p.reply_body || p.message || p.body || "");
    const headers = p.reply_headers || p.headers || {};

    if (isOOO({ subject, body, headers })) {
      return res.status(200).json({ skipped: "ooo" });
    }

    await postToSlack(buildSlackMessage(p));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("handler error:", e.stack || e.message);
    return res.status(502).json({ error: e.message });
  }
}
