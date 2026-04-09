// Supabase Edge Function — Mailchimp proxy
//
// Deploy:
//   supabase functions deploy mailchimp
//
// Set secrets (keep these server-side — never in React .env):
//   supabase secrets set \
//     MAILCHIMP_API_KEY=<your-key> \
//     MAILCHIMP_SERVER_PREFIX=<e.g. us1> \
//     MAILCHIMP_AUDIENCE_ID=<your-list-id> \
//     MAILCHIMP_FROM_NAME="Daniel Richardson" \
//     MAILCHIMP_FROM_EMAIL=daniel@makalii-metrics.com
//
// NOTE: MAILCHIMP_FROM_EMAIL must be a verified sending address in your Mailchimp account.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import md5 from "https://esm.sh/md5@2.3.0";

const API_KEY    = Deno.env.get("MAILCHIMP_API_KEY")!;
const SERVER     = Deno.env.get("MAILCHIMP_SERVER_PREFIX")!;
const AUDIENCE   = Deno.env.get("MAILCHIMP_AUDIENCE_ID")!;
const FROM_NAME  = Deno.env.get("MAILCHIMP_FROM_NAME")  ?? "Daniel Richardson";
const FROM_EMAIL = Deno.env.get("MAILCHIMP_FROM_EMAIL") ?? "daniel@makalii-metrics.com";

const BASE = `https://${SERVER}.api.mailchimp.com/3.0`;
const AUTH = `Basic ${btoa(`anystring:${API_KEY}`)}`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

async function mc(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  // 204 No Content — nothing to parse
  if (res.status === 204) return null;
  return res.json();
}

