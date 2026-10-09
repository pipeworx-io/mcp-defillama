interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * DefiLlama MCP — DeFi analytics from DefiLlama (free, no auth)
 *
 * Tools:
 * - defi_tvl_protocols: list/search protocols by TVL
 * - defi_protocol_detail: detailed TVL history for a protocol
 * - defi_chain_tvl: TVL breakdown by blockchain
 * - defi_protocol_fees: fee/revenue data for a protocol
 * - defi_stablecoins: stablecoin market data
 * - defi_yields: DeFi yield pool opportunities
 * - defi_token_unlocks: token unlocks across all tracked tokens in a date window
 * - defi_token_emission: one token's full vesting / emission schedule
 *
 * Unlock data comes from DefiLlama's public datasets host (the same files
 * defillama.com/unlocks renders), because api.llama.fi/emissions answers 402
 * "Upgrade to the paid API plan" (verified from a Worker 2026-10-09, fleet #2844).
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'DefiLlama');
}

const BASE = 'https://api.llama.fi';
const STABLECOINS = 'https://stablecoins.llama.fi';
const YIELDS = 'https://yields.llama.fi';
const DATASETS = 'https://defillama-datasets.llama.fi';
const COINS = 'https://coins.llama.fi';

const tools: McpToolExport['tools'] = [
  {
    name: 'defi_tvl_protocols',
    description:
      'Search DeFi protocols by name or category to compare their total value locked. Returns protocol name, TVL amount, blockchain, and category.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: {
          type: 'string',
          description: 'Filter protocols by name (case-insensitive substring match)',
        },
        category: {
          type: 'string',
          description:
            'Filter by category (e.g., "DEXes", "Lending", "Bridge", "CDP", "Yield")',
        },
      },
    },
  },
  {
    name: 'defi_protocol_detail',
    description:
      'Get detailed metrics for a specific DeFi protocol including TVL history over time, breakdown by blockchain, and token information.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        protocol: {
          type: 'string',
          description:
            'Protocol slug (e.g., "aave", "uniswap", "lido", "makerdao")',
        },
      },
      required: ['protocol'],
    },
  },
  {
    name: 'defi_chain_tvl',
    description:
      'Compare total value locked across all blockchains. Returns TVL per chain to identify where capital is concentrated.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'defi_protocol_fees',
    description:
      'Check daily fees and revenue for a DeFi protocol. Returns fee trends to analyze profitability and income changes over time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        protocol: {
          type: 'string',
          description: 'Protocol slug (e.g., "aave", "uniswap", "lido")',
        },
        data_type: {
          type: 'string',
          description:
            'Type of data: "dailyFees" or "dailyRevenue" (default: "dailyFees")',
        },
      },
      required: ['protocol'],
    },
  },
  {
    name: 'defi_stablecoins',
    description:
      'Get stablecoin market cap and distribution across blockchains. Returns supply per chain to track adoption and network preferences.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'defi_yields',
    description:
      'Find yield opportunities across DeFi pools filtered by project name, minimum TVL, or minimum APY. Returns APY, TVL, and project details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: {
          type: 'string',
          description: 'Filter by project name (case-insensitive substring match)',
        },
        min_tvl: {
          type: 'number',
          description: 'Minimum TVL in USD (e.g., 1000000 for $1M)',
        },
        min_apy: {
          type: 'number',
          description: 'Minimum APY percentage (e.g., 5 for 5%)',
        },
      },
    },
  },
  {
    name: 'defi_token_unlocks',
    description:
      'Crypto token UNLOCK calendar from DefiLlama: every scheduled vesting cliff and emission-rate change across ~370 tracked tokens in a date window (e.g. "which token unlocks are scheduled this week", "unlocks over $10M between 2026-10-05 and 2026-10-12"). Returns per event: date, token, tokens unlocked, USD value at the current DefiLlama price (with the price time), share of circulating supply, and the recipients (investors, team, ecosystem…). Default window is today through 7 days out.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'string',
          description: 'Window start, YYYY-MM-DD (UTC, inclusive). Default: today.',
        },
        to: {
          type: 'string',
          description: 'Window end, YYYY-MM-DD (UTC, inclusive). Default: from + 7 days.',
        },
        min_usd: {
          type: 'number',
          description: 'Only cliff unlocks worth at least this many USD at the current price (e.g. 1000000). Excludes emission-rate changes, which have no single USD amount.',
        },
        token: {
          type: 'string',
          description: 'Restrict to tokens whose name, symbol or DefiLlama slug contains this text (e.g. "hyperliquid", "ARB").',
        },
        limit: {
          type: 'number',
          description: 'Max events returned, sorted by date then USD value (default 100, max 500).',
        },
      },
    },
  },
  {
    name: 'defi_token_emission',
    description:
      'One crypto token\'s full vesting / EMISSION SCHEDULE from DefiLlama (e.g. "Hyperliquid HYPE unlock schedule", "when do Arbitrum team tokens vest"). Returns max supply, allocation by category (insiders, airdrop, staking…) with % unlocked so far, per-recipient unlocked-now vs final amounts, the dated unlock events (past and upcoming, with USD value at the current price), and DefiLlama\'s methodology notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        protocol: {
          type: 'string',
          description: 'DefiLlama protocol slug or name (e.g. "hyperliquid", "arbitrum", "aptos", "sui"). Unknown names return close matches.',
        },
      },
      required: ['protocol'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'defi_tvl_protocols':
      return getTvlProtocols(args.search as string | undefined, args.category as string | undefined);
    case 'defi_protocol_detail':
      return getProtocolDetail(args.protocol as string);
    case 'defi_chain_tvl':
      return getChainTvl();
    case 'defi_protocol_fees':
      return getProtocolFees(args.protocol as string, (args.data_type as string) ?? 'dailyFees');
    case 'defi_stablecoins':
      return getStablecoins();
    case 'defi_yields':
      return getYields(
        args.search as string | undefined,
        args.min_tvl as number | undefined,
        args.min_apy as number | undefined,
      );
    case 'defi_token_unlocks':
      return getTokenUnlocks(args);
    case 'defi_token_emission':
      return getTokenEmission(String(args.protocol ?? ''));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

async function getTvlProtocols(search?: string, category?: string) {
  const res = await pwFetch(`${BASE}/protocols`);
  if (!res.ok) throw await httpError(res, 'DefiLlama API error');

  const data = (await res.json()) as {
    name: string;
    slug: string;
    tvl: number;
    chain: string;
    chains: string[];
    category: string;
    symbol?: string;
    change_1h?: number;
    change_1d?: number;
    change_7d?: number;
  }[];

  let filtered = data;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
  }

  if (category) {
    const cat = category.toLowerCase();
    filtered = filtered.filter((p) => p.category?.toLowerCase() === cat);
  }

  // Return top 50 by TVL
  filtered.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  const top = filtered.slice(0, 50);

  return {
    total_matched: filtered.length,
    showing: top.length,
    protocols: top.map((p) => ({
      name: p.name,
      slug: p.slug,
      tvl: p.tvl,
      chain: p.chain,
      chains: p.chains,
      category: p.category,
      symbol: p.symbol ?? null,
      change_1d_pct: p.change_1d ?? null,
      change_7d_pct: p.change_7d ?? null,
    })),
  };
}

