// Who is asking: a Supabase Auth session, verified by Supabase itself.
//
// The app signs people in with an email code and hands the worker the
// session's access token — in the Socket.io handshake, or as a Bearer header
// on the account routes. This layer asks Supabase's own /auth/v1/user
// whether the token is a live session, the same call supabase-js makes for
// getUser(). No JWT secret on this side, no key-rotation to track, nothing
// to verify locally and get wrong: Supabase says yes or no.
//
// A yes is cached for a minute (or until the token itself expires, whichever
// is sooner), a no for fifteen seconds, so a busy feed re-asks about a
// connection once a minute rather than once a packet. A Supabase outage is
// neither a yes nor a no — it throws, and the caller fails closed.

const CACHE_CAP = 1_000;
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const TOKEN_MAX_CHARS = 4_096;

/**
 * The exp claim of a JWT, read without verifying anything — it bounds how
 * long a cached yes may live, nothing more. Verification is Supabase's.
 * @param {string} token @returns {number | null} ms since epoch
 */
export function jwtExpiryMs(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" && Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class AuthVerifier {
  /**
   * @param {{ supabaseUrl: string, apiKey: string, fetchImpl?: typeof fetch, now?: () => number }} opts
   *   apiKey is any key of the project — the service key here, since the
   *   worker holds it; the anon key works the same for this endpoint.
   */
  constructor({ supabaseUrl, apiKey, fetchImpl, now }) {
    this.url = `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`;
    this.apiKey = apiKey;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.now = now ?? Date.now;
    /** @type {Map<string, { until: number, user: { id: string, email: string } | null }>} */
    this.cache = new Map();
    this.counts = { checks: 0, hits: 0, valid: 0, invalid: 0, errors: 0 };
    this.lastError = "";
  }

  /**
   * @param {unknown} token
   * @returns {Promise<{ id: string, email: string } | null>} null = not a
   *   live session. Throws when Supabase could not be asked, which the
   *   caller must treat as "not now", never as "yes".
   */
  async verify(token) {
    if (typeof token !== "string" || token === "" || token.length > TOKEN_MAX_CHARS) return null;
    this.counts.checks++;
    const now = this.now();
    const hit = this.cache.get(token);
    if (hit && hit.until > now) {
      this.counts.hits++;
      return hit.user;
    }

    let res;
    try {
      res = await this.fetch(this.url, { headers: { apikey: this.apiKey, authorization: `Bearer ${token}` } });
    } catch (err) {
      this.counts.errors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw new Error(`auth unreachable: ${this.lastError}`);
    }
    // 401 is a dead or forged token; 403 a banned user; 400 a token GoTrue
    // could not even parse. None of those is an outage.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      this.counts.invalid++;
      this.remember(token, null, now + NEGATIVE_TTL_MS);
      return null;
    }
    if (!res.ok) {
      this.counts.errors++;
      this.lastError = `auth ${res.status}`;
      throw new Error(this.lastError);
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body.id !== "string" || body.id === "") {
      this.counts.errors++;
      this.lastError = "auth returned no user id";
      throw new Error(this.lastError);
    }
    const user = { id: body.id, email: typeof body.email === "string" ? body.email : "" };
    const exp = jwtExpiryMs(token);
    this.counts.valid++;
    this.remember(token, user, Math.min(now + POSITIVE_TTL_MS, exp ?? Number.POSITIVE_INFINITY));
    return user;
  }

  /** @param {string} token @param {{ id: string, email: string } | null} user @param {number} until */
  remember(token, user, until) {
    if (this.cache.size >= CACHE_CAP) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(token, { user, until });
  }

  /** Drop a token from the cache — after a sign-out, so it stops working at once. */
  forget(token) {
    this.cache.delete(token);
  }

  status() {
    return { ...this.counts, cached: this.cache.size, lastError: this.lastError || null };
  }
}