// Raw fetch that returns { ok, status, data } so callers can inspect errors
async function mcRaw(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function textToHtml(text: string): string {
  return `<html><body style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#1a1a2e;max-width:600px;margin:0 auto;padding:24px">${
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>")
  }</body></html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { action, payload } = await req.json();

    // ── upsertContact ──────────────────────────────────────────────────────
    if (action === "upsertContact") {
      const { email, firstName, lastName, tags = [] } = payload;
      const hash = md5(email.toLowerCase());
      const data = await mc(`/lists/${AUDIENCE}/members/${hash}`, "PUT", {
        email_address: email,
        status_if_new: "subscribed",
        status: "subscribed",
        merge_fields: { FNAME: firstName, LNAME: lastName },
        tags: tags.map((t: string) => ({ name: t, status: "active" })),
      });
      return new Response(JSON.stringify(data), { headers: CORS });
    }

    // ── sendEmail ──────────────────────────────────────────────────────────
    if (action === "sendEmail") {
      const { email, firstName, lastName, subject, body } = payload;
      const hash = md5(email.toLowerCase());

      // Upsert subscriber and check resulting status
      const member = await mc(`/lists/${AUDIENCE}/members/${hash}`, "PUT", {
        email_address: email,
        status_if_new: "subscribed",
        status: "subscribed",
        merge_fields: { FNAME: firstName, LNAME: lastName },
      });

      if (member?.status && member.status !== "subscribed") {
        return new Response(
          JSON.stringify({ error: `Contact status in Mailchimp is "${member.status}" — only subscribed contacts can receive campaigns. Ask them to resubscribe or update their status in Mailchimp.` }),
          { status: 422, headers: CORS },
        );
      }

      // Create campaign targeting this address only
      const campaign = await mc("/campaigns", "POST", {
        type: "regular",
        recipients: {
          list_id: AUDIENCE,
          segment_opts: {
            match: "all",
            conditions: [{
              condition_type: "EmailAddress",
              field: "EMAIL",
              op: "is",
              value: email,
            }],
          },
        },
        settings: {
          subject_line: subject,
          title: `${subject} · ${new Date().toISOString().slice(0, 10)}`,
          from_name: FROM_NAME,
          reply_to: FROM_EMAIL,
        },
      });

      if (!campaign.id) {
        return new Response(
          JSON.stringify({ error: "Campaign creation failed", detail: campaign }),
          { status: 500, headers: CORS },
        );
      }

      // Set content
      await mc(`/campaigns/${campaign.id}/content`, "PUT", {
        plain_text: body,
        html: textToHtml(body),
      });

      // Check send-checklist before firing — only hard errors block the send
      const checklist = await mc(`/campaigns/${campaign.id}/send-checklist`);
      if (checklist?.is_ready === false) {
        const errors = (checklist.items ?? [])
          .filter((i: { type: string }) => i.type === "error")
          .map((i: { heading: string; details: string }) => `${i.heading}: ${i.details}`)
          .join(" | ");
        if (errors) {
          await mcRaw(`/campaigns/${campaign.id}`, "DELETE");
          return new Response(
            JSON.stringify({ error: `Mailchimp blocked send — ${errors}` }),
            { status: 422, headers: CORS },
          );
        }
      }

      // Send — Mailchimp returns 204 No Content on success
      const sendResult = await mcRaw(`/campaigns/${campaign.id}/actions/send`, "POST");
      if (!sendResult.ok) {
        return new Response(
          JSON.stringify({ error: sendResult.data?.detail || sendResult.data?.title || "Campaign send failed" }),
          { status: 500, headers: CORS },
        );
      }

      return new Response(JSON.stringify({ campaignId: campaign.id }), { headers: CORS });
    }

    // ── getContactStats ────────────────────────────────────────────────────
    if (action === "getContactStats") {
      const { email, campaignIds } = payload as { email: string; campaignIds: string[] };
      const hash = md5(email.toLowerCase());
      const { activity = [] } = await mc(`/lists/${AUDIENCE}/members/${hash}/activity`);

      const stats: Record<string, { opened: boolean; clicked: boolean }> = {};
      for (const cid of campaignIds) {
        stats[cid] = {
          opened:  activity.some((e: { action: string; campaign_id: string }) => e.campaign_id === cid && e.action === "open"),
          clicked: activity.some((e: { action: string; campaign_id: string }) => e.campaign_id === cid && e.action === "click"),
        };
      }

      return new Response(JSON.stringify({ stats }), { headers: CORS });
    }

    // ── bulkSend ───────────────────────────────────────────────────────────
    if (action === "bulkSend") {
      const { contacts, subject, body, campaignTitle } = payload as {
        contacts: Array<{ email: string; firstName: string; lastName: string }>;
        subject: string;
        body: string;
        campaignTitle: string;
      };

      // 1. Upsert all contacts into the Mailchimp audience (parallel)
      await Promise.all(contacts.map(c =>
        mc(`/lists/${AUDIENCE}/members/${md5(c.email.toLowerCase())}`, "PUT", {
          email_address: c.email,
          status_if_new: "subscribed",
          status: "subscribed",
          merge_fields: { FNAME: c.firstName || "", LNAME: c.lastName || "" },
        })
      ));

      // 2. Create a static segment containing only these contacts
      const segment = await mc(`/lists/${AUDIENCE}/segments`, "POST", {
        name: `${campaignTitle} · ${new Date().toISOString().slice(0, 10)}`,
        static_segment: contacts.map(c => c.email),
      });

      if (!segment?.id) {
        return new Response(JSON.stringify({ error: "Failed to create audience segment", detail: segment }), { status: 500, headers: CORS });
      }

      // 3. Create one campaign targeting that segment
      const campaign = await mc("/campaigns", "POST", {
        type: "regular",
        recipients: {
          list_id: AUDIENCE,
          segment_opts: { saved_segment_id: segment.id },
        },
        settings: {
          subject_line: subject,
          title: campaignTitle,
          from_name: FROM_NAME,
          reply_to: FROM_EMAIL,
        },
      });

      if (!campaign?.id) {
        await mcRaw(`/lists/${AUDIENCE}/segments/${segment.id}`, "DELETE");
        return new Response(JSON.stringify({ error: "Failed to create campaign", detail: campaign }), { status: 500, headers: CORS });
      }

      // 4. Set campaign content — use *|FNAME|* merge tag for per-recipient personalisation
      await mc(`/campaigns/${campaign.id}/content`, "PUT", {
        plain_text: body,
        html: textToHtml(body),
      });

      // 5. Send-checklist pre-flight
      const checklist = await mc(`/campaigns/${campaign.id}/send-checklist`);
      if (checklist?.is_ready === false) {
        const errors = (checklist.items ?? [])
          .filter((i: { type: string }) => i.type === "error")
          .map((i: { heading: string; details: string }) => `${i.heading}: ${i.details}`)
          .join(" | ");
        if (errors) {
          await mcRaw(`/campaigns/${campaign.id}`, "DELETE");
          await mcRaw(`/lists/${AUDIENCE}/segments/${segment.id}`, "DELETE");
          return new Response(JSON.stringify({ error: `Mailchimp blocked send — ${errors}` }), { status: 422, headers: CORS });
        }
      }

      // 6. Send
      const sendResult = await mcRaw(`/campaigns/${campaign.id}/actions/send`, "POST");
      if (!sendResult.ok) {
        return new Response(
          JSON.stringify({ error: sendResult.data?.detail || sendResult.data?.title || "Campaign send failed" }),
          { status: 500, headers: CORS },
        );
      }

      const dashboardUrl = `https://${SERVER}.admin.mailchimp.com/campaigns/show/?id=${campaign.web_id}`;
      return new Response(JSON.stringify({
        campaignId: campaign.id,
        campaignName: campaignTitle,
        dashboardUrl,
      }), { headers: CORS });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