async function getProtocolDetail(protocol: string) {
  const res = await pwFetch(`${BASE}/protocol/${encodeURIComponent(protocol)}`);
  if (!res.ok) throw await httpError(res, 'DefiLlama API error');

  const data = (await res.json()) as {
    name: string;
    slug: string;
    description?: string;
    url?: string;
    symbol?: string;
    chain?: string;
    chains?: string[];
    category?: string;
    chainTvls?: Record<string, { tvl: { date: number; totalLiquidityUSD: number }[] }>;
    tvl?: { date: number; totalLiquidityUSD: number }[] | number;
    currentChainTvls?: Record<string, number>;
    mcap?: number;
  };

  // Get the last 30 TVL data points from the main tvl array
  const tvlHistory = Array.isArray(data.tvl)
    ? data.tvl.slice(-30).map((entry) => ({
        date: new Date(entry.date * 1000).toISOString().split('T')[0],
        tvl: entry.totalLiquidityUSD,
      }))
    : [];

  return {
    name: data.name,
    slug: data.slug,
    description: data.description ?? null,
    url: data.url ?? null,
    symbol: data.symbol ?? null,
    category: data.category ?? null,
    chain: data.chain ?? null,
    chains: data.chains ?? [],
    current_tvl: typeof data.tvl === 'number' ? data.tvl : null,
    mcap: data.mcap ?? null,
    chain_tvls: data.currentChainTvls ?? {},
    tvl_history_last_30: tvlHistory,
  };
}

