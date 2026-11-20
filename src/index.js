// Chronos: multi-user Cloudflare Worker.
import { renderWidget, renderWidgetSVG } from "./widget.js";
// Sign in with Notion (OAuth), each user picks or creates their Journal database,
// and /api/data reads it live from Notion.

const NOTION_VERSION = "2022-06-28";
const SESSION_DAYS = 30;
const COLORS = ["purple", "blue", "green", "brown", "pink", "red", "yellow", "gray", "orange", "default"];
const DEFAULT_COLORS = {
  Tech: "purple", AI: "blue", Quant: "green", Academics: "brown",
  Music: "pink", Fitness: "red", Loaf: "yellow", Personal: "gray",
};

export default {
  async fetch(request, rawEnv, ctx) {
    // Trim secrets in case they were piped in with a trailing newline.
    const env = { ...rawEnv };
    for (const k of ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET", "ENC_KEY"]) if (typeof env[k] === "string") env[k] = env[k].trim();
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/health") return health(env);
      if (p === "/login") return login(request, env);
      if (p === "/oauth/callback") {
        try { return await callback(request, env); }
        catch (e) { console.error("callback failed", e); return redirect("/?error=server&detail=" + encodeURIComponent(String(e.message || e).slice(0, 120)), [setCookie("oauth_state", "", 0)]); }
      }
      if (p === "/logout" && request.method === "POST") return logout(request, env);
      if (p === "/today") return await today(request, env);
      if (p === "/widget.png" || p === "/widget.svg") return await widgetImage(request, env);
      if (p.startsWith("/api/")) return await api(request, env, p, ctx);
      if (p === "/log") return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// ---------- small helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const now = () => Math.floor(Date.now() / 1000);

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const redirect = (to, extraHeaders = []) => {
  const h = new Headers({ Location: to });
  for (const c of extraHeaders) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
};

// ---------- token encryption (AES-GCM, key from ENC_KEY secret) ----------
async function aesKey(env) {
  const raw = Uint8Array.from(atob(env.ENC_KEY), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("ENC_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...ct));
}
async function decrypt(env, blob) {
  const [ivb, ctb] = blob.split(".");
  const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: dec(ivb) }, await aesKey(env), dec(ctb));
  return new TextDecoder().decode(pt);
}

// ---------- Notion API ----------
const notionBase = (env) => env.NOTION_API || "https://api.notion.com";

async function notion(env, token, path, method = "GET", body) {
  const res = await fetch(`${notionBase(env)}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new HttpError(401, "Your Notion connection expired. Sign in again.", "reauth");
  if (res.status === 403) throw new HttpError(403, "Chronos isn't allowed to edit your Notion yet. In your Notion integration, turn on \"Update content\", then sign in to Chronos again.", "no_update");
  if (res.status === 404) throw new HttpError(404, "Notion can't find that page. Make sure it's shared with the app.", "not_found");
  if (res.status === 429) throw new HttpError(429, "Notion is rate-limiting requests. Try again in a minute.", "rate_limited");
  if (!res.ok) throw new HttpError(502, `Notion API error ${res.status}: ${(await res.text()).slice(0, 300)}`, "notion");
  return res.json();
}

const plain = (rich) => (rich || []).map((r) => r.plain_text).join("");

// ---------- setup check (reveals no secret values) ----------
async function health(env) {
  const out = {
    notion_client_id: env.NOTION_CLIENT_ID ? (/^[0-9a-f-]{32,36}$/i.test(env.NOTION_CLIENT_ID) ? "ok" : "set, but doesn't look like a client ID") : "missing",
    notion_client_secret: env.NOTION_CLIENT_SECRET ? `set (${env.NOTION_CLIENT_SECRET.length} chars)` : "missing",
    enc_key: "missing",
    database: "unknown",
  };
  if (env.ENC_KEY) { try { await aesKey(env); out.enc_key = "ok"; } catch (e) { out.enc_key = "invalid: " + e.message; } }
  try { await env.DB.prepare("SELECT count(*) AS n FROM users").first(); out.database = "ok"; } catch (e) { out.database = "error: " + e.message; }
  return json(out);
}

// ---------- auth ----------
function login(request, env) {
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET || !env.ENC_KEY) {
    const missing = ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET", "ENC_KEY"].filter((k) => !env[k]).join(", ");
    return new Response(`Setup isn't finished: missing secret(s) ${missing}. Run setup.ps1 again, or: npx wrangler secret put <NAME>`, { status: 500, headers: { "content-type": "text/plain" } });
  }
  const origin = new URL(request.url).origin;
  const state = randomId();
  const auth = new URL(`${env.NOTION_AUTH_BASE || "https://api.notion.com"}/v1/oauth/authorize`);
  auth.searchParams.set("client_id", env.NOTION_CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("owner", "user");
  auth.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
  auth.searchParams.set("state", state);
  const next = new URL(request.url).searchParams.get("next");
  const cookiesOut = [setCookie("oauth_state", state, 600)];
  if (next && /^\/[a-z0-9/#?=_-]*$/i.test(next)) cookiesOut.push(setCookie("next", next, 600));
  return redirect(auth.toString(), cookiesOut);
}

async function callback(request, env) {
  const url = new URL(request.url);
  const clearState = setCookie("oauth_state", "", 0);
  if (url.searchParams.get("error")) return redirect("/?error=cancelled", [clearState]);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== cookies(request).oauth_state) return redirect("/?error=state", [clearState]);

  const res = await fetch(`${notionBase(env)}/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`),
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: `${url.origin}/oauth/callback` }),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("token exchange failed", res.status, txt);
    let detail = `HTTP ${res.status}`;
    try { const j = JSON.parse(txt); detail = [j.error, j.error_description || j.message].filter(Boolean).join(": ") || detail; } catch {}
    return redirect("/?error=token&detail=" + encodeURIComponent(detail.slice(0, 160)), [clearState]);
  }
  const t = await res.json();
  const owner = t.owner?.user || {};
  const id = t.bot_id;
  const tokenEnc = await encrypt(env, t.access_token);
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO users (id, notion_user_id, name, email, avatar, workspace_name, token_enc, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(id) DO UPDATE SET notion_user_id=?2, name=?3, email=?4, avatar=?5, workspace_name=?6, token_enc=?7, updated_at=?8`
  ).bind(id, owner.id || null, owner.name || null, owner.person?.email || null, owner.avatar_url || null, t.workspace_name || null, tokenEnc, ts).run();

  const sid = randomId();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(sid, id, ts + SESSION_DAYS * 86400).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(ts).run();
  const next = cookies(request).next;
  const dest = next && /^\/[a-z0-9/#?=_-]*$/i.test(next) ? next : "/";
  return redirect(dest, [clearState, setCookie("next", "", 0), setCookie("sid", sid, SESSION_DAYS * 86400)]);
}

async function logout(request, env) {
  const sid = cookies(request).sid;
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  return redirect("/", [setCookie("sid", "", 0)]);
}

async function currentUser(request, env) {
  const sid = cookies(request).sid;
  if (!sid) return null;
  return env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?"
  ).bind(sid, now()).first();
}

// ---------- schema detection ----------
function analyse(db) {
  const props = Object.entries(db.properties || {}).map(([name, v]) => ({ name, ...v }));
  const pick = (type, preferred) => props.find((p) => p.type === type && p.name === preferred) || props.find((p) => p.type === type);
  const titleProp = props.find((p) => p.type === "title");
  const date = pick("date", "Date");
  const tags = pick("multi_select", "Did");
  const done = pick("checkbox", "Day done");
  const hours = props.filter((p) => p.type === "number" && /\s+h$/i.test(p.name));
  const problems = [];
  if (!date) problems.push("no date field");
  if (!hours.length) problems.push('no number fields ending in " h"');
  return {
    title: plain(db.title) || "Untitled",
    url: db.url,
    date: date?.name, tags: tags?.name, done: done?.name, titleProp: titleProp?.name,
    classes: hours.map((p) => ({ prop: p.name, name: p.name.replace(/\s+h$/i, "") })),
    tagOptions: tags?.multi_select?.options || [],
    ok: problems.length === 0,
    problems,
  };
}

function classColors(user, classes) {
  const saved = JSON.parse(user.class_colors || "{}");
  const used = new Set();
  const out = {};
  for (const c of classes) {
    const col = saved[c.name] || DEFAULT_COLORS[c.name];
    if (col && !used.has(col)) { out[c.name] = col; used.add(col); }
  }
  for (const c of classes) {
    if (!out[c.name]) {
      const free = COLORS.find((x) => !used.has(x)) || "default";
      out[c.name] = free; used.add(free);
    }
  }
  return out;
}

// ---------- API ----------
async function api(request, env, p, ctx) {
  await ensureSchema(env);
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Not signed in", "signin");
  let token;
  try { token = await decrypt(env, user.token_enc); }
  catch { throw new HttpError(401, "Please sign in with Notion again.", "signin"); }
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  if (p === "/api/me") {
    return json({ name: user.name, email: user.email, avatar: user.avatar, workspace: user.workspace_name, journalId: user.journal_id, kustom: !!user.kustom_token });
  }

  // Called right after sign-in when no Journal is chosen yet:
  // one usable database -> pick it; none -> create "Chronos" + Journal in the user's Private section.
  if (p === "/api/auto" && request.method === "POST") {
    if (user.journal_id) return json({ status: "ready" });
    const r = await notion(env, token, "/search", "POST", { page_size: 100, filter: { property: "object", value: "database" } });
    const usable = r.results.map((o) => ({ o, a: analyse(o) })).filter((x) => x.a.ok);
    if (usable.length === 1) {
      await env.DB.prepare("UPDATE users SET journal_id = ?, updated_at = ? WHERE id = ?").bind(usable[0].o.id, now(), user.id).run();
      return json({ status: "selected", title: usable[0].a.title });
    }
    if (usable.length > 1) return json({ status: "choose" });
    return json({ status: "needs_classes" });
  }

  // Create the Journal with the classes the user picked.
  // Goes in the user's Private section, or inside parentPageId if given.
  if (p === "/api/create" && request.method === "POST") {
    const classes = cleanClasses(body.classes);
    let parentId = body.parentPageId;
    let homeUrl;
    if (!parentId) {
      const home = await notion(env, token, "/pages", "POST", {
        parent: { type: "workspace", workspace: true },
        icon: { type: "emoji", emoji: "⏳" },
        properties: { title: { title: [{ type: "text", text: { content: "Chronos" } }] } },
        children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "Log each day in the Journal below: add Did tags, type hours in the \" h\" fields, tick Day done. Your Chronos dashboard updates live." } }] } }],
      });
      parentId = home.id; homeUrl = home.url;
    }
    const db = await notion(env, token, "/databases", "POST", journalSchema(parentId, classes));
    const tz = request.cf?.timezone || "UTC";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const label = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date());
    await notion(env, token, "/pages", "POST", {
      parent: { database_id: db.id },
      properties: { Entry: { title: [{ type: "text", text: { content: label } }] }, Date: { date: { start: today } } },
    });
    const colors = Object.fromEntries(classes.map((c) => [c.name, c.color]));
    await env.DB.prepare("UPDATE users SET journal_id = ?, class_colors = ?, updated_at = ? WHERE id = ?").bind(db.id, JSON.stringify(colors), now(), user.id).run();
    // Fill last month with sample entries so the dashboard isn't empty on day one.
    let demo = 0;
    try { demo = await addDemoMonth(env, token, db.id, classes, today); } catch (e) { console.error("demo month failed", e); }
    return json({ status: "created", url: homeUrl || db.url, demo });
  }

  if (p === "/api/journals") {
    const search = async (object, query, max) => {
      const out = [];
      let cursor;
      for (let i = 0; i < max; i++) {
        const r = await notion(env, token, "/search", "POST", {
          page_size: 100, start_cursor: cursor, query: query || undefined,
          filter: { property: "object", value: object },
        });
        out.push(...r.results);
        if (!r.has_more) break;
        cursor = r.next_cursor;
      }
      return out;
    };
    const seen = new Set(), dbs = [];
    for (const o of [...(await search("database", "Journal", 2)), ...(await search("database", "", 5))]) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const a = analyse(o);
      dbs.push({ id: o.id, title: a.title, ok: a.ok, problems: a.problems, classes: a.classes.map((c) => c.name) });
    }
    const pages = (await search("page", "", 3))
      .filter((o) => o.parent?.type !== "database_id")
      .map((o) => {
        const t = Object.values(o.properties || {}).find((v) => v.type === "title");
        return { id: o.id, title: plain(t?.title) || "Untitled" };
      });
    dbs.sort((a, b) => b.ok - a.ok);
    return json({ databases: dbs, pages });
  }

  if (p === "/api/journal" && request.method === "POST") {
    let id = String(body.id || "").trim();
    // Accept a raw ID, a UUID, or a Notion link like notion.so/ws/Journal-<32 hex>?v=<view>
    const seg = id.split(/[?#]/)[0].split("/").pop().replace(/-/g, "");
    if (/^[0-9a-f]{32}$/i.test(seg.slice(-32))) id = seg.slice(-32);
    if (!id) throw new HttpError(400, "Pick a database or paste its link");
    body.id = id;
    const a = analyse(await notion(env, token, `/databases/${body.id}`));
    if (!a.ok) throw new HttpError(400, `That database won't work yet: ${a.problems.join(", ")}.`);
    await env.DB.prepare("UPDATE users SET journal_id = ?, updated_at = ? WHERE id = ?").bind(body.id, now(), user.id).run();
    return json({ ok: true });
  }

  if (p === "/api/settings" && request.method === "POST") {
    const colors = {};
    for (const [k, v] of Object.entries(body.colors || {})) if (COLORS.includes(v)) colors[String(k).slice(0, 60)] = v;
    await env.DB.prepare("UPDATE users SET class_colors = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(colors), now(), user.id).run();
    return json({ ok: true });
  }

  if (p === "/api/data") {
    if (!user.journal_id) throw new HttpError(409, "Pick your Journal first", "no_journal");
    return json(await loadData(env, user, token));
  }

  if (p === "/api/demo" && request.method === "POST" && body.remove) {
    if (!user.journal_id) throw new HttpError(409, "No Journal yet", "no_journal");
    const a = analyse(await notion(env, token, `/databases/${user.journal_id}`));
    if (!a.titleProp) return json({ removed: 0 });
    const r = await notion(env, token, `/databases/${user.journal_id}/query`, "POST", {
      page_size: 40, filter: { property: a.titleProp, title: { ends_with: DEMO_MARK } },
    });
    await inBatches(r.results, 3, (pg) => notion(env, token, `/pages/${pg.id}`, "PATCH", { archived: true }));
    return json({ removed: r.results.length });
  }

  // Read or save a single day's entry.
  if (p === "/api/day") {
    if (!user.journal_id) throw new HttpError(409, "Pick your Journal first", "no_journal");
    const date = String(request.method === "POST" ? body.date : new URL(request.url).searchParams.get("date") || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Bad date");
    const db = await notion(env, token, `/databases/${user.journal_id}`);
    const a = analyse(db);
    if (!a.ok) throw new HttpError(409, `Your Journal is missing something: ${a.problems.join(", ")}.`, "bad_journal");
    const found = await notion(env, token, `/databases/${user.journal_id}/query`, "POST", { page_size: 1, filter: { property: a.date, date: { equals: date } } });
    let page = found.results[0];
    if (request.method !== "POST") return json(dayOut(a, page, date));

    // Validate input
    const classNames = new Set(a.classes.map((c) => c.name));
    const hours = {};
    for (const [k, v] of Object.entries(body.hours || {})) {
      if (!classNames.has(k)) continue;
      const n = Math.round(Number(v) * 4) / 4;
      if (!(n >= 0 && n <= 24)) throw new HttpError(400, `Hours for ${k} must be between 0 and 24.`);
      hours[k] = n;
    }
    const total = Object.values(hours).reduce((x, y) => x + y, 0);
    if (total > 24) throw new HttpError(400, "That's more than 24 hours in one day.");
    let tags = Array.isArray(body.tags) ? [...new Set(body.tags.map((t) => String(t).replace(/,/g, " ").trim().slice(0, 50)).filter(Boolean))].slice(0, 20) : null;

    // New tags: add them to the Did field in their class colour first, so they don't get a random colour.
    if (tags && a.tags) {
      const existing = new Set(a.tagOptions.map((o) => o.name));
      const colors = classColors(user, a.classes);
      const fresh = (Array.isArray(body.newTags) ? body.newTags : [])
        .map((t) => ({ name: String(t.name || "").replace(/,/g, " ").trim().slice(0, 50), color: colors[t.cls] || "default" }))
        .filter((t) => t.name && !existing.has(t.name) && tags.includes(t.name));
      if (fresh.length) {
        await notion(env, token, `/databases/${user.journal_id}`, "PATCH", {
          properties: { [a.tags]: { multi_select: { options: [...a.tagOptions.map((o) => ({ name: o.name, color: o.color })), ...fresh] } } },
        });
      }
    }

    const props = {};
    for (const c of a.classes) if (c.name in hours) props[c.prop] = { number: hours[c.name] > 0 ? hours[c.name] : null };
    if (tags && a.tags) props[a.tags] = { multi_select: tags.map((name) => ({ name })) };
    if (typeof body.done === "boolean" && a.done) props[a.done] = { checkbox: body.done };
    if (page) {
      page = await notion(env, token, `/pages/${page.id}`, "PATCH", { properties: props });
    } else {
      props[a.date] = { date: { start: date } };
      if (a.titleProp) props[a.titleProp] = { title: [{ type: "text", text: { content: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(date + "T00:00:00Z")) } }] };
      page = await notion(env, token, "/pages", "POST", { parent: { database_id: user.journal_id }, properties: props });
    }
    const stamp = Date.now();
    await env.DB.prepare("UPDATE users SET updated_at = ? WHERE id = ?").bind(stamp, user.id).run();
    return json(dayOut(a, page, date));
  }

  // KWGT "Remote Msg Token": lets Chronos refresh the widget instantly after a save.
  if (p === "/api/kustom" && request.method === "POST") {
    const token = String(body.token ?? "").trim();
    if (token && (token.length < 20 || token.length > 400 || /\s/.test(token))) throw new HttpError(400, "That doesn't look like a Kustom Remote Msg Token. Copy it again from KWGT → Settings → Advanced.");
    if (body.test) {
      const t = token || user.kustom_token;
      if (!t) throw new HttpError(400, "Save your token first.");
      const r = await pingKustom(t, String(Date.now()), env, false);
      return json(r);
    }
    await env.DB.prepare("UPDATE users SET kustom_token = ? WHERE id = ?").bind(token || null, user.id).run();
    return json({ ok: true, saved: !!token });
  }

  if (p === "/api/widget") {
    let key = user.widget_key;
    if (!key || (request.method === "POST" && body.rotate)) {
      key = randomId();
      await env.DB.prepare("UPDATE users SET widget_key = ?, updated_at = ? WHERE id = ?").bind(key, now(), user.id).run();
    }
    return json({ key });
  }

  if (p === "/api/account" && request.method === "POST" && body.confirm === "delete") {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
    return json({ ok: true }, 200, { "Set-Cookie": setCookie("sid", "", 0) });
  }

  throw new HttpError(404, "Not found");
}

// ---------- shared data loading ----------
async function loadData(env, user, token) {
  const a = analyse(await notion(env, token, `/databases/${user.journal_id}`));
  if (!a.ok) throw new HttpError(409, `Your Journal is missing something: ${a.problems.join(", ")}.`, "bad_journal");
  const colors = classColors(user, a.classes);
  const colorToClass = {};
  for (const [cls, col] of Object.entries(colors)) colorToClass[col] ??= cls;
  const days = [];
  let cursor;
  for (let i = 0; i < 30; i++) {
    const r = await notion(env, token, `/databases/${user.journal_id}/query`, "POST", {
      page_size: 100, start_cursor: cursor, sorts: [{ property: a.date, direction: "ascending" }],
    });
    for (const pg of r.results) {
      const P = pg.properties;
      const date = P[a.date]?.date?.start?.slice(0, 10);
      if (!date) continue;
      const hours = {};
      for (const c of a.classes) {
        const v = P[c.prop]?.number;
        if (typeof v === "number" && v > 0) hours[c.name] = v;
      }
      const tags = a.tags ? (P[a.tags]?.multi_select || []).map((t) => ({ name: t.name, cls: colorToClass[t.color] || "Unsorted" })) : [];
      const title = a.titleProp ? plain(P[a.titleProp]?.title) : "";
      days.push({ date, done: a.done ? !!P[a.done]?.checkbox : false, hours, tags, ...(title.endsWith(DEMO_MARK) ? { demo: true } : {}) });
    }
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return {
    generated: new Date().toISOString(),
    journal: { title: a.title, url: a.url },
    classes: a.classes.map((c) => ({ name: c.name, color: colors[c.name] })),
    tagOptions: a.tagOptions.map((o) => ({ name: o.name, color: o.color, cls: colorToClass[o.color] || "Unsorted" })),
    colors: COLORS,
    days,
  };
}

function localToday(request) {
  const tz = request.cf?.timezone || "UTC";
  const d = new Date();
  return {
    iso: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
    label: new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d),
  };
}

// Adds columns introduced after the first release. Cheap no-op once done.
let schemaChecked = false;
async function ensureSchema(env) {
  if (schemaChecked) return;
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN widget_key TEXT").run(); } catch { /* already there */ }
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS users_widget_key ON users(widget_key)").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE users ADD COLUMN kustom_token TEXT").run(); } catch { /* already there */ }
  schemaChecked = true;
}

// ---------- "Log today": find or create today's entry, then open it in Notion ----------
async function today(request, env) {
  await ensureSchema(env);
  const user = await currentUser(request, env);
  if (!user) return redirect("/login?next=/today");
  if (!user.journal_id) return redirect("/");
  let token;
  try { token = await decrypt(env, user.token_enc); } catch { return redirect("/login?next=/today"); }
  const a = analyse(await notion(env, token, `/databases/${user.journal_id}`));
  if (!a.ok) return redirect("/");
  const t = localToday(request);
  const found = await notion(env, token, `/databases/${user.journal_id}/query`, "POST", {
    page_size: 1, filter: { property: a.date, date: { equals: t.iso } },
  });
  let page = found.results[0];
  if (!page) {
    const props = { [a.date]: { date: { start: t.iso } } };
    if (a.titleProp) props[a.titleProp] = { title: [{ type: "text", text: { content: t.label } }] };
    page = await notion(env, token, "/pages", "POST", { parent: { database_id: user.journal_id }, properties: props });
  }
  const web = page.url;
  const u = new URL(web);
  // On Android, an intent link opens the Notion app directly, falling back to the website.
  const intent = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=notion.id;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  const android = /Android/i.test(request.headers.get("user-agent") || "");
  const target = android ? intent : web;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening today…</title>
<style>body{font:16px -apple-system,Segoe UI,Roboto,sans-serif;background:#191919;color:#e6e6e4;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center}a{color:#e6e6e4;display:inline-block;margin:8px;padding:10px 16px;border:1px solid #3a3a3a;border-radius:10px;text-decoration:none}p{color:#9b9b98}</style></head>
<body><div><h2>Opening ${escapeHtml(t.label)} in Notion…</h2><p>If nothing happens, tap below.</p><a href="${escapeHtml(target)}">Open in Notion</a><a href="/">Back to Chronos</a></div>
<script>location.replace(${JSON.stringify(target)});</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- widget image: /widget.png?key=...&theme=dark|light&size=wide|square ----------
async function widgetImage(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const theme = url.searchParams.get("theme") === "light" ? "light" : "dark";
  const size = url.searchParams.get("size") === "square" ? "square" : "wide";
  // Optional exact shape from the widget app (e.g. KWGT si(rwidth)/si(rheight)); only the ratio matters.
  const w = parseFloat(url.searchParams.get("w")), h = parseFloat(url.searchParams.get("h"));
  const ratio = w > 0 && h > 0 ? Math.round((w / h) * 100) / 100 : undefined;
  if (key.length < 20) return new Response("Missing key", { status: 400 });
  const t = localToday(request);
  // Cache for 5 minutes per key/theme/size/day so widgets don't hammer Notion.
  // Check the key first (cheap), so a reset link stops working immediately even if cached.
  const user = await env.DB.prepare("SELECT * FROM users WHERE widget_key = ?").bind(key).first();
  if (!user) return new Response("Unknown or reset key. Copy the new link from Chronos.", { status: 404 });
  // updated_at changes whenever the user saves a day, so a fresh image is drawn right after logging.
  const cacheKey = new Request(`https://chronos-cache/${url.pathname}/${encodeURIComponent(key)}/${theme}/${size}/${ratio || ""}/${t.iso}/${user.updated_at}`);
  const cache = caches.default;
  // Our server-side copy lives 5 minutes, but phones must never reuse an old image themselves.
  const fresh = (r) => { const h = new Headers(r.headers); h.set("cache-control", "no-cache, no-store, must-revalidate"); return new Response(r.body, { status: r.status, headers: h }); };
  const hit = await cache.match(cacheKey);
  if (hit) return fresh(hit);
  if (!user.journal_id) return new Response("No Journal picked yet.", { status: 409 });
  let token;
  try { token = await decrypt(env, user.token_enc); } catch { return new Response("Sign in to Chronos again.", { status: 401 }); }
  const data = await loadData(env, user, token);
  const svg = url.pathname.endsWith(".svg");
  const opts = { today: t.iso, theme, size, ratio };
  const res = svg
    ? new Response(renderWidgetSVG(data, opts), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" } })
    : new Response(await renderWidget(data, opts), { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } });
  await cache.put(cacheKey, res.clone());
  return fresh(res);
}

// Kustom allows about 5 messages per minute. On a 429 we wait (up to 25s, as Kustom says) and try once more.
async function pingKustom(token, value, env, retry = true) {
  const r = await fetch(`${env?.KUSTOM_API || "https://api.kustom.rocks"}/msg`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokens: [token], data: { chronos: value } }),
  });
  const info = {
    ok: r.ok, status: r.status,
    remaining: r.headers.get("x-ratelimit-remaining"),
    reset: r.headers.get("x-ratelimit-reset") || r.headers.get("retry-after"),
    body: r.ok ? "" : (await r.text()).slice(0, 200),
  };
  if (!r.ok) console.error("kustom msg", JSON.stringify(info));
  if (r.status === 429 && retry) {
    let wait = Number(info.reset);
    if (wait > 1e9) wait = wait - Math.floor(Date.now() / 1000); // epoch seconds -> seconds from now
    if (!(wait > 0)) wait = 12;
    if (wait <= 25) { await new Promise((res) => setTimeout(res, wait * 1000 + 300)); return pingKustom(token, value, env, false); }
  }
  return info;
}

