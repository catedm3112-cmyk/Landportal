/**
 * PULSE — the accountability engine.
 *
 * Purpose (Dillon's ask): make sure no lead who raised their hand slips through,
 * and nudge Chris + Dillon ONLY about what genuinely needs a human right now —
 * never nagging on conversations that are wrapped up or parked for nurture.
 *
 * How it works: the GHL task list IS the nudge surface (in-app). Pulse keeps that
 * list honest —
 *   • a real lead that's WAITING ON US (unanswered inbound) or UNTOUCHED (new lead,
 *     no outbound yet) gets exactly one open task ("needs us");
 *   • the moment a lead is PARKED (Nurture) or DONE (won/lost/disqualified/abandoned),
 *     its auto task is cleared so it stops nudging.
 * It is idempotent — safe to run as often as you like; it never piles on a second
 * task for a contact who already has an open one.
 *
 *   GET /api/pulse            → run the sweep, create/clear tasks, return the digest
 *   GET /api/pulse?dry=1      → read-only: return the digest WITHOUT writing anything
 *
 * State model:
 *   🔴 needs-us  = active-stage open opp AND (unanswered inbound OR new+no-outbound)
 *   🟡 in-motion = active opp, ball in their court / follow-up scheduled  (no action)
 *   ⚪ parked/done = Nurture stage OR status won/lost/abandoned            (clear tasks)
 */

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = "EHl75N7YlN7nOMP30CYm";

const USERS = { dillon: "vEkFZMkHecUPXltiehzW", chris: "hCiuXELpRegkI5QKa7si" };

// Lead Intake stages (the front door).
const STAGE = {
  newLead: "2a395b97-de89-4af4-be8d-adcc3a69b8b4",
  contacted: "cd00cb5f-c341-453a-adc4-ef18d2be34f1",
  vetting: "0745d20c-17c2-44fd-9b9d-a230b2dbd005",
  qualified: "c894a510-02a3-4b29-8c24-dd117d99e5d9",
  nurture: "449d6f60-c0f1-4c28-bf12-8be2271a5a1d",
  disqualified: "e292d16d-5330-41a9-9db6-5acef9cb143c",
};
const ACTIVE_STAGES = new Set([STAGE.newLead, STAGE.contacted, STAGE.vetting, STAGE.qualified]);
const PARKED_STAGES = new Set([STAGE.nurture, STAGE.disqualified]);
const CLOSED_STATUSES = new Set(["won", "lost", "abandoned"]);

// A pulse-created task carries this marker so we only ever clear our OWN auto
// tasks, never a task a human made.
const PULSE_MARK = "[auto:pulse]";

// How long an inbound message can sit unanswered before it's "needs us" (ms).
const REPLY_GRACE_MS = 30 * 60 * 1000;      // 30 min
// How long a brand-new lead can sit with no outbound before it's "needs us" (ms).
const FIRST_TOUCH_GRACE_MS = 60 * 60 * 1000; // 60 min

// Tags that mean "don't nudge" (spam / suppression).
const SKIP_TAG = /spam|do-not-contact|\bdnd\b|couldn't find caller name/i;

// ─── REST ──────────────────────────────────────────────────────────────────────
async function ghl(path, init = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `GHL ${res.status} on ${path}`);
  return data;
}

// Open opportunities (paged; their volume is small).
async function fetchOpenOpps() {
  const out = [];
  let url = `/opportunities/search?location_id=${LOCATION_ID}&status=open&limit=100`;
  for (let i = 0; i < 5 && url; i++) {
    const d = await ghl(url);
    out.push(...(d.opportunities || []));
    const next = d.meta?.startAfter && d.meta?.startAfterId
      ? `/opportunities/search?location_id=${LOCATION_ID}&status=open&limit=100&startAfter=${d.meta.startAfter}&startAfterId=${d.meta.startAfterId}`
      : null;
    url = d.meta?.nextPageUrl ? next : null;
  }
  return out;
}

// Recent conversations keyed by contactId (last message direction + SLA timers).
async function fetchConversationsByContact() {
  const map = new Map();
  const d = await ghl(`/conversations/search?locationId=${LOCATION_ID}&sortBy=last_message_date&sort=desc&limit=100`);
  for (const c of d.conversations || []) {
    if (c.contactId && !map.has(c.contactId)) map.set(c.contactId, c);
  }
  return map;
}

async function getContactTasks(contactId) {
  const d = await ghl(`/contacts/${contactId}/tasks`);
  return d.tasks || d || [];
}

