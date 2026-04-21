// Smartlead reply webhook -> OOO filter -> Slack
// Deploy to Vercel. Env vars:
//   SLACK_WEBHOOK_URL    Incoming webhook from api.slack.com/apps
//   SMARTLEAD_SECRET     (optional) shared secret; if set, request must include ?secret=...

const OOO_PATTERNS = [
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
  /\b(auto:|automatic reply:|autoreply:|out of office:|ooo:)/i,
];

function s(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v.text ?? v.html ?? "");
  return String(v);
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractReplyText(reply) {
  if (!reply) return "";
  if (typeof reply === "string") return reply;
  if (typeof reply === "object") {
    if (reply.text) return String(reply.text);
    if (reply.html) return htmlToText(String(reply.html));
  }
  return "";
}

function isOOO({ subject, body, headers }) {
  const hay = `${s(subject)}\n${s(body)}`.slice(0, 4000);

  const h = {};
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) h[String(k).toLowerCase()] = s(v);
  }
  if (h["auto-submitted"] && h["auto-submitted"].toLowerCase() !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"]) return true;
  if (/auto[_-]?reply|bulk/i.test(h["precedence"] || "")) return true;

  return OOO_PATTERNS.some((re) => re.test(hay));
}

function stripQuoted(text) {
  const t = s(text);
  if (!t) return "";
  const markers = [
    /\n?On .{0,80} wrote:\s*\n/,
    /\n?-----\s*Original Message\s*-----/i,
    /\n?From:\s+.+\nSent:\s+.+\nTo:/i,
    /\n?>{1,}\s/,
    /##-\s*Please type your reply above this line\s*-##/i,
  ];
  let cut = t.length;
  for (const m of markers) {
    const match = t.match(m);
    if (match && match.index != null && match.index < cut) cut = match.index;
  }
  return t.slice(0, cut).trim();
}

function buildSlackMessage(p) {
  const leadName =
    [p.lead_first_name, p.lead_last_name].filter(Boolean).join(" ") ||
    p.lead_name ||
    p.to_name ||
    s(p.sl_lead_email) ||
    s(p.to_email) ||
    "(unknown)";
  const leadEmail = s(p.sl_lead_email) || s(p.to_email) || s(p.lead_email) || "";
  const company = s(p.lead_company) || s(p.company_name) || "";
  const campaign = s(p.campaign_name) || (p.campaign_id != null ? String(p.campaign_id) : "");
  const subject = s(p.subject) || s(p.reply_subject);
  const body = stripQuoted(extractReplyText(p.reply_message) || s(p.reply_body) || s(p.message) || s(p.body));
  const threadLink = s(p.app_url) || s(p.message_url) || s(p.thread_url) || s(p.smartlead_url) || "";

  const headerText = leadEmail
    ? `📬 *New reply from ${leadName}* <mailto:${leadEmail}|${leadEmail}>`
    : `📬 *New reply from ${leadName}*`;

  const metaBits = [];
  if (company) metaBits.push(`*Company:* ${company}`);
  if (campaign) metaBits.push(`*Campaign:* ${campaign}`);
  if (subject) metaBits.push(`*Subject:* ${subject}`);

  const blocks = [{ type: "section", text: { type: "mrkdwn", text: headerText } }];
  if (metaBits.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: metaBits.join("  |  ") } });
  blocks.push({ type: "divider" });

  let rest = body || "(empty body)";
  while (rest.length > 2900) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: rest.slice(0, 2900) } });
    rest = rest.slice(2900);
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: rest } });

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

    const replyText = extractReplyText(p.reply_message) || s(p.reply_body) || s(p.message) || s(p.body);
    const subject = s(p.subject) || s(p.reply_subject);
    const headers = p.reply_headers || p.headers || {};

    if (isOOO({ subject, body: replyText, headers })) {
      console.log("skipped as OOO");
      return res.status(200).json({ skipped: "ooo" });
    }

    await postToSlack(buildSlackMessage(p));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("handler error:", e.stack || e.message);
    return res.status(502).json({ error: e.message });
  }
}
