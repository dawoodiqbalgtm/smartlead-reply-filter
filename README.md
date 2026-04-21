# Smartlead reply filter → Slack

Vercel function that receives Smartlead reply webhooks, drops OOO/auto-replies,
and posts a formatted card to Slack with the full reply body and a link back to
the Smartlead thread.

## 1. Deploy

```bash
cd smartlead-reply-filter
npm i -g vercel        # one-time
vercel login
vercel --prod
```

Vercel gives you a URL like `https://smartlead-reply-filter.vercel.app`.
Your webhook endpoint is `https://.../api/webhook`.

## 2. Set env vars in Vercel

Project → Settings → Environment Variables:

| Key | Value |
|---|---|
| `SLACK_WEBHOOK_URL` | Incoming webhook URL from Slack app |
| `SMARTLEAD_SECRET` | Optional. Any random string. If set, Smartlead must send `?secret=...` |

Redeploy after adding vars (`vercel --prod`).

### Getting the Slack webhook

1. api.slack.com/apps → Create New App → From scratch
2. Incoming Webhooks → Activate → Add New Webhook → pick channel
3. Copy the `https://hooks.slack.com/services/...` URL into `SLACK_WEBHOOK_URL`

## 3. Point Smartlead at it

In Smartlead → Settings → Webhooks, add the Vercel URL. If you set
`SMARTLEAD_SECRET=abc123`, the URL becomes
`https://.../api/webhook?secret=abc123`. Event: Reply Received.

## 4. How OOO detection works

Two layers, both free:

1. **Email headers** — `Auto-Submitted`, `X-Autoreply`, `Precedence: auto_reply`.
   Any real auto-responder sets at least one. Most reliable signal.
2. **Regex on subject + body** — "out of office", "on vacation", "away until",
   "automatic reply", "no longer with the company", etc.

If either fires, the reply is silently dropped (HTTP 200 so Smartlead doesn't retry).

## 5. Tuning

- Add patterns → edit `OOO_PATTERNS` in `api/webhook.js`.
- Want OOO to go to a separate Slack channel instead of being dropped?
  Add a second `SLACK_WEBHOOK_URL_OOO` env var and post there in the `isOOO` branch.
- See what's being filtered → check Vercel → Deployments → Logs.