async function createTask(contactId, title, body, assignedTo) {
  const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return ghl(`/contacts/${contactId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ title, body: `${body}\n\n${PULSE_MARK}`, dueDate, completed: false, assignedTo }),
  });
}

async function completeTask(contactId, taskId) {
  return ghl(`/contacts/${contactId}/tasks/${taskId}`, {
    method: "PUT",
    body: JSON.stringify({ completed: true }),
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function oppOwner(opp) {
  return opp.assignedTo && [USERS.dillon, USERS.chris].includes(opp.assignedTo)
    ? opp.assignedTo
    : USERS.chris;
}

function hasSkipTag(tags) {
  return (tags || []).some((t) => SKIP_TAG.test(t));
}

// Does this contact already have an OPEN task? (any human or pulse task → don't pile on)
function openTasks(tasks) {
  return (tasks || []).filter((t) => !t.completed && t.status !== "completed");
}

// ─── SWEEP ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const dry = req.query?.dry === "1" || req.query?.dry === "true";
  const now = Date.now();

  try {
    const [opps, convByContact] = await Promise.all([fetchOpenOpps(), fetchConversationsByContact()]);

    const digest = {
      ranAt: new Date(now).toISOString(),
      dry,
      needsUs: [],     // 🔴 tasks created (or would be)
      inMotion: [],    // 🟡 active, ball in their court — left alone
      cleared: [],     // ⚪ parked/done — auto task cleared
      skipped: [],     // spam/suppressed or already has an open task
    };

    // Contacts touched by the opp pass, so the conversation pass doesn't re-task them.
    const handled = new Set();

    for (const opp of opps) {
      const contactId = opp.contactId;
      const name = opp.contact?.name || opp.name || contactId;
      const tags = opp.contact?.tags || [];
      const stage = opp.pipelineStageId;
      const conv = convByContact.get(contactId);
      handled.add(contactId);

      const parked = PARKED_STAGES.has(stage) || CLOSED_STATUSES.has(opp.status);
      const active = ACTIVE_STAGES.has(stage) && opp.status === "open";

      // ⚪ Parked/done → clear any auto task so it stops nudging.
      if (parked) {
        if (!dry) {
          const tasks = await getContactTasks(contactId);
          for (const t of openTasks(tasks)) {
            if ((t.body || "").includes(PULSE_MARK)) {
              await completeTask(contactId, t.id || t._id);
              digest.cleared.push({ name, task: t.title });
            }
          }
        } else {
          digest.cleared.push({ name, note: "would clear auto tasks (parked/done)" });
        }
        continue;
      }

      if (!active) continue; // opp in a non-Lead-Intake stage we don't manage here

      if (hasSkipTag(tags)) { digest.skipped.push({ name, reason: "spam/suppressed" }); continue; }

      // Decide whether the ball is in OUR court.
      let reason = null;
      const inbound = conv?.lastMessageDirection === "inbound";
      const overdue = conv?.overdueAt && conv.overdueAt < now;
      const inboundAged = conv && inbound && now - (conv.lastMessageDate || now) > REPLY_GRACE_MS;
      const isNew = stage === STAGE.newLead;
      const noOutboundEver = !conv || (!conv.lastOutboundMessageAction && conv.lastMessageDirection !== "outbound");

      if (inbound && (overdue || inboundAged)) {
        reason = "waiting on our reply";
      } else if (isNew && noOutboundEver && now - new Date(opp.createdAt).getTime() > FIRST_TOUCH_GRACE_MS) {
        reason = "new lead — not yet contacted";
      }

      if (!reason) { digest.inMotion.push({ name, stage }); continue; }

      // Idempotent: if they already have ANY open task, don't add another.
      const tasks = dry ? [] : await getContactTasks(contactId);
      if (!dry && openTasks(tasks).length) {
        digest.skipped.push({ name, reason: "already has an open task" });
        continue;
      }

      const owner = oppOwner(opp);
      const title = reason.startsWith("waiting")
        ? `⏰ Reply to ${name} — waiting on us`
        : `📞 Call ${name} — new lead, not yet contacted`;
      const body = `${name} ${reason}. ${conv?.lastMessageBody ? `Last msg: "${String(conv.lastMessageBody).slice(0, 140)}"` : ""}`.trim();

      if (!dry) await createTask(contactId, title, body, owner);
      digest.needsUs.push({ name, reason, owner: owner === USERS.chris ? "Chris" : "Dillon", title });
    }

    // ── Second pass: engaged conversations with NO managed opp ────────────────
    // Catches the "a lead reached out and nobody answered" case for people who
    // never became an opportunity (e.g. a commenter who started messaging, like
    // someone waiting on a promised email). Tightly gated to avoid noise: must be
    // an unanswered inbound that GHL flags unread or past its response SLA, from a
    // NAMED contact that isn't spam/suppressed/an anonymous caller.
    for (const [contactId, conv] of convByContact) {
      if (handled.has(contactId)) continue;
      const name = (conv.fullName || conv.contactName || "").trim();
      if (!name) continue;                              // anonymous → leave to spam/missed-call handling
      if (hasSkipTag(conv.tags)) { digest.skipped.push({ name, reason: "spam/suppressed" }); continue; }
      const inbound = conv.lastMessageDirection === "inbound";
      const waiting = inbound && (conv.unreadCount > 0 || (conv.overdueAt && conv.overdueAt < now));
      if (!waiting) continue;

      const tasks = dry ? [] : await getContactTasks(contactId);
      if (!dry && openTasks(tasks).length) { digest.skipped.push({ name, reason: "already has an open task" }); continue; }

      const owner = [USERS.dillon, USERS.chris].includes(conv.assignedTo) ? conv.assignedTo : USERS.chris;
      const title = `⏰ Reply to ${name} — waiting on us`;
      const body = `${name} messaged and it's unanswered.${conv.lastMessageBody ? ` Last: "${String(conv.lastMessageBody).slice(0, 140)}"` : ""}`;
      if (!dry) await createTask(contactId, title, body, owner);
      digest.needsUs.push({ name, reason: "waiting on our reply (no opp yet)", owner: owner === USERS.chris ? "Chris" : "Dillon", title });
    }

    digest.summary = `${digest.needsUs.length} need us, ${digest.inMotion.length} in motion, ${digest.cleared.length} cleared, ${digest.skipped.length} skipped`;
    return res.status(200).json({ success: true, ...digest });
  } catch (err) {
    console.error("Pulse error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
