import "./lib/als-global"; // FIRST: set globalThis.AsyncLocalStorage before Next loads (E504 guard)
import "./lib/load-env"; // load a cwd .env so `npm run dev` honours it
import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import {
  getBackendType,
  usePtyHost,
  useContainer,
  wrapWithContainer,
  resetSessionBackend,
  getSessionBackend,
} from "./lib/session-backend";
import {
  LocalTransport,
  HostTransport,
  type PtyTransport,
} from "./lib/session-backend/pty/transport";
import { AttachSession } from "./lib/session-backend/pty/attach-session";
import { getHostClient } from "./lib/session-backend/pty/host-client";
import {
  computeManagedStatuses,
  diffStatuses,
  snapshotStatuses,
  detectPushEvents,
  statusById,
  type PushEvent,
} from "./lib/session-status";
import { sendPushToAll, hasPushSubscriptions } from "./lib/push";
import { sessionVerifyTick } from "./lib/session-verify";
import {
  decideBudgetActions,
  applyBudgetDecision,
  currentBudgetStages,
  currentParked,
  pruneBudgetState,
  budgetParkEnabled,
  isBudgetParked,
} from "./lib/budget-park";
import {
  actionsForKind,
  canApproveFromPrompt,
} from "./lib/notification-actions";
import { notificationTag } from "./lib/notification-policy";
import { sanitizeNotificationText } from "./lib/notification-text";
import { captureSnapshot } from "./lib/snapshots";
import {
  peekPrompt,
  dequeuePrompt,
  hasAnyQueued,
  enqueuePrompt,
  listQueue,
} from "./lib/prompt-queue";
import { dueSchedules, fireSchedule } from "./lib/scheduler";
import { RESUME_MAX_PER_DAY, RESUME_FALLBACK_MS } from "./lib/rate-limit";
import { utcDay } from "./lib/utc-day";
// nextAutoAnswerAction stays: the push fan-out reuses it to suppress a "needs you"
// push for a prompt the answer actor is about to auto-answer this tick.
import { nextAutoAnswerAction } from "./lib/auto-steer";
import {
  nextErrorLoopAction,
  buildLoopPushBody,
  normalizeErrorSig,
  ERROR_LOOP_THRESHOLD,
  ERROR_LOOP_WINDOW_MS,
  type LoopTrack,
} from "./lib/error-loop";
import {
  nextStuckAction,
  buildStuckPushBody,
  WATCHDOG_STUCK_MS,
  WATCHDOG_MAX_GAP_MS,
  type StuckTrack,
} from "./lib/watchdog";
import { dispatchBackoffThreshold } from "./lib/rate-limit-window";
import { tokenMeter, contextWindowFor } from "./lib/context-window";
import {
  nextCompactAction,
  COMPACT_THRESHOLD,
  COMPACT_COOLDOWN_MS,
  COMPACT_MAX_PER_DAY,
} from "./lib/auto-compact";
import {
  compactMemoryEnabled,
  customCompactPrompt,
  buildCompactCommand,
  buildCompactMemoryMarkdown,
  buildReinjectMessage,
  nextReinjectAction,
  COMPACT_MEMORY_FILE,
} from "./lib/compact-memory";
import { extractTranscriptEntries } from "./lib/summarize";
import { readClaudeTranscriptRaw } from "./lib/claude-transcript";
import { mkdir, writeFile } from "fs/promises";
import { join as joinNativePath, dirname as nativeDirname } from "path";
import { buildChannelDeliveryText } from "./lib/channel-delivery";
import {
  nextUnreadMessage,
  claimDelivery,
  resetDelivery,
  sessionsWithPendingDelivery,
} from "./lib/channels";
import { computeSessionCosts } from "./lib/session-cost";
import {
  persistCostSamples,
  shouldSampleCost,
  COST_SAMPLE_INTERVAL_MS,
} from "./lib/cost-history";
import { reconcileTick, reconcileOrphans } from "./lib/dispatch/reconciler";
import { evictStale as evictStaleWarmPool } from "./lib/dispatch/warm-pool";
import {
  getBudgetConfig,
  budgetEnabled,
  detectBudgetBreaches,
  snapshotBudgetLevels,
  type BudgetLevel,
} from "./lib/budget";
import { backendKeyForSession } from "./lib/providers/registry";
import {
  makeGuardedInterval,
  getAutoFeatures,
  anyTickEnabled,
  describeEnabled,
} from "./lib/auto-features";
import {
  makeClaimWrite,
  runWriteActor,
  queueActor,
  resumeActor,
  answerActor,
  channelActor,
  type TickContext,
} from "./lib/status-tick";
import { homeDir, defaultInteractiveShell } from "./lib/platform";
import { getDb, queries, type Session } from "./lib/db";
import { REMOTE_ADDR_HEADER, SCOPE_HEADER } from "./lib/api-security";
import { resolveTokenScope } from "./lib/tokens";
import { statusDetector, type SessionStatus } from "./lib/status-detector";
import {
  getServerToken,
  trustLoopback,
  trustTailscale,
  configuredAllowedOrigins,
  readSharedOrigins,
  buildAuthCookie,
  safeRedirectPath,
  decideHttpAuth,
  decideWsAuth,
} from "./lib/auth";

const dev = process.env.NODE_ENV !== "production";
// Bind to localhost by default so a dev server is never accidentally exposed to
// the network. Override with STOA_HOST=0.0.0.0 if you genuinely need remote access
// (pair with STOA_REQUIRE_AUTH=1 / STOA_AUTH=off as documented).
const hostname = process.env.STOA_HOST || "127.0.0.1";

// Auth (Jupyter-style token; loopback trusted unless STOA_REQUIRE_AUTH=1). The
// Origin allowlist on WS upgrades runs even when the token gate is disabled.
const SERVER_TOKEN = getServerToken();
const AUTH_ENABLED = SERVER_TOKEN !== null;
const TRUST_LOOPBACK = trustLoopback();
const TRUST_TAILSCALE = trustTailscale();
const ALLOWED_ORIGINS = configuredAllowedOrigins();

const AUTH_REQUIRED_HTML = `<!doctype html><meta charset="utf-8"><title>Stoa — token required</title><body style="font-family:system-ui;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#ddd;background:#111"><h1 style="font-size:1.3rem">🔒 Stoa needs a token</h1><p>This server requires an access token for non-local connections. Open the tokenized URL printed in the server console, or append <code>?token=YOUR_TOKEN</code> to the address.</p></body>`;

const firstQueryValue = (
  v: string | string[] | undefined
): string | undefined => (Array.isArray(v) ? v[0] : v);