function dayOut(a, page, date) {
  if (!page) return { date, exists: false, hours: {}, tags: [], done: false };
  const P = page.properties || {};
  const hours = {};
  for (const c of a.classes) { const v = P[c.prop]?.number; if (typeof v === "number" && v > 0) hours[c.name] = v; }
  return {
    date, exists: true, url: page.url, hours,
    tags: a.tags ? (P[a.tags]?.multi_select || []).map((t) => t.name) : [],
    done: a.done ? !!P[a.done]?.checkbox : false,
  };
}

// ---------- demo month ----------
const DEMO_MARK = "· demo";

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// Sample entries for every day of last month (relative to todayIso), titled "… · demo".
// Deterministic per class list, so it looks the same if regenerated.
async function addDemoMonth(env, token, dbId, classes, todayIso) {
  const [ty, tm] = todayIso.split("-").map(Number);
  const y = tm === 1 ? ty - 1 : ty, m = tm === 1 ? 11 : tm - 2; // last month, 0-based
  const nDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  let seed = 7; for (const c of classes) for (const ch of c.name) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  // Give each class a "typical" weight so the month has a believable shape.
  const weight = classes.map((_, i) => 1 / (i + 1.3));
  const pick = () => { let r = rnd() * weight.reduce((a, b) => a + b, 0); for (let i = 0; i < classes.length; i++) { r -= weight[i]; if (r <= 0) return i; } return 0; };
  const pages = [];
  for (let d = 1; d <= nDays; d++) {
    const date = new Date(Date.UTC(y, m, d));
    const weekend = [0, 6].includes(date.getUTCDay());
    const n = Math.min(classes.length, 1 + Math.floor(rnd() * (weekend ? 2 : 3)));
    const chosen = new Set(); let guard = 0;
    while (chosen.size < n && guard++ < 20) chosen.add(pick());
    const props = {
      Entry: { title: [{ type: "text", text: { content: `${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(date)} ${DEMO_MARK}` } }] },
      Date: { date: { start: date.toISOString().slice(0, 10) } },
      Did: { multi_select: [...chosen].map((i) => ({ name: classes[i].name })) },
      "Day done": { checkbox: rnd() < 0.85 },
      Plan: { rich_text: [{ type: "text", text: { content: "Sample day. Remove all demo entries from the Chronos menu." } }] },
    };
    for (const i of chosen) props[`${classes[i].name} h`] = { number: Math.round((0.5 + rnd() * (weekend ? 4 : 3.5)) * 2) / 2 };
    pages.push(props);
  }
  await inBatches(pages, 3, (properties) => notion(env, token, "/pages", "POST", { parent: { database_id: dbId }, properties }));
  return pages.length;
}