async function getChainTvl() {
  const res = await pwFetch(`${BASE}/v2/chains`);
  if (!res.ok) throw await httpError(res, 'DefiLlama API error');

  const data = (await res.json()) as {
    gecko_id?: string;
    tvl: number;
    tokenSymbol?: string;
    cmcId?: string;
    name: string;
    chainId?: number;
  }[];

  data.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));

  return {
    total_chains: data.length,
    chains: data.map((c) => ({
      name: c.name,
      tvl: c.tvl,
      token_symbol: c.tokenSymbol ?? null,
      gecko_id: c.gecko_id ?? null,
    })),
  };
}

async function getProtocolFees(protocol: string, dataType: string) {
  const validTypes = ['dailyFees', 'dailyRevenue'];
  if (!validTypes.includes(dataType)) {
    throw new Error(`Invalid data_type: "${dataType}". Must be one of: ${validTypes.join(', ')}`);
  }

  const res = await pwFetch(
    `${BASE}/summary/fees/${encodeURIComponent(protocol)}?dataType=${encodeURIComponent(dataType)}`,
  );
  if (!res.ok) throw await httpError(res, 'DefiLlama API error');

  const data = (await res.json()) as {
    name?: string;
    total24h?: number;
    total48hto24h?: number;
    total7d?: number;
    total30d?: number;
    totalAllTime?: number;
    totalDataChart?: [number, number][];
    totalDataChartBreakdown?: unknown;
  };

  // Get last 30 daily entries from the chart data
  const dailyData = (data.totalDataChart ?? []).slice(-30).map(([ts, val]: [number, number]) => ({
    date: new Date(ts * 1000).toISOString().split('T')[0],
    value: val,
  }));

  return {
    protocol,
    data_type: dataType,
    name: data.name ?? protocol,
    total_24h: data.total24h ?? null,
    total_48h_to_24h: data.total48hto24h ?? null,
    total_7d: data.total7d ?? null,
    total_30d: data.total30d ?? null,
    total_all_time: data.totalAllTime ?? null,
    daily_chart_last_30: dailyData,
  };
}

async function getStablecoins() {
  const res = await pwFetch(`${STABLECOINS}/stablecoins?includePrices=true`);
  if (!res.ok) throw await httpError(res, 'DefiLlama API error');

  const data = (await res.json()) as {
    peggedAssets: {
      id: string;
      name: string;
      symbol: string;
      gecko_id?: string;
      pegType?: string;
      pegMechanism?: string;
      circulating?: Record<string, { peggedUSD?: number }>;
      price?: number;
      chains?: string[];
    }[];
  };

  const assets = (data.peggedAssets ?? [])
    .map((s) => {
      const totalMcap = s.circulating?.peggedUSD
        ? (s.circulating as unknown as { peggedUSD: number }).peggedUSD
        : null;
      return {
        name: s.name,
        symbol: s.symbol,
        peg_type: s.pegType ?? null,
        peg_mechanism: s.pegMechanism ?? null,
        price: s.price ?? null,
        circulating_mcap: totalMcap,
        chains: s.chains ?? [],
      };
    })
    .sort((a, b) => (b.circulating_mcap ?? 0) - (a.circulating_mcap ?? 0))
    .slice(0, 30);

  return {
    total_stablecoins: data.peggedAssets?.length ?? 0,
    showing: assets.length,
    stablecoins: assets,
  };
}