// Support: npm run dev -- -p 3012
const pFlagIndex = process.argv.indexOf("-p");
const portArg = pFlagIndex !== -1 ? process.argv[pFlagIndex + 1] : undefined;
const port = parseInt(portArg || process.env.PORT || "3011", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);

      // Inject the real TCP remote address as a trusted header so API routes can
      // gate on the connection IP (Next 16 doesn't populate NextRequest.ip).
      // OVERWRITE any client-supplied copy so a remote caller can't spoof it.
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr) req.headers[REMOTE_ADDR_HEADER] = remoteAddr;
      else delete req.headers[REMOTE_ADDR_HEADER];

      // #46/#49 scope: strip any client-supplied x-stoa-scope, default admin, and
      // let the auth gate downgrade to observer. Unspoofable (server-set), so an
      // admin-only route can trust it (like the remote-addr header above).
      delete req.headers[SCOPE_HEADER];
      req.headers[SCOPE_HEADER] = "admin";
      if (AUTH_ENABLED) {
        const decision = decideHttpAuth({
          serverToken: SERVER_TOKEN,
          remoteAddr: req.socket.remoteAddress,
          trustLoopback: TRUST_LOOPBACK,
          trustTailscale: TRUST_TAILSCALE,
          authHeader: req.headers.authorization,
          cookieHeader: req.headers.cookie,
          queryToken: firstQueryValue(parsedUrl.query.token),
          resolveScope: resolveTokenScope,
        });
        if (decision.type === "deny") {
          res.statusCode = 401;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(AUTH_REQUIRED_HTML);
          return;
        }
        // A read-only OBSERVER (spectator) token: reject every mutating method
        // (only GET/HEAD/OPTIONS pass), and stamp the scope for admin-only routes.
        // NOTE: this is a coarse method gate — a few GET handlers do benign
        // state-SYNC writes (e.g. touch updated_at, backfill claude_session_id,
        // cache PR status) that an observer's Live-Wall polling can trigger. That's
        // not an escalation (the observer can't choose what's written, and no
        // action route uses GET); a route that must be strictly read-only for an
        // observer checks requestScope() === "admin" itself.
        if (decision.type === "allow" && decision.scope === "observer") {
          const method = (req.method || "GET").toUpperCase();
          if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
            res.statusCode = 403;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("read-only (observer) token");
            return;
          }
          req.headers[SCOPE_HEADER] = "observer";
        }
        if (decision.type === "bootstrap") {
          // Valid ?token= → set the cookie and redirect to the same URL without
          // the token in it (so it doesn't linger in history/logs/referrers).
          const secure = req.headers["x-forwarded-proto"] === "https";
          delete parsedUrl.query.token;
          const qs = new URLSearchParams(
            parsedUrl.query as Record<string, string>
          ).toString();
          res.statusCode = 302;
          res.setHeader("Set-Cookie", buildAuthCookie(decision.token, secure));
          res.setHeader(
            "Location",
            safeRedirectPath(parsedUrl.pathname) + (qs ? `?${qs}` : "")
          );
          res.end();
          return;
        }
      }

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  // Terminal WebSocket server
  const terminalWss = new WebSocketServer({ noServer: true });
  // Live status-events server: pushes session status deltas to the UI.
  const eventsWss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrades
  server.on("upgrade", (request, socket, head) => {
    const { pathname, query } = parse(request.url || "", true);

    const wss =
      pathname === "/ws/terminal"
        ? terminalWss
        : pathname === "/ws/events"
          ? eventsWss
          : null;
    // Let HMR and other WebSocket connections pass through to Next.js.
    if (!wss) return;

    // Disable Nagle's algorithm on the terminal/events socket. Keystrokes are
    // tiny (one WS frame per character); with Nagle on, TCP holds each small
    // packet waiting for the previous ACK (~40ms, up to 200ms with delayed
    // ACKs), so every character's echo round-trips late — a constant, "always
    // there" typing lag, worst over WiFi to a phone. SSH and terminals disable
    // Nagle for exactly this reason; do the same so keystrokes flush instantly.
    request.socket.setNoDelay(true);

    // Origin allowlist (always — CSWSH defense) + token gate. The browser sends
    // the auth cookie on a same-origin upgrade, so no client wiring is needed.
    const decision = decideWsAuth({
      serverToken: SERVER_TOKEN,
      origin: request.headers.origin,
      host: request.headers.host,
      // Env allowlist + live tunnel origins registered by `stoa share` (read per
      // upgrade so a share started after the server needs no restart).
      allowedOrigins: [...ALLOWED_ORIGINS, ...readSharedOrigins()],
      remoteAddr: request.socket.remoteAddress,
      trustLoopback: TRUST_LOOPBACK,
      trustTailscale: TRUST_TAILSCALE,
      authHeader: request.headers.authorization,
      cookieHeader: request.headers.cookie,
      queryToken: firstQueryValue(query.token),
      resolveScope: resolveTokenScope,
    });
    if (decision.type === "deny") {
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n${decision.reason}`
      );
      socket.destroy();
      return;
    }
    // #46/#49 The terminal WS is a WRITE surface (keystrokes into a session), so a
    // read-only observer is rejected. The events WS (Live Wall status stream) is
    // read-only and open to observers — the whole point of a spectator link.
    if (pathname === "/ws/terminal" && decision.scope !== "admin") {
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nread-only (observer) token`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // Terminal connections. Two modes:
  //  - tmux: spawn a disposable shell pty per socket; the client drives
  //    `tmux attach` (legacy behavior, macOS/Linux).
  //  - pty: subscribe the socket to a long-lived session via a PtyTransport
  //    (in-process registry = Tier 1, or the host daemon = Tier 2). The
  //    host-vs-in-process decision is finalized at startup (see the probe before
  //    server.listen), so usePtyHost() here agrees with getSessionBackend() —
  //    no split brain.
  terminalWss.on("connection", (ws: WebSocket) => {
    if (getBackendType() !== "pty") {
      handleTmuxConnection(ws);
      return;
    }
    const useHost = usePtyHost();
    let transport: PtyTransport = useHost
      ? new HostTransport()
      : new LocalTransport();
    // #47: wrap the Tier-1 transport in the container decorator when opt-in — the
    // SAME decision getSessionBackend makes, so the live terminal and the board
    // agree on one transport (no split brain). Fail-open when docker is absent.
    if (!useHost && useContainer()) transport = wrapWithContainer(transport);
    handlePtyTerminal(ws, transport);
  });

  // ── live status events (/ws/events) ──
  // Push session status deltas so the board updates instantly, as a safety-net
  // ALONGSIDE the client's 5s poll (which still backstops missed ticks + removed
  // sessions). The ticker only does work while a client is listening.
  const eventClients = new Set<WebSocket>();
  let lastStatusSnapshot = new Map<string, string>();
  // Separate status-only snapshot for Web Push transition detection (runs even
  // with no WS client connected, so closed-tab pushes still fire).
  let lastPushStatusById = new Map<string, SessionStatus>();
  // Per-(session,event) cooldown so a flapping agent doesn't spam pushes
  // (mirrors the in-app checkStateChanges cooldown).
  const lastPushAt = new Map<string, number>();
  const PUSH_COOLDOWN_MS = 15000;
  // One typed snapshot of the STOA_AUTO_* posture, read once at startup (each
  // flag is a `=== "1"` read, so the value is fixed for the process lifetime).
  // Every X_ENABLED below reads from this, so the flags have ONE source of truth
  // that can't drift from a second inline read.
  const auto = getAutoFeatures();
  // One at-a-glance posture line before the per-feature detail banners below.
  const autoSummary = describeEnabled(auto);
  if (autoSummary !== "none") {
    console.log(`> Unattended auto-features enabled: ${autoSummary}.`);
  }
  // Opt-in per-turn working-tree snapshots (refs/stoa/snap/*). Off by default —
  // it writes shadow commits to the session's repo. Tracks prev status so we
  // snapshot only on a running→settled turn boundary.
  const SNAPSHOTS_ENABLED = auto.snapshots;
  let lastSnapStatusById = new Map<string, SessionStatus>();
  // Sessions with a queued prompt already sent this idle period (cleared when the
  // session next goes non-idle) — so one prompt dispatches per idle, not per tick.
  const queueDispatched = new Set<string>();
  // Rate-limit auto-resume (opt-in via STOA_AUTO_RESUME=1; detection is always
  // on). Tracks sessions we've already nudged once per rate-limited episode, so
  // we resume exactly once at reset — not every 2.5s tick — and clear it when the
  // session is no longer rate-limited (next episode can resume again).
  const AUTO_RESUME_ENABLED = auto.resume;
  const rateLimitResumed = new Set<string>();
  // When the limit was first seen this episode (per session) — anchors the
  // opt-in no-reset fallback. Cleared when the limit clears.
  const rateLimitParkedAt = new Map<string, number>();
  // Per-session per-day resume budget: { day, count }. Reset when the UTC day
  // rolls over; caps how many times we nudge a flapping limit in a day.
  const rateLimitResumeDay = new Map<string, { day: string; count: number }>();
  // Once-per-(session,day) log when the budget is spent, so we say it ONCE.
  const rateLimitBudgetLogged = new Set<string>();
  if (AUTO_RESUME_ENABLED) {
    console.log(
      `> Rate-limit auto-resume on (STOA_AUTO_RESUME=1): a session that hit a provider limit is nudged (queued prompt or Enter) once its reset time passes — capped at ${RESUME_MAX_PER_DAY === 0 ? "unlimited" : `${RESUME_MAX_PER_DAY}/day`}, skipped while the session is actively working${RESUME_FALLBACK_MS > 0 ? `, with a ${Math.round(RESUME_FALLBACK_MS / 60000)}m fallback when no reset time is parsed` : ""}.`
    );
  }
  // Auto-steer: policy auto-answer (opt-in via STOA_AUTO_ANSWER=1; detection is
  // always on). Maps a session → the prompt line we last answered, so we press
  // Enter once per distinct prompt — not every 2.5s tick — and re-arm when a NEW
  // prompt appears or the prompt clears.
  const AUTO_ANSWER_ENABLED = auto.answer;
  const autoAnswered = new Map<string, string>();
  if (AUTO_ANSWER_ENABLED) {
    console.log(
      "> Auto-answer on (STOA_AUTO_ANSWER=1): Enter accepts a routine prompt ONLY when it takes the highlighted single-shot Yes (or an explicit Press-Enter / [Y/n] default); blanket-permission, default-No, and destructive-looking prompts are left for you (and still pushed)."
    );
  }
  // One-tap push Approve (opt-in via STOA_PUSH_APPROVE=1). Adds an "Approve" button to the
  // lock-screen push for a waiting session at a SAFE press-Enter-to-continue prompt; the tap
  // presses Enter (re-verified server-side). OFF by default → notifications stay attention-only.
  const PUSH_APPROVE_ENABLED = auto.pushApprove;
  if (PUSH_APPROVE_ENABLED) {
    console.log(
      "> Push Approve on (STOA_PUSH_APPROVE=1): a lock-screen Approve button one-taps Enter on a press-Enter-to-continue / [Y/n] prompt (re-verified at tap); permission menus and risky prompts stay attention-only."
    );
  }
  // Auto-steer: error-loop escalation (opt-in via STOA_ERROR_LOOP=1). Tracks each
  // session's persisting error signature so we PAGE ONCE per distinct error when it
  // sticks for >= the threshold ticks AND >= the elapsed window — the terminal is
  // never written to, so a false positive costs only one extra notification.
  const ERROR_LOOP_ENABLED = auto.errorLoop;
  const errorLoops = new Map<string, LoopTrack>();
  if (ERROR_LOOP_ENABLED) {
    console.log(
      `> Error-loop escalation on (STOA_ERROR_LOOP=1): a session stuck on the SAME error for ~${Math.round(ERROR_LOOP_WINDOW_MS / 1000)}s gets ONE "stuck in a loop" push, then it's left for you. The terminal is never written to.`
    );
  }
  // Self-healing watchdog: wedged-session escalation (opt-in via
  // STOA_AUTO_WATCHDOG=1). Tracks each session's continuous-"running" wall-clock
  // so a spinner that never settles (a hung request / frozen TUI) pages ONCE per
  // stuck episode — the terminal is never written to, so a false positive costs
  // only one extra notification. Any turn boundary (a non-"running" tick) resets
  // the streak, so a normally-iterating agent never pages.
  const WATCHDOG_ENABLED = auto.watchdog;
  const stuckSessions = new Map<string, StuckTrack>();
  if (WATCHDOG_ENABLED) {
    console.log(
      `> Watchdog on (STOA_AUTO_WATCHDOG=1): a session stuck "running" continuously for ~${Math.round(WATCHDOG_STUCK_MS / 60000)}m gets ONE "may be stuck" push, then it's left for you. The terminal is never written to.`
    );
  }
  // Proactive rate-limit backoff (opt-in via STOA_DISPATCH_RATELIMIT_BACKOFF). The
  // reconciler reads the threshold fresh each tick; this is just the startup banner.
  const DISPATCH_BACKOFF_THRESHOLD = dispatchBackoffThreshold();
  if (DISPATCH_BACKOFF_THRESHOLD > 0) {
    console.log(
      `> Dispatch rate-limit backoff on (STOA_DISPATCH_RATELIMIT_BACKOFF): new Claude dispatches are HELD while the binding 5h/7d rate-limit window is >= ${Math.round(DISPATCH_BACKOFF_THRESHOLD * 100)}% (needs the M2b statusline hook for data). Reactive resume still drains sessions already AT the limit.`
    );
  }
  // Inter-agent channel PUSH delivery (opt-in via STOA_AUTO_CHANNEL_DELIVER=1).
  // Channels are always readable via the channel_* MCP tools (pull); this only
  // adds the unattended INJECTION of one unread message into a recipient's
  // terminal at a clean turn boundary — off by default, since writing into a
  // session is the risky part (same stance as auto-resume). `channelDelivering`
  // keeps one delivery in flight per session so a slow paste can't double-send.
  const CHANNEL_DELIVER_ENABLED = auto.channelDeliver;
  const channelDelivering = new Set<string>();
  if (CHANNEL_DELIVER_ENABLED) {
    console.log(
      `> Inter-agent channel delivery on (STOA_AUTO_CHANNEL_DELIVER=1): an unread channel message is injected into the recipient's terminal at its next idle turn boundary (one at a time, with a directive "from another agent" wrapper). Without this, channels are pull-only (channel_inbox).`
    );
  }
  if (SNAPSHOTS_ENABLED) {
    console.log(
      "> Per-turn snapshots on (STOA_SNAPSHOTS=1): the status ticker runs continuously and writes refs/stoa/snap/* at each turn boundary."
    );
  }
  // Background cost sampling (opt-in via STOA_AUTO_COST_SAMPLE=1). History also
  // accrues passively whenever the cost badge is open (that GET persists); this
  // tick keeps it accruing for unattended/overnight runs. Read-only w.r.t. the
  // fleet (computes cost + writes the session_costs table — never touches a
  // session), so it's safe to leave on; it's opt-in only to keep default DB
  // writes unchanged. The guarded interval below guards the slow transcript reads;
  // `lastCostSampleMs` drives the interval-independent cadence gate.
  const COST_SAMPLE_ENABLED = auto.costSample;
  let lastCostSampleMs: number | null = null;
  if (COST_SAMPLE_ENABLED) {
    console.log(
      `> Cost sampling on (STOA_AUTO_COST_SAMPLE=1): the persisted spend history (session_costs) is refreshed every ${Math.round(COST_SAMPLE_INTERVAL_MS / 60000)}m so it keeps accruing even when no one's watching the cost badge.`
    );
  }
  // Auto-/compact (opt-in via STOA_AUTO_COMPACT=1). Unlike the read-only cost sampler and
  // the escalate-only watchdog/error-loop, this WRITES /compact to a session — so it's off
  // by default and fires ONLY at an idle boundary (the pure nextCompactAction decides).
  // `lastCompactAt` tracks the per-session cooldown; the guarded interval below
  // guards the slow reads.
  const AUTO_COMPACT_ENABLED = auto.compact;
  const lastCompactAt = new Map<string, number>();
  // Per-session UTC-day compaction count, so a stuck-high session can't /compact forever.
  const compactDay = new Map<string, { day: string; count: number }>();
  // #25 external memory: sessions whose pre-compact state was flushed to
  // .stoa/compact-memory.md and are awaiting the one-shot post-compact
  // pointer (value = when the flush happened; nextReinjectAction decides).
  const compactReinject = new Map<string, number>();
  if (AUTO_COMPACT_ENABLED) {
    console.log(
      `> Auto-compact on (STOA_AUTO_COMPACT=1): a Claude session whose context window is >= ${Math.round(COMPACT_THRESHOLD * 100)}% full at an idle boundary (no open prompt) is sent /compact (${Math.round(COMPACT_COOLDOWN_MS / 60000)}m cooldown${COMPACT_MAX_PER_DAY > 0 ? `, ${COMPACT_MAX_PER_DAY}/day cap` : ""}), so a long/overnight run reclaims headroom before the painful auto-compaction. Claude-only.`
    );
    if (compactMemoryEnabled()) {
      console.log(
        `> Compact external memory on (STOA_COMPACT_MEMORY=1): the recent conversation tail is flushed to ${COMPACT_MEMORY_FILE} before each /compact, and a pointer is injected at the next idle boundary after compaction lands.`
      );
    }
    const startupPrompt = customCompactPrompt();
    if (startupPrompt) {
      console.log(
        `> Compact custom prompt on (STOA_AUTO_COMPACT_PROMPT): "${startupPrompt}"`
      );
    }
  } else if (compactMemoryEnabled() || customCompactPrompt()) {
    // The whole tick is gated on the trigger — these knobs are inert alone.
    console.warn(
      "> STOA_COMPACT_MEMORY / STOA_AUTO_COMPACT_PROMPT are set but STOA_AUTO_COMPACT is not — auto-compact (and the memory flush) will not run."
    );
  }
  const shouldPush = (ev: PushEvent): boolean => {
    const key = `${ev.id}-${ev.kind}`;
    const now = Date.now();
    if (now - (lastPushAt.get(key) ?? 0) < PUSH_COOLDOWN_MS) return false;
    lastPushAt.set(key, now);
    return true;
  };

  // Friendly session name for a push body (falls back to the backend key).
  const pushFor = (ev: PushEvent) => {
    let name = ev.name;
    try {
      name =
        (queries.getSession(getDb()).get(ev.id) as Session | undefined)?.name ??
        ev.name;
    } catch {
      // DB unavailable — use the backend key
    }
    // The name is untrusted (user/agent-set, sometimes derived from a captured
    // terminal line). Strip ANSI/box-drawing/control chars so the toast never
    // renders as "strange vertical lines"; fall back to the (ASCII) session id.
    name = sanitizeNotificationText(name, { fallback: ev.id });
    const verb =
      ev.kind === "waiting"
        ? "needs your input"
        : ev.kind === "error"
          ? "hit an error"
          : "finished";
    return sendPushToAll({
      title: "Stoa",
      body: `${name} ${verb}`,
      // #52 grouping: needs-you kinds share a per-session tag so a newer prompt
      // REPLACES the older needs-you banner; "done" gets its OWN tag (via the
      // kind arg) so a silent completion can't dismiss an unanswered needs-you
      // banner. The SW adds `renotify` only for waiting/error.
      tag: notificationTag(ev.id, ev.kind),
      url: "/",
      // #52: the transition kind rides the wire so the SW applies the display
      // policy (silent "done" vs loud needs-you) + quiet-hours/mute gate.
      kind: ev.kind,
      // Lock-screen action buttons → /api/sessions/[id]/respond. A waiting session at a safe
      // press-Enter-to-continue prompt also gets one-tap Approve (#9), re-verified server-side.
      sessionId: ev.id,
      actions: actionsForKind(ev.kind, {
        canApprove: PUSH_APPROVE_ENABLED && canApproveFromPrompt(ev.promptKind),
      }),
    });
  };

  const broadcastEvent = (obj: unknown) => {
    const data = JSON.stringify(obj);
    for (const ws of eventClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  };

  eventsWss.on("connection", (ws: WebSocket) => {
    eventClients.add(ws);
    // Force the next tick to re-broadcast everything so the just-connected
    // client gets the current state (it merges deltas into its status cache).
    lastStatusSnapshot = new Map();
    ws.on("close", () => eventClients.delete(ws));
    ws.on("error", () => eventClients.delete(ws));
  });

  let statusTickBusy = false;
  setInterval(async () => {
    const wsListening = eventClients.size > 0;
    // Web Push must fire with no tab open, so the ticker also runs whenever a
    // push subscription exists (computeManagedStatuses is cheap when idle).
    const pushEnabled = hasPushSubscriptions();
    const queuesPending = hasAnyQueued();
    // When any screen-observing auto-feature is armed, keep the ticker running
    // with no UI/push/queue: a rate-limited session resumes itself only if we
    // keep capturing screens. anyTickEnabled(auto) is exactly the snapshots /
    // resume / answer / error-loop / watchdog / channel-deliver set.
    if (
      !wsListening &&
      !pushEnabled &&
      !queuesPending &&
      !anyTickEnabled(auto)
    ) {
      if (lastStatusSnapshot.size) lastStatusSnapshot = new Map();
      if (lastPushStatusById.size) lastPushStatusById = new Map();
      if (lastSnapStatusById.size) lastSnapStatusById = new Map();
      if (queueDispatched.size) queueDispatched.clear();
      if (rateLimitResumed.size) rateLimitResumed.clear();
      if (rateLimitParkedAt.size) rateLimitParkedAt.clear();
      if (rateLimitResumeDay.size) rateLimitResumeDay.clear();
      if (rateLimitBudgetLogged.size) rateLimitBudgetLogged.clear();
      if (autoAnswered.size) autoAnswered.clear();
      if (errorLoops.size) errorLoops.clear();
      if (stuckSessions.size) stuckSessions.clear();
      if (channelDelivering.size) channelDelivering.clear();
      return;
    }
    if (statusTickBusy) return; // don't stack ticks if a capture runs slow
    statusTickBusy = true;
    try {
      const curr = await computeManagedStatuses();
      if (wsListening) {
        const deltas = diffStatuses(lastStatusSnapshot, curr);
        lastStatusSnapshot = snapshotStatuses(curr);
        if (deltas.length) broadcastEvent({ type: "status", deltas });
      }
      if (pushEnabled) {
        const events = detectPushEvents(lastPushStatusById, curr);
        lastPushStatusById = statusById(curr);
        // Fan out to every subscription, throttled per-event. FIRE-AND-FORGET:
        // never await push I/O inside the tick, or a slow/hung endpoint would
        // hold statusTickBusy and stall the live WS status broadcast. The
        // "don't double-notify" decision is made PER-DEVICE in the service
        // worker (suppress when any Stoa window is open on that device).
        for (const ev of events) {
          // Auto-steer silences the routine prompts → don't fire a "needs your
          // input" push for one we're about to auto-answer this tick; the escalated
          // prompts (blanket/destructive/freeform) still push — they DO need you.
          if (ev.kind === "waiting" && AUTO_ANSWER_ENABLED) {
            const s = curr.find((c) => c.id === ev.id);
            if (
              s?.prompt &&
              nextAutoAnswerAction({ prompt: s.prompt, status: s.status }) ===
                "answer"
            )
              continue;
          }
          if (shouldPush(ev))
            void pushFor(ev).catch((err) =>
              console.error("web push failed:", err)
            );
        }
      }
      // #19 verify badge: observe each session's turn boundary — done → run the
      // project's verify command (fire-and-forget, capped), new turn → clear
      // the stale verdict. Keeps its own prev-map inside the module, so it's
      // independent of the push gating above. Never throws / never awaits.
      try {
        sessionVerifyTick(curr);
      } catch (err) {
        console.error("session verify tick failed:", err);
      }
      if (SNAPSHOTS_ENABLED) {
        // Snapshot on a turn boundary: the agent went from working to settled.
        // Fire-and-forget — captureSnapshot runs several git calls; never block
        // the tick on it (mirrors the push fan-out above).
        for (const s of curr) {
          const prev = lastSnapStatusById.get(s.id);
          if (
            prev === "running" &&
            (s.status === "waiting" ||
              s.status === "idle" ||
              s.status === "error")
          ) {
            const row = queries.getSession(getDb()).get(s.id) as
              Session | undefined;
            if (row?.working_directory)
              void captureSnapshot(
                row.working_directory,
                s.id,
                s.lastLine
              ).catch((err) => console.error("snapshot capture failed:", err));
          }
        }
        lastSnapStatusById = statusById(curr);
      }
      // Prompt queue: drain the next queued prompt when a session is genuinely
      // ready. A finished turn and a permission prompt are BOTH "waiting"; only a
      // finished turn flips to "idle" when acknowledged (a real prompt keeps
      // matching the waiting patterns). So acknowledge waiting+queued sessions to
      // disambiguate, then dispatch only on "idle" — never pasting a task into a
      // pending permission dialog. Fire-and-forget; dequeue on a successful send.
      const liveIds = new Set(curr.map((s) => s.id));
      for (const id of [...queueDispatched])
        if (!liveIds.has(id)) queueDispatched.delete(id);
      for (const id of [...rateLimitResumed])
        if (!liveIds.has(id)) rateLimitResumed.delete(id);
      for (const id of [...rateLimitParkedAt.keys()])
        if (!liveIds.has(id)) rateLimitParkedAt.delete(id);
      for (const id of [...rateLimitResumeDay.keys()])
        if (!liveIds.has(id)) rateLimitResumeDay.delete(id);
      for (const id of [...rateLimitBudgetLogged])
        if (!liveIds.has(id)) rateLimitBudgetLogged.delete(id);
      // Prune the push-cooldown map every tick (NOT only while a push subscription
      // exists) so its `${id}-${kind}` keys can't outlive their sessions after the
      // last device unsubscribes.
      if (lastPushAt.size) {
        for (const key of lastPushAt.keys()) {
          if (!liveIds.has(key.slice(0, key.lastIndexOf("-")))) {
            lastPushAt.delete(key);
          }
        }
      }
      // #31: assemble the per-tick context ONCE, then drive the four WRITE actors
      // (queue > resume > answer > channel) through the claimWrite arbiter so "at
      // most one terminal write per session per tick" is STRUCTURAL, not per-pair
      // predicates. Observe/escalate stages stay inline above & below. Each actor's
      // decide() sets its once-guard synchronously BEFORE runWriteActor fires the
      // send fire-and-forget, so a later actor in the same tick sees it — identical
      // interleaving to the old inline loops. lib/status-tick.ts owns the actors.
      const tickNowMs = Date.now();
      const ctx: TickContext = {
        curr,
        byId: new Map(curr.map((s) => [s.id, s])),
        nowMs: tickNowMs,
        resumeDay: utcDay(tickNowMs),
        knobs: {
          resumeFallbackMs: RESUME_FALLBACK_MS,
          resumeMaxPerDay: RESUME_MAX_PER_DAY,
        },
        flags: { autoResume: AUTO_RESUME_ENABLED },
        maps: {
          queueDispatched,
          rateLimitResumed,
          rateLimitParkedAt,
          rateLimitResumeDay,
          rateLimitBudgetLogged,
          autoAnswered,
          channelDelivering,
        },
        deps: {
          backend: getSessionBackend,
          isBudgetParked,
          peekPrompt,
          dequeuePrompt: (id) => {
            dequeuePrompt(id);
          },
          acknowledge: (name) => statusDetector.acknowledge(name),
          nextUnreadMessage,
          claimDelivery,
          resetDelivery,
          buildChannelDeliveryText,
          log: (m) => console.log(m),
        },
        claimWrite: makeClaimWrite(),
      };

      // WRITE ACTOR 1 — queue-dispatch (always on): drain the next queued prompt
      // for a genuinely idle-ready session; acknowledge a settled waiting turn.
      for (const s of curr) runWriteActor(queueActor, ctx, s);

      // WRITE ACTOR 2 — rate-limit auto-resume (opt-in nudge). Runs for EVERY
      // session: unconditionally clears the once/park/log guards when a session is
      // no longer limited (or errored/dead) and anchors parkedAt at first sight of
      // the limit; the actual nudge is gated by AUTO_RESUME inside decide(). A
      // queued prompt already sent by actor 1 this idle period COUNTS as the resume
      // (marks resumed + charges the daily budget, sends nothing).
      for (const s of curr) runWriteActor(resumeActor, ctx, s);

      // WRITE ACTOR 3 — auto-answer (opt-in): press Enter on a routine prompt whose
      // default is the safe affirmative, once per distinct prompt. Never a
      // rate-limited session (actor 2 owns it). Feature-gated; its liveIds prune of
      // the once-per-prompt guard runs only while enabled, as before.
      if (AUTO_ANSWER_ENABLED) {
        for (const s of curr) runWriteActor(answerActor, ctx, s);
        for (const id of [...autoAnswered.keys()])
          if (!liveIds.has(id)) autoAnswered.delete(id);
      }

      // Auto-steer: error-loop escalation (opt-in). A session whose turn ENDS on an
      // error (status "error" — the status detector's narrow provider-failure
      // envelopes, not normal output) with the SAME normalized error for the
      // threshold ticks AND the elapsed window is stuck; we PAGE ONCE (a distinct
      // "stuck in a loop" push), then leave it for the human. The terminal is NEVER
      // written to — a false positive costs one extra notification, never a derailed
      // agent. Conservative: a changing error / a flip to "running" / a rate-limited
      // session all reset the track, so a productively-iterating agent never pages.
      // The pure nextErrorLoopAction owns the decision + the next track state.
      if (ERROR_LOOP_ENABLED) {
        const nowMs = Date.now();
        for (const s of curr) {
          const signature =
            s.status === "error" ? normalizeErrorSig(s.lastLine) : "";
          const { action, next } = nextErrorLoopAction({
            isError: s.status === "error",
            rateLimited: !!s.rateLimit,
            signature,
            nowMs,
            prev: errorLoops.get(s.id),
            threshold: ERROR_LOOP_THRESHOLD,
            minWindowMs: ERROR_LOOP_WINDOW_MS,
          });
          if (next) errorLoops.set(s.id, next);
          else errorLoops.delete(s.id);
          if (action !== "escalate" || !next) continue; // track / idle → no page
          // `next.escalated` is already true (set before the send), so a subsequent
          // tick on the same error → "track", never a second page for this loop.
          const name = sanitizeNotificationText(s.name, { fallback: s.id });
          console.log(
            `error-loop: escalating ${s.name} (stuck ${next.count}× on: ${s.lastLine})`
          );
          void sendPushToAll({
            title: "Stoa",
            body: buildLoopPushBody(name, next),
            // #52: stable per-session tag (grouping) + needs-you kind so the SW
            // renotifies loudly and it isn't silenced as a routine completion.
            tag: notificationTag(s.id),
            url: "/",
            kind: "error",
            sessionId: s.id,
            actions: actionsForKind("error"),
          }).catch((err) => console.error("error-loop push failed:", err));
        }
        for (const id of [...errorLoops.keys()])
          if (!liveIds.has(id)) errorLoops.delete(id);
      }

      // Self-healing watchdog: wedged-session escalation (opt-in). A session that
      // stays "running" continuously past the ceiling (a hung request / frozen
      // spinner that never settles) gets ONE "may be stuck" push, then it's left
      // for the human. ESCALATE-ONLY: like the error loop, the terminal is never
      // written to — a false positive costs one extra notification, never a
      // derailed agent. The pure nextStuckAction owns the decision + the next
      // track state; any non-"running" tick (a turn boundary) clears the streak,
      // so a normally-iterating agent never reaches the ceiling.
      if (WATCHDOG_ENABLED) {
        const nowMs = Date.now();
        for (const s of curr) {
          const { action, next } = nextStuckAction({
            isRunning: s.status === "running",
            // A rate-limited session's spinner/countdown can keep it "running"
            // for the whole limit window — that's the resume loop's job, never a
            // wedge. Exclude it so it can't false-page (mirrors the error loop).
            rateLimited: !!s.rateLimit,
            nowMs,
            prev: stuckSessions.get(s.id),
            stuckMs: WATCHDOG_STUCK_MS,
            // Restart the streak across an unobserved gap (a starved tick, a host
            // sleep, a clock step) so "stuck" means continuously observed running.
            maxGapMs: WATCHDOG_MAX_GAP_MS,
          });
          if (next) stuckSessions.set(s.id, next);
          else stuckSessions.delete(s.id);
          if (action !== "escalate" || !next) continue; // track / idle → no page
          // `next.escalated` is already true (set before the send), so a later
          // tick still running → "track", never a second page for this streak.
          const name = sanitizeNotificationText(s.name, { fallback: s.id });
          console.log(
            `watchdog: escalating ${s.name} (running ~${Math.round((next.lastMs - next.firstMs) / 60000)}m without settling)`
          );
          void sendPushToAll({
            title: "Stoa",
            body: buildStuckPushBody(name, next),
            // #52: stable per-session tag (grouping) + needs-you kind so the SW
            // renotifies loudly and it isn't silenced as a routine completion.
            tag: notificationTag(s.id),
            url: "/",
            kind: "error",
            sessionId: s.id,
            actions: actionsForKind("error"),
          }).catch((err) => console.error("watchdog push failed:", err));
        }
        for (const id of [...stuckSessions.keys()])
          if (!liveIds.has(id)) stuckSessions.delete(id);
      }

      // WRITE ACTOR 4 — inter-agent channel delivery (opt-in): inject one unread
      // message into a settled recipient's terminal, claiming the row atomically
      // BEFORE the paste so two attempts can't double-deliver. One SELECT DISTINCT
      // for recipients with a pending message; resolve each through the tick's byId
      // index (a session not live this snapshot is skipped, as before) and run the
      // actor. The liveIds prune of the in-flight guard runs only while enabled.
      if (CHANNEL_DELIVER_ENABLED) {
        for (const recipientId of sessionsWithPendingDelivery()) {
          const s = ctx.byId.get(recipientId);
          if (s) runWriteActor(channelActor, ctx, s);
        }
        for (const id of [...channelDelivering])
          if (!liveIds.has(id)) channelDelivering.delete(id);
      }
    } catch (err) {
      console.error("status events tick failed:", err);
    } finally {
      statusTickBusy = false;
    }
  }, 2500);

  // ── budget enforcement (opt-in via STOA_BUDGET_SOFT_USD / _HARD_USD) ──
  // OFF by default → no interval, zero overhead. When armed: every 30s estimate
  // each session's cost and, on a NEW crossing, Web Push (soft) or push-then-KILL
  // (hard). The kill stops the pty (the burn) but leaves the DB row so the board
  // shows it was budget-stopped and it can be relaunched. Push is dispatched
  // before the kill so it's never a silent surprise. Decision logic is pure + tested.
  const budgetCfg = getBudgetConfig();
  if (budgetEnabled(budgetCfg)) {
    console.log(
      `> Budget caps on (USD/session): soft=${budgetCfg.softUsd ?? "—"} hard=${budgetCfg.hardUsd ?? "—"}`
    );
    if (
      budgetCfg.softUsd !== null &&
      budgetCfg.hardUsd !== null &&
      budgetCfg.softUsd >= budgetCfg.hardUsd
    ) {
      console.warn(
        `> Budget: soft ($${budgetCfg.softUsd}) >= hard ($${budgetCfg.hardUsd}) — sessions jump straight to the hard kill with no soft warning.`
      );
    }
    let lastBudgetLevels = new Map<string, BudgetLevel>();
    // Always-armed while a cap is configured: keep the event loop open (no unref)
    // as the original inline setInterval did. The busy-guard (transcript reads can
    // run slow) now lives in makeGuardedInterval.
    makeGuardedInterval({
      intervalMs: 30000,
      unref: false,
      onError: (err) => console.error("budget tick failed:", err),
      tick: async () => {
        const sessions = queries.getAllSessions(getDb()).all() as Session[];
        const costs = await computeSessionCosts(sessions);
        const lite = Object.entries(costs).map(([id, c]) => ({
          id,
          costUsd: c.costUsd,
        }));
        const { notify, kill } = detectBudgetBreaches(
          lastBudgetLevels,
          lite,
          budgetCfg
        );
        const nextLevels = snapshotBudgetLevels(lite, budgetCfg);

        for (const b of notify) {
          const name = sanitizeNotificationText(costs[b.id]?.name ?? b.id, {
            fallback: b.id,
          });
          const body =
            b.level === "hard"
              ? `${name} hit the $${budgetCfg.hardUsd} cap - stopping it`
              : `${name} crossed $${budgetCfg.softUsd} (now $${b.costUsd.toFixed(2)})`;
          // Fire-and-forget: never await push I/O inside the tick, or a slow/hung
          // endpoint would hold the tick's busy-guard and delay the kill below.
          void sendPushToAll({
            title: "Stoa budget",
            body,
            tag: `budget-${b.id}-${b.level}`,
            url: "/",
            // #52: carry the session so a muted session's budget push is suppressed
            // too; needs-you kind so the SW shows it loud (subject to quiet hours).
            sessionId: b.id,
            kind: "error",
          }).catch((err) => console.error("budget push failed:", err));
        }
        // Kill breached sessions CONCURRENTLY — a slow daemon kill must not
        // serialize behind each other and delay stopping the other sessions'
        // burn. Each kill catches independently; a failure keeps that session at
        // its prior level so the next tick retries it.
        await Promise.all(
          kill.map(async (id) => {
            const s = sessions.find((x) => x.id === id);
            if (!s) return;
            try {
              await getSessionBackend().kill(backendKeyForSession(s));
            } catch (err) {
              console.error("budget kill failed:", err);
              nextLevels.set(id, lastBudgetLevels.get(id) ?? "soft");
            }
          })
        );
        lastBudgetLevels = nextLevels;
      },
    });
  }

  // ── #21 per-session budgets (always armed; near-free when none configured) ──
  // A session with budget_usd set gets ONE push at 80% and ONE at 100% of its
  // cap (edge-triggered), and — with STOA_BUDGET_PARK=1 — is PARKED at the cap:
  // the prompt queue / auto-resume / channel delivery stop feeding it work
  // (fail-closed), but nothing is killed and the user can still type. Distinct
  // from the global STOA_BUDGET_* enforcement above (that kill is final).
  {
    // Always armed (near-free when no session has a budget). The busy-guard +
    // .unref() + the run-once-at-startup are all handled by makeGuardedInterval;
    // the tick body is unchanged (an early `return` on the empty case still
    // resets the guard via the helper's finally).
    makeGuardedInterval({
      intervalMs: 30000,
      // Run once at startup: the park/stage state is in-memory, so a restart
      // would otherwise leave a capped session unparked (and its badge blank)
      // for a full 30s window before the first tick re-parks it.
      runAtStartup: true,
      onError: (err) => console.error("session budget tick failed:", err),
      tick: async () => {
        const sessions = queries.getAllSessions(getDb()).all() as Session[];
        pruneBudgetState(new Set(sessions.map((s) => s.id)));
        const budgeted = sessions.filter(
          (s) => s.budget_usd != null && s.budget_usd > 0
        );
        // Skip transcript reads when unused — but carried park/stage state must
        // still flow through decide (a parked session whose budget was CLEARED
        // is only unparked by its now-"ok" stage), so only bail when both the
        // budgets and the state are empty.
        if (
          budgeted.length === 0 &&
          currentParked().size === 0 &&
          currentBudgetStages().size === 0
        ) {
          return;
        }
        const costs =
          budgeted.length > 0 ? await computeSessionCosts(budgeted) : {};
        const decision = decideBudgetActions({
          sessions, // the WHOLE fleet: a cleared budget unparks via "ok"
          costs,
          prevStages: currentBudgetStages(),
          parked: currentParked(),
          parkEnabled: budgetParkEnabled(),
        });
        for (const a of decision.alert80) {
          const name = sanitizeNotificationText(a.name, { fallback: a.id });
          void sendPushToAll({
            title: "Stoa budget",
            body: `${name} is at 80% of its $${a.budgetUsd} budget (now $${a.costUsd.toFixed(2)})`,
            tag: `budget-${a.id}-80`,
            url: "/",
            sessionId: a.id, // #52 mute/quiet gate
            kind: "error",
          }).catch((err) => console.error("budget push failed:", err));
        }
        for (const a of decision.alert100) {
          const name = sanitizeNotificationText(a.name, { fallback: a.id });
          const parkedNote =
            budgetParkEnabled() && decision.park.includes(a.id)
              ? " — parked (no new work will be fed)"
              : "";
          void sendPushToAll({
            title: "Stoa budget",
            body: `${name} hit its $${a.budgetUsd} budget (now $${a.costUsd.toFixed(2)})${parkedNote}`,
            tag: `budget-${a.id}-100`,
            url: "/",
            sessionId: a.id, // #52 mute/quiet gate
            kind: "error",
          }).catch((err) => console.error("budget push failed:", err));
        }
        applyBudgetDecision(decision);
      },
    });
  }

  // ── dispatch reconciler (GitHub issue → agent fleet) ──
  // Always armed but cheap when idle: the tick early-returns per repo and only
  // does real work for ENABLED repos (auto-dispatch) or in-flight rows (PR
  // polling). reconcileTick has its own busy guard. 60s cadence tolerates the
  // blocking gh calls (issue list + pr list) it makes.
  // Fire-and-forget (reconcileTick owns its own busy guard): the tick returns
  // synchronously so makeGuardedInterval's guard never latches — behavior-
  // identical to the old `void reconcileTick()`, just with the shared .unref().
  makeGuardedInterval({
    intervalMs: 60000,
    tick: () => {
      void reconcileTick();
    },
  });

  // ── scheduler (fire a prompt into a session on a cadence) ──
  // Always armed but cheap when idle: one indexed "due schedules" query that
  // returns nothing unless the user (or an agent) created a schedule whose time
  // has come — so a fresh install with no schedules behaves identically (the
  // schedule itself is the opt-in, like a Dispatch recurring task). When a
  // schedule is due we ENQUEUE its prompt into the target session's prompt queue;
  // the status ticker above then delivers it at the next idle turn boundary — the
  // SAME safe path a typed-ahead prompt uses, so the scheduler adds no new
  // injection surface. Fully synchronous (DB + in-memory queue), so a sync tick
  // can't re-enter; the try/catch keeps one bad row from killing the interval.
  // Fully synchronous (DB + in-memory queue), so the busy-guard never latches;
  // the tick keeps its own top-level + per-row try/catch (one bad row must not
  // abort the rest), so no onError is needed here.
  makeGuardedInterval({
    intervalMs: 30000,
    tick: () => {
      const now = Date.now();
      let due;
      try {
        due = dueSchedules(now);
      } catch (err) {
        console.error("scheduler tick: due query failed:", err);
        return;
      }
      for (const row of due) {
        // Per-row try/catch: one bad row (e.g. a transient DB write error) must
        // not abort the rest, and a failed fire leaves the row "due" to retry.
        try {
          // Coalesce a still-pending duplicate: don't pile a recurring schedule's
          // prompt onto a session that hasn't drained the last one yet.
          const outcome = fireSchedule(row, now, enqueuePrompt, (id, p) =>
            listQueue(id).includes(p)
          );
          console.log(
            outcome === "session-gone"
              ? `scheduler: target session ${row.session_id} gone — disabled schedule ${row.id}`
              : outcome === "skipped-queued"
                ? `scheduler: prompt already queued for session ${row.session_id} — skipped duplicate (schedule ${row.id})`
                : `scheduler: enqueued scheduled prompt for session ${row.session_id} (schedule ${row.id})`
          );
        } catch (err) {
          console.error(`scheduler: schedule ${row.id} failed:`, err);
        }
      }
    },
  });

  // ── cost sampler (opt-in: persist the spend history unattended) ──
  // Off unless STOA_AUTO_COST_SAMPLE=1. Computes per-session cost (bounded
  // transcript reads) and upserts today's samples into session_costs — idempotent
  // per (session, UTC day), so a missed or extra tick can't double-count. The
  // busy guard skips a tick whose predecessor's reads are still running; the
  // shouldSampleCost gate makes the cadence interval-driven (not the raw timer
  // period) so it survives a future timer-period change.
  // The busy-guard + .unref() now live in makeGuardedInterval (enabled by the
  // flag → armed only when COST_SAMPLE_ENABLED). The cadence gate still lives in
  // the tick: shouldSampleCost early-returns synchronously (before any await) so
  // the guard never latches on a cadence-skip — behavior-identical.
  makeGuardedInterval({
    intervalMs: 60000,
    enabled: COST_SAMPLE_ENABLED,
    onError: (err) => console.error("cost sampler tick failed:", err),
    tick: async () => {
      const now = Date.now();
      if (!shouldSampleCost(now, lastCostSampleMs)) return;
      // Advance the cadence clock up front so a PERSISTENT failure backs off to the
      // sample interval instead of retrying (and re-reading transcripts) every 60s.
      lastCostSampleMs = now;
      const sessions = queries.getAllSessions(getDb()).all() as Session[];
      const costs = await computeSessionCosts(sessions);
      const written = persistCostSamples(getDb(), sessions, costs, now);
      if (written > 0)
        console.log(`cost sampler: persisted ${written} sample(s)`);
    },
  });

  // ── auto-/compact (opt-in: reclaim context before the wall) ──
  // Off unless STOA_AUTO_COMPACT=1. Every 60s, compute each session's context occupancy
  // (the same bounded transcript read the cost sampler uses); for a Claude session over the
  // threshold and past its cooldown, capture + classify ONLY that candidate and, if it's at
  // a clean idle boundary, send /compact via the backend. Fail-closed: a backend/list/cost
  // failure skips the tick; a per-session capture error skips that session. All backend ops
  // key on backendKeyForSession(s) (the tmux_name / pty key), not the display name.
  // The busy-guard + .unref() now live in makeGuardedInterval (armed only when
  // AUTO_COMPACT_ENABLED). The tick body is otherwise unchanged — its inner
  // early-returns (list failure, per-session skips) still work under the helper's
  // finally, and the outer try/catch collapses into makeGuardedInterval's onError.
  makeGuardedInterval({
    intervalMs: 60000,
    enabled: AUTO_COMPACT_ENABLED,
    onError: (err) => console.error("auto-compact tick failed:", err),
    tick: async () => {
      const nowMs = Date.now();
      const sessions = queries.getAllSessions(getDb()).all() as Session[];
      const backend = getSessionBackend();
      let liveNames: Set<string>;
      try {
        liveNames = new Set(await backend.list());
      } catch {
        return; // can't enumerate live sessions → skip this tick
      }
      const costs = await computeSessionCosts(sessions);
      for (const s of sessions) {
        if (s.agent_type !== "claude") continue; // /compact is a Claude command
        const key = backendKeyForSession(s);
        if (!liveNames.has(key)) continue;
        const cost = costs[s.id];
        if (!cost) continue;
        const pct = tokenMeter(
          cost.contextTokens,
          cost.contextWindow && cost.contextWindow > 0
            ? cost.contextWindow
            : contextWindowFor(cost.model ?? s.model)
        ).pct;
        // #25: a session awaiting its post-compact pointer is handled first
        // and never starts another compaction this tick. The pre-check runs
        // with an OPTIMISTIC boundary (isIdle:true / hasPrompt:false) so the
        // costly capture is skipped whenever time or the context-drop
        // completion signal alone would reject; when it passes, the capture
        // runs and the second decision corrects those optimistic values.
        const pendingSince = compactReinject.get(s.id);
        if (pendingSince != null) {
          const pre = nextReinjectAction({
            pendingSinceMs: pendingSince,
            nowMs,
            isIdle: true,
            hasPrompt: false,
            contextPct: pct,
            threshold: COMPACT_THRESHOLD,
          });
          if (pre === "expire") {
            compactReinject.delete(s.id);
          } else if (pre === "inject" && !isBudgetParked(s.id)) {
            const detail = await statusDetector
              .getStatusDetail(key)
              .catch(() => null);
            if (
              detail &&
              nextReinjectAction({
                pendingSinceMs: pendingSince,
                nowMs,
                isIdle: detail.status === "idle",
                hasPrompt: detail.prompt != null,
                contextPct: pct,
                threshold: COMPACT_THRESHOLD,
              }) === "inject"
            ) {
              compactReinject.delete(s.id);
              console.log(
                `auto-compact: ${s.name} compaction landed → inject ${COMPACT_MEMORY_FILE} pointer`
              );
              await backend
                .pasteText(key, buildReinjectMessage(), { enter: true })
                .catch((err) =>
                  console.error("auto-compact re-inject failed:", err)
                );
            }
          }
          continue;
        }
        // Cheap pre-checks before paying for a screen capture + classify.
        if (pct < COMPACT_THRESHOLD) continue;
        const last = lastCompactAt.get(s.id) ?? null;
        if (last != null && nowMs - last < COMPACT_COOLDOWN_MS) continue;
        // Only NOW capture + classify this candidate (bounded to over-threshold
        // sessions). getStatusDetail (not getStatus) also yields the detected prompt, so
        // we honor the canonical idle-AND-no-prompt unattended-write gate.
        const detail = await statusDetector
          .getStatusDetail(key)
          .catch(() => null);
        if (!detail) continue; // capture failed → leave this session for the next tick
        const today = utcDay(nowMs);
        const dayRec = compactDay.get(s.id);
        const usedToday = dayRec && dayRec.day === today ? dayRec.count : 0;
        const action = nextCompactAction({
          contextPct: pct,
          threshold: COMPACT_THRESHOLD,
          isIdle: detail.status === "idle",
          hasPrompt: detail.prompt != null,
          compactionsUsedToday: usedToday,
          maxPerDay: COMPACT_MAX_PER_DAY,
          lastCompactMs: last,
          cooldownMs: COMPACT_COOLDOWN_MS,
          nowMs,
        });
        if (action !== "compact") continue;
        lastCompactAt.set(s.id, nowMs);
        compactDay.set(s.id, { day: today, count: usedToday + 1 });
        // #25: flush the recent conversation tail to disk BEFORE compaction
        // destroys the detail. Deterministic (no LLM call); a flush failure
        // is logged and never blocks the compaction itself. The reinject is
        // armed only when the file actually landed.
        if (compactMemoryEnabled() && s.working_directory) {
          try {
            const raw = s.claude_session_id
              ? await readClaudeTranscriptRaw(
                  s.working_directory,
                  s.claude_session_id
                )
              : null;
            if (raw != null) {
              const memoryPath = joinNativePath(
                s.working_directory,
                COMPACT_MEMORY_FILE
              );
              await mkdir(nativeDirname(memoryPath), { recursive: true });
              await writeFile(
                memoryPath,
                buildCompactMemoryMarkdown({
                  sessionName: s.name,
                  model: cost.model ?? s.model,
                  contextPct: pct,
                  nowIso: new Date(nowMs).toISOString(),
                  entries: extractTranscriptEntries(raw),
                }),
                "utf8"
              );
              compactReinject.set(s.id, nowMs);
            }
          } catch (err) {
            console.error(
              "auto-compact: memory flush failed (compacting anyway):",
              err
            );
          }
        }
        const compactCommand = buildCompactCommand(customCompactPrompt());
        console.log(
          `auto-compact: ${s.name} context ~${Math.round(pct * 100)}% at idle → ${compactCommand === "/compact" ? "/compact" : "/compact (custom prompt)"} (${usedToday + 1}/${COMPACT_MAX_PER_DAY || "∞"} today)`
        );
        await backend
          .pasteText(key, compactCommand, { enter: true })
          .catch((err) => console.error("auto-compact send failed:", err));
      }
      // Prune the per-session trackers for sessions that no longer exist.
      const liveIds = new Set(sessions.map((s) => s.id));
      for (const id of [...lastCompactAt.keys()])
        if (!liveIds.has(id)) lastCompactAt.delete(id);
      for (const id of [...compactDay.keys()])
        if (!liveIds.has(id)) compactDay.delete(id);
      for (const id of [...compactReinject.keys()])
        if (!liveIds.has(id)) compactReinject.delete(id);
    },
  });

  // ── tmux mode (legacy): one shell pty per socket, killed on disconnect ──
  function handleTmuxConnection(ws: WebSocket) {
    let ptyProcess: pty.IPty;
    // Last size pushed to the shell pty (spawned at 80×24 below). A resize to the
    // SAME dimensions still raises SIGWINCH, which makes tmux + the agent TUI
    // repaint — flooding output and burying fresh keystrokes. Android's soft
    // keyboard fires visualViewport `resize` repeatedly while typing (re-sending an
    // identical size each time), so dedupe here too — the PtySession path has the
    // same guard. Keeps the POSIX tmux experience snappy under mobile typing (#116).
    let ptyCols = 80;
    let ptyRows = 24;
    try {
      // This connection only runs under the macOS/Linux tmux backend (Windows is
      // always pty), but use the platform helpers anyway so there are no hardcoded
      // /bin paths or process.env.HOME reads (AGENTS.md).
      const shell = defaultInteractiveShell();
      const home = homeDir();
      // Use minimal env - only essentials for shell to work
      // This lets Next.js/Vite/etc load .env.local without interference from parent process env
      const minimalEnv: { [key: string]: string } = {
        PATH: process.env.PATH || "",
        HOME: home,
        USER: process.env.USER || "",
        SHELL: shell,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "en_US.UTF-8",
      };

      ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: home,
        env: minimalEnv,
      });
    } catch (err) {
      console.error("Failed to spawn pty:", err);
      ws.send(
        JSON.stringify({ type: "error", message: "Failed to start terminal" })
      );
      ws.close();
      return;
    }

    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        switch (msg.type) {
          case "input":
            ptyProcess.write(msg.data);
            break;
          case "resize":
            // Skip a no-op resize (see ptyCols/ptyRows) — it would re-SIGWINCH the
            // shell and stall typing for no layout change.
            if (msg.cols !== ptyCols || msg.rows !== ptyRows) {
              ptyProcess.resize(msg.cols, msg.rows);
              ptyCols = msg.cols;
              ptyRows = msg.rows;
            }
            break;
          case "command":
            ptyProcess.write(msg.data + "\r");
            break;
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    });

    ws.on("close", () => {
      ptyProcess.kill();
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      ptyProcess.kill();
    });
  }

  // ── pty mode (native): subscribe a socket to a session via a transport ──
  // One handler for both Tier 1 (in-process registry) and Tier 2 (host daemon);
  // the PtyTransport hides which. attachStream gives a snapshot + per-client
  // resize/detach handle; we repaint then stream, with no await between the
  // snapshot and listener registration so no live bytes are dropped/dup'd.
  function handlePtyTerminal(ws: WebSocket, transport: PtyTransport) {
    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    // The attach state machine (incl. the sequence guard that stops a racing
    // re-attach from double-subscribing) lives in AttachSession; this handler
    // just maps WebSocket frames onto it.
    const session = new AttachSession(transport, {
      output: (data) => send({ type: "output", data }),
      exit: (code) => send({ type: "exit", code }),
      error: (message) => send({ type: "error", message }),
      reset: () => send({ type: "reset" }),
    });

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        switch (msg.type) {
          case "attach":
            void session.attach(msg.key, msg.spawn, msg.observer);
            break;
          case "input":
            session.write(msg.data);
            break;
          case "command":
            session.write(msg.data + "\r");
            break;
          case "resize":
            session.resize(msg.cols, msg.rows);
            break;
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    });

    // Disconnect detaches this client but leaves the session running.
    ws.on("close", () => session.detach());
    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      session.detach();
    });
  }

  // Finalize the pty-host (Tier 2) decision ONCE, before accepting connections,
  // so the terminal path and the API/status path (getSessionBackend) agree. If
  // the daemon can't be reached we disable host mode globally and fall back to
  // the in-process registry (Tier 1) — terminals still work, just without
  // restart-survival. getSessionBackend() is lazy, so flipping the env here
  // (before its first call) makes the whole process consistently Tier 1.
  (async () => {
    if (usePtyHost()) {
      try {
        await getHostClient().ensureReady();
        console.log(
          "> pty-host daemon ready (Tier 2: sessions survive server restarts)"
        );
      } catch (err) {
        process.env.STOA_PTY_HOST = "0";
        resetSessionBackend(); // re-resolve to Tier 1 even if already cached
        console.error(
          "> pty-host daemon unreachable; using in-process sessions (Tier 1):",
          err instanceof Error ? err.message : err
        );
      }
    }
    // Dispatch startup catch-up: free slots held by workers that didn't survive
    // a Tier-1 restart, then run one reconcile pass immediately so a day missed
    // while Stoa was down is topped up now (not only on the next 60s tick).
    void evictStaleWarmPool().catch((err) =>
      console.error("warm-pool: stale eviction failed:", err)
    );
    void reconcileOrphans()
      .then(() => reconcileTick())
      .catch((err) => console.error("dispatch startup reconcile failed:", err));
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[stoa] Port ${port} is already in use. Stop the other server, then start again.`
        );
      } else {
        console.error("[stoa] Fatal server error:", err);
      }
      process.exit(1);
    });
    server.listen(port, hostname, () => {
      console.log(`> Stoa ready on http://${hostname}:${port}`);
      if (AUTH_ENABLED) {
        console.log(
          `> Auth on${TRUST_LOOPBACK ? " (localhost trusted)" : " (token required everywhere)"}. Remote access:`
        );
        console.log(`>   http://<this-host>:${port}/?token=${SERVER_TOKEN}`);
        if (TRUST_TAILSCALE)
          console.log(
            `>   Tailscale range (100.64.0.0/10) is trusted — no token over the tailnet.`
          );
        console.log(
          `>   STOA_AUTH=off disables it; STOA_REQUIRE_AUTH=1 requires it on localhost too.`
        );
      } else {
        console.log(
          "> Auth DISABLED (STOA_AUTH=off) — anyone who can reach this port has full access."
        );
      }
    });
  })();
});