function cleanClasses(input) {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "Pick at least one class.");
  if (input.length > 10) throw new HttpError(400, "10 classes at most (Notion has 10 tag colours).");
  const seen = new Set(), colors = new Set(), out = [];
  for (const c of input) {
    const name = String(c?.name || "").replace(/[,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30).replace(/\s+h$/i, "");
    if (!name) throw new HttpError(400, "A class name is empty.");
    if (seen.has(name.toLowerCase())) throw new HttpError(400, `"${name}" is listed twice.`);
    seen.add(name.toLowerCase());
    let color = COLORS.includes(c?.color) && !colors.has(c.color) ? c.color : COLORS.find((x) => !colors.has(x));
    colors.add(color);
    out.push({ name, color });
  }
  return out;
}

function journalSchema(parentPageId, classes) {
  const hours = {};
  for (const c of classes) hours[`${c.name} h`] = { number: { format: "number" } };
  return {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Journal" } }],
    is_inline: true,
    properties: {
      Entry: { title: {} },
      Date: { date: {} },
      Plan: { rich_text: {} },
      // One starter tag per class, in the class colour. Users add their own sub-themes later.
      Did: { multi_select: { options: classes.map((c) => ({ name: c.name, color: c.color })) } },
      "Day done": { checkbox: {} },
      ...hours,
      Notes: { rich_text: {} },
    },
  };
}