async function getYields(search?: string, minTvl?: number, minApy?: number) {
  const res = await pwFetch(`${YIELDS}/pools`);
  if (!res.ok) throw await httpError(res, 'DefiLlama API error');

  const data = (await res.json()) as {
    status: string;
    data: {
      pool: string;
      chain: string;
      project: string;
      symbol: string;
      tvlUsd: number;
      apy: number;
      apyBase?: number;
      apyReward?: number;
      rewardTokens?: string[];
      stablecoin?: boolean;
      ilRisk?: string;
      exposure?: string;
      poolMeta?: string;
    }[];
  };

  let pools = data.data ?? [];

  if (search) {
    const q = search.toLowerCase();
    pools = pools.filter((p) => p.project.toLowerCase().includes(q));
  }

  if (minTvl !== undefined) {
    pools = pools.filter((p) => p.tvlUsd >= minTvl);
  }

  if (minApy !== undefined) {
    pools = pools.filter((p) => p.apy >= minApy);
  }

  // Sort by TVL descending
  pools.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  const top = pools.slice(0, 50);

  return {
    total_matched: pools.length,
    showing: top.length,
    pools: top.map((p) => ({
      pool_id: p.pool,
      project: p.project,
      chain: p.chain,
      symbol: p.symbol,
      tvl_usd: p.tvlUsd,
      apy: p.apy,
      apy_base: p.apyBase ?? null,
      apy_reward: p.apyReward ?? null,
      stablecoin: p.stablecoin ?? false,
      il_risk: p.ilRisk ?? null,
      exposure: p.exposure ?? null,
    })),
  };
}

/* ── Token unlocks / emissions ──────────────────────────────────────── */

interface CliffAllocation {
  recipient?: string;
  category?: string;
  amount?: number;
}

interface LinearAllocation {
  recipient?: string;
  category?: string;
  unlockType?: string;
  previousRatePerWeek?: number;
  newRatePerWeek?: number;
  endTimestamp?: number;
}

interface UnlockEvent {
  timestamp: number;
  cliffAllocations?: CliffAllocation[];
  linearAllocations?: LinearAllocation[];
}

interface TokenPrice {
  price?: number;
  symbol?: string;
  timestamp?: number;
}

interface EmissionsIndexRow {
  token?: string;
  name?: string;
  protocolSlug?: string;
  gecko_id?: string;
  circSupply?: number;
  maxSupply?: number;
  mcap?: number;
  tokenPrice?: TokenPrice[];
  unlockEvents?: UnlockEvent[];
}

const DAY_SEC = 86_400;

function isoDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function isoTime(sec: number | undefined): string | null {
  return typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

function lastModifiedIso(res: Response): string | null {
  const lm = res.headers.get('last-modified');
  if (!lm) return null;
  const t = Date.parse(lm);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseDay(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${field} must be YYYY-MM-DD, got "${s}"`);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`${field} is not a real date: "${s}"`);
  return t / 1000;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function mapEvent(e: UnlockEvent, price: number | null, circSupply: number | null) {
  const cliffs = (e.cliffAllocations ?? []).filter((c) => typeof c.amount === 'number' && c.amount > 0);
  const cliffTokens = cliffs.reduce((sum, c) => sum + (c.amount as number), 0);
  const linear = (e.linearAllocations ?? []).map((l) => ({
    recipient: l.recipient ?? null,
    category: l.category ?? null,
    change: l.unlockType ?? null,
    previous_tokens_per_week: l.previousRatePerWeek ?? null,
    new_tokens_per_week: l.newRatePerWeek ?? null,
    ends: typeof l.endTimestamp === 'number' ? isoDate(l.endTimestamp) : null,
  }));
  return {
    date: isoDate(e.timestamp),
    timestamp: isoTime(e.timestamp),
    cliff_tokens: cliffTokens > 0 ? round(cliffTokens, 4) : 0,
    cliff_usd: cliffTokens > 0 && price !== null ? Math.round(cliffTokens * price) : null,
    pct_of_circulating_supply:
      cliffTokens > 0 && circSupply ? round((cliffTokens / circSupply) * 100, 3) : null,
    recipients: cliffs.map((c) => ({
      recipient: c.recipient ?? null,
      category: c.category ?? null,
      tokens: round(c.amount as number, 4),
    })),
    emission_rate_changes: linear,
  };
}

/**
 * Stream the ~22 MB emissionsIndex and hand each element of its top-level
 * `data` array to `onRow` one at a time. Parsing the whole file at once costs
 * ~55 MB of heap at peak (string + object graph, measured in node), which is
 * too close to the isolate limit inside the gateway; this keeps peak memory
 * at one token's record.
 */
async function streamIndexRows(body: ReadableStream<Uint8Array>, onRow: (row: EmissionsIndexRow) => void): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let rows = 0;
  for (;;) {
    const { value, done } = await reader.read();
    const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
    const offset = buf.length;
    buf += chunk;
    for (let i = offset; i < buf.length; i++) {
      const ch = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') {
        // depth 1 = the wrapper object, 2 = the data array, 3 = one row
        if (depth === 2 && ch === '{') start = i;
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 2 && ch === '}' && start >= 0) {
          onRow(JSON.parse(buf.slice(start, i + 1)) as EmissionsIndexRow);
          rows++;
          start = -1;
        }
      }
    }
    // Keep only the unfinished row (if any); everything before it is consumed.
    if (start >= 0) {
      buf = buf.slice(start);
      start = 0;
    } else {
      buf = '';
    }
    if (done) break;
  }
  if (depth !== 0) throw new Error(`DefiLlama emissionsIndex ended mid-document (depth ${depth}) — truncated response`);
  return rows;
}

async function getTokenUnlocks(args: Record<string, unknown>) {
  const todaySec = Math.floor(Date.now() / 1000 / DAY_SEC) * DAY_SEC;
  const fromSec = parseDay(args.from, 'from') ?? todaySec;
  const toDaySec = parseDay(args.to, 'to') ?? fromSec + 7 * DAY_SEC;
  if (toDaySec < fromSec) throw new Error(`to (${isoDate(toDaySec)}) is before from (${isoDate(fromSec)})`);
  const toExclusive = toDaySec + DAY_SEC;
  const minUsd = typeof args.min_usd === 'number' ? args.min_usd : args.min_usd ? Number(args.min_usd) : undefined;
  const tokenQ = typeof args.token === 'string' && args.token.trim() ? args.token.trim().toLowerCase() : null;
  const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);

  const res = await pwFetch(`${DATASETS}/emissionsIndex`);
  if (!res.ok) throw await httpError(res, 'DefiLlama emissionsIndex error');
  if (!res.body) throw new Error('DefiLlama emissionsIndex returned an empty body');

  const events: Record<string, unknown>[] = [];
  let tokensScanned = 0;
  const rowCount = await streamIndexRows(res.body, (row) => {
    tokensScanned++;
    const tp = row.tokenPrice?.[0];
    const symbol = tp?.symbol ?? null;
    if (tokenQ) {
      const hay = [row.name, row.protocolSlug, symbol, row.gecko_id].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(tokenQ)) return;
    }
    const price = typeof tp?.price === 'number' ? tp.price : null;
    for (const e of row.unlockEvents ?? []) {
      if (typeof e.timestamp !== 'number' || e.timestamp < fromSec || e.timestamp >= toExclusive) continue;
      const mapped = mapEvent(e, price, row.circSupply ?? null);
      if (mapped.cliff_tokens === 0 && mapped.emission_rate_changes.length === 0) continue;
      if (minUsd !== undefined && (mapped.cliff_usd ?? 0) < minUsd) continue;
      events.push({
        token: row.name ?? null,
        symbol,
        slug: row.protocolSlug ?? null,
        token_id: row.token ?? null,
        ...mapped,
        price_usd: price,
        price_as_of: isoTime(tp?.timestamp),
        market_cap_usd: typeof row.mcap === 'number' ? Math.round(row.mcap) : null,
      });
    }
  });
  if (rowCount === 0) throw new Error('DefiLlama emissionsIndex parsed to zero tokens — upstream format changed');

  events.sort((a, b) =>
    String(a.timestamp).localeCompare(String(b.timestamp)) ||
    ((b.cliff_usd as number | null) ?? 0) - ((a.cliff_usd as number | null) ?? 0),
  );
  const shown = events.slice(0, limit);
  const totalUsd = events.reduce((s, e) => s + ((e.cliff_usd as number | null) ?? 0), 0);

  return {
    found: events.length > 0,
    window: { from: isoDate(fromSec), to: isoDate(toDaySec) },
    filters: { min_usd: minUsd ?? null, token: tokenQ },
    tokens_scanned: tokensScanned,
    total_events: events.length,
    showing: shown.length,
    total_cliff_usd: Math.round(totalUsd),
    events: shown,
    ...(events.length === 0
      ? { note: `No scheduled unlocks in ${isoDate(fromSec)}..${isoDate(toDaySec)} among the ${tokensScanned} tokens DefiLlama tracks${tokenQ || minUsd !== undefined ? ' that match the filters' : ''}.` }
      : {}),
    usd_basis: 'cliff_usd = tokens unlocked x the current DefiLlama price (price_as_of), not the price on the unlock date.',
    data_as_of: lastModifiedIso(res),
    source: 'DefiLlama unlocks dataset (defillama-datasets.llama.fi/emissionsIndex), https://defillama.com/unlocks',
  };
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-');
}

async function getTokenEmission(protocol: string) {
  if (!protocol.trim()) throw new Error('protocol is required (e.g. "hyperliquid")');
  const slug = normalizeSlug(protocol);
  let res = await pwFetch(`${DATASETS}/emissions/${encodeURIComponent(slug)}`);
  let resolvedSlug = slug;

  if (res.status === 404) {
    const listRes = await pwFetch(`${DATASETS}/emissionsProtocolsList`);
    if (!listRes.ok) throw await httpError(listRes, 'DefiLlama emissionsProtocolsList error');
    const list = (await listRes.json()) as string[];
    const bare = slug.replace(/[^a-z0-9]/g, '');
    const matches = list.filter((p) => {
      const pb = p.replace(/[^a-z0-9]/g, '');
      return pb === bare || pb.includes(bare) || (bare.length >= 4 && bare.includes(pb));
    });
    if (matches.length === 1) {
      resolvedSlug = matches[0];
      res = await pwFetch(`${DATASETS}/emissions/${encodeURIComponent(resolvedSlug)}`);
    } else {
      return {
        found: false,
        protocol,
        message: `DefiLlama has no emission schedule under "${slug}".`,
        suggestions: matches.slice(0, 20),
        tracked_protocols: list.length,
        data_as_of: lastModifiedIso(listRes),
        source: 'DefiLlama unlocks dataset (defillama-datasets.llama.fi/emissionsProtocolsList)',
      };
    }
  }
  if (!res.ok) throw await httpError(res, 'DefiLlama emission error');

  const data = (await res.json()) as {
    name?: string;
    gecko_id?: string;
    chainName?: string;
    protocolCategory?: string;
    supplyMetrics?: Record<string, number>;
    categories?: Record<string, string[]>;
    documentedData?: {
      data?: { label: string; data: { timestamp: number; unlocked: number }[] }[];
      tokenAllocation?: {
        current?: Record<string, number>;
        final?: Record<string, number>;
        progress?: Record<string, number>;
      };
    };
    metadata?: {
      token?: string;
      total?: number;
      notes?: string[];
      sources?: string[];
      unlockEvents?: UnlockEvent[];
    };
  };

  // Current price is best-effort: the schedule is the answer, the USD figure is a convenience.
  let price: number | null = null;
  let priceAsOf: string | null = null;
  let symbol: string | null = null;
  let priceNote: string | undefined;
  const coinId = data.metadata?.token ?? (data.gecko_id ? `coingecko:${data.gecko_id}` : null);
  if (coinId) {
    const pr = await pwFetch(`${COINS}/prices/current/${encodeURIComponent(coinId)}`);
    if (pr.ok) {
      const pj = (await pr.json()) as { coins?: Record<string, TokenPrice> };
      const c = pj.coins?.[coinId];
      if (c && typeof c.price === 'number') {
        price = c.price;
        priceAsOf = isoTime(c.timestamp);
        symbol = c.symbol ?? null;
      } else {
        priceNote = `coins.llama.fi has no current price for ${coinId}`;
      }
    } else {
      priceNote = `coins.llama.fi price lookup failed with HTTP ${pr.status}`;
    }
  }

  const nowSec = Date.now() / 1000;
  const circ = data.supplyMetrics?.adjustedSupply ?? null;
  const allEvents = (data.metadata?.unlockEvents ?? [])
    .filter((e) => typeof e.timestamp === 'number')
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => ({ ...mapEvent(e, price, circ), upcoming: e.timestamp >= nowSec }));
  const upcoming = allEvents.filter((e) => e.upcoming);
  const past = allEvents.filter((e) => !e.upcoming);

  const sections = (data.documentedData?.data ?? []).map((sec) => {
    const pts = sec.data ?? [];
    let now: number | null = null;
    for (const p of pts) if (p.timestamp <= nowSec) now = p.unlocked;
    const final = pts.length ? pts[pts.length - 1] : null;
    return {
      recipient: sec.label,
      unlocked_now: now,
      unlocked_at_schedule_end: final?.unlocked ?? null,
      schedule_end: final ? isoDate(final.timestamp) : null,
    };
  });

  return {
    found: true,
    protocol: resolvedSlug,
    name: data.name ?? resolvedSlug,
    symbol,
    token_id: data.metadata?.token ?? null,
    chain: data.chainName ?? null,
    category: data.protocolCategory ?? null,
    max_supply: data.metadata?.total ?? data.supplyMetrics?.maxSupply ?? null,
    supply_metrics: data.supplyMetrics ?? null,
    price_usd: price,
    price_as_of: priceAsOf,
    ...(priceNote ? { price_note: priceNote } : {}),
    allocation_pct_by_category: data.documentedData?.tokenAllocation?.final ?? null,
    unlocked_pct_by_category: data.documentedData?.tokenAllocation?.progress ?? null,
    category_recipients: data.categories ?? null,
    recipients: sections,
    ...(upcoming.length === 0
      ? {
          upcoming_note: data.supplyMetrics?.tbdAmount
            ? `DefiLlama documents no future dated unlocks for this token; ${Math.round(data.supplyMetrics.tbdAmount).toLocaleString('en-US')} tokens have no published schedule (supply_metrics.tbdAmount).`
            : 'DefiLlama documents no future dated unlocks for this token.',
        }
      : {}),
    upcoming_events_total: upcoming.length,
    upcoming_events: upcoming.slice(0, 50),
    past_events_total: past.length,
    recent_past_events: past.slice(-10),
    notes: data.metadata?.notes ?? [],
    usd_basis: 'cliff_usd = tokens unlocked x the current DefiLlama price (price_as_of), not the price on the unlock date.',
    data_as_of: lastModifiedIso(res),
    source: `DefiLlama unlocks dataset (defillama-datasets.llama.fi/emissions/${resolvedSlug}), https://defillama.com/unlocks/${resolvedSlug}`,
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
