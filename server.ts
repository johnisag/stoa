import "./lib/load-env"; // FIRST: load a cwd .env so `npm run dev` honours it
import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import {
  getBackendType,
  usePtyHost,
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
import { actionsForKind } from "./lib/notification-actions";
import { sanitizeNotificationText } from "./lib/notification-text";
import { captureSnapshot } from "./lib/snapshots";
import { peekPrompt, dequeuePrompt, hasAnyQueued } from "./lib/prompt-queue";
import {
  nextRateLimitAction,
  autoResumeEnabled,
  RESUME_MAX_PER_DAY,
  RESUME_FALLBACK_MS,
} from "./lib/rate-limit";
import { utcDay } from "./lib/utc-day";
import {
  nextAutoAnswerAction,
  autoAnswerEnabled,
  promptSignature,
  shouldRearmAutoAnswer,
  shouldAcknowledgeQueued,
} from "./lib/auto-steer";
import {
  nextErrorLoopAction,
  errorLoopEnabled,
  buildLoopPushBody,
  normalizeErrorSig,
  ERROR_LOOP_THRESHOLD,
  ERROR_LOOP_WINDOW_MS,
  type LoopTrack,
} from "./lib/error-loop";
import {
  nextStuckAction,
  watchdogEnabled,
  buildStuckPushBody,
  WATCHDOG_STUCK_MS,
  WATCHDOG_MAX_GAP_MS,
  type StuckTrack,
} from "./lib/watchdog";
import {
  channelDeliverEnabled,
  isChannelDeliveryTurn,
  buildChannelDeliveryText,
} from "./lib/channel-delivery";
import { nextUnreadMessage, markDelivered } from "./lib/channels";
import { computeSessionCosts } from "./lib/session-cost";
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
import { homeDir, defaultInteractiveShell } from "./lib/platform";
import { getDb, queries, type Session } from "./lib/db";
import { REMOTE_ADDR_HEADER } from "./lib/api-security";
import { statusDetector, type SessionStatus } from "./lib/status-detector";
import {
  getServerToken,
  trustLoopback,
  trustTailscale,
  configuredAllowedOrigins,
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

      if (AUTH_ENABLED) {
        const decision = decideHttpAuth({
          serverToken: SERVER_TOKEN,
          remoteAddr: req.socket.remoteAddress,
          trustLoopback: TRUST_LOOPBACK,
          trustTailscale: TRUST_TAILSCALE,
          authHeader: req.headers.authorization,
          cookieHeader: req.headers.cookie,
          queryToken: firstQueryValue(parsedUrl.query.token),
        });
        if (decision.type === "deny") {
          res.statusCode = 401;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(AUTH_REQUIRED_HTML);
          return;
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
      allowedOrigins: ALLOWED_ORIGINS,
      remoteAddr: request.socket.remoteAddress,
      trustLoopback: TRUST_LOOPBACK,
      trustTailscale: TRUST_TAILSCALE,
      authHeader: request.headers.authorization,
      cookieHeader: request.headers.cookie,
      queryToken: firstQueryValue(query.token),
    });
    if (decision.type === "deny") {
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n${decision.reason}`
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
    const transport: PtyTransport = usePtyHost()
      ? new HostTransport()
      : new LocalTransport();
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
  // Opt-in per-turn working-tree snapshots (refs/stoa/snap/*). Off by default —
  // it writes shadow commits to the session's repo. Tracks prev status so we
  // snapshot only on a running→settled turn boundary.
  const SNAPSHOTS_ENABLED = process.env.STOA_SNAPSHOTS === "1";
  let lastSnapStatusById = new Map<string, SessionStatus>();
  // Sessions with a queued prompt already sent this idle period (cleared when the
  // session next goes non-idle) — so one prompt dispatches per idle, not per tick.
  const queueDispatched = new Set<string>();
  // Rate-limit auto-resume (opt-in via STOA_AUTO_RESUME=1; detection is always
  // on). Tracks sessions we've already nudged once per rate-limited episode, so
  // we resume exactly once at reset — not every 2.5s tick — and clear it when the
  // session is no longer rate-limited (next episode can resume again).
  const AUTO_RESUME_ENABLED = autoResumeEnabled();
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
  const AUTO_ANSWER_ENABLED = autoAnswerEnabled();
  const autoAnswered = new Map<string, string>();
  if (AUTO_ANSWER_ENABLED) {
    console.log(
      "> Auto-answer on (STOA_AUTO_ANSWER=1): Enter accepts a routine prompt ONLY when it takes the highlighted single-shot Yes (or an explicit Press-Enter / [Y/n] default); blanket-permission, default-No, and destructive-looking prompts are left for you (and still pushed)."
    );
  }
  // Auto-steer: error-loop escalation (opt-in via STOA_ERROR_LOOP=1). Tracks each
  // session's persisting error signature so we PAGE ONCE per distinct error when it
  // sticks for >= the threshold ticks AND >= the elapsed window — the terminal is
  // never written to, so a false positive costs only one extra notification.
  const ERROR_LOOP_ENABLED = errorLoopEnabled();
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
  const WATCHDOG_ENABLED = watchdogEnabled();
  const stuckSessions = new Map<string, StuckTrack>();
  if (WATCHDOG_ENABLED) {
    console.log(
      `> Watchdog on (STOA_AUTO_WATCHDOG=1): a session stuck "running" continuously for ~${Math.round(WATCHDOG_STUCK_MS / 60000)}m gets ONE "may be stuck" push, then it's left for you. The terminal is never written to.`
    );
  }
  // Inter-agent channel PUSH delivery (opt-in via STOA_AUTO_CHANNEL_DELIVER=1).
  // Channels are always readable via the channel_* MCP tools (pull); this only
  // adds the unattended INJECTION of one unread message into a recipient's
  // terminal at a clean turn boundary — off by default, since writing into a
  // session is the risky part (same stance as auto-resume). `channelDelivering`
  // keeps one delivery in flight per session so a slow paste can't double-send.
  const CHANNEL_DELIVER_ENABLED = channelDeliverEnabled();
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
      tag: `${ev.id}-${ev.kind}`,
      url: "/",
      // Lock-screen action buttons → /api/sessions/[id]/respond (send-keys/kill).
      sessionId: ev.id,
      actions: actionsForKind(ev.kind),
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
    // When auto-resume is armed, keep the ticker running with no UI/push/queue:
    // a rate-limited session resumes itself only if we keep capturing screens.
    if (
      !wsListening &&
      !pushEnabled &&
      !SNAPSHOTS_ENABLED &&
      !queuesPending &&
      !AUTO_RESUME_ENABLED &&
      !AUTO_ANSWER_ENABLED &&
      !ERROR_LOOP_ENABLED &&
      !WATCHDOG_ENABLED &&
      !CHANNEL_DELIVER_ENABLED
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
              | Session
              | undefined;
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
      for (const s of curr) {
        const next = peekPrompt(s.id);
        if (
          next == null ||
          s.status === "running" ||
          s.status === "error" ||
          s.status === "dead"
        ) {
          queueDispatched.delete(s.id);
          continue;
        }
        if (s.status === "waiting") {
          // Promote a SETTLED turn to "idle" next tick so its queued task can
          // dispatch — but NOT when a real prompt is detected. Acknowledging a
          // borderline permission dialog (one that intermittently fails the
          // waiting-pattern check) would flip it to "idle" and paste the queued
          // task straight into the open prompt. Leave a prompt for the human.
          if (shouldAcknowledgeQueued(s.status, !!s.prompt)) {
            statusDetector.acknowledge(s.name);
          }
          continue;
        }
        // idle → ready for the next instruction.
        if (queueDispatched.has(s.id)) continue;
        queueDispatched.add(s.id);
        void getSessionBackend()
          .pasteText(s.name, next, { enter: true })
          .then(() => {
            dequeuePrompt(s.id);
          })
          .catch((err) => {
            queueDispatched.delete(s.id); // let the next tick retry
            console.error("queue dispatch failed:", err);
          });
      }

      // Rate-limit auto-resume (opt-in). Detection rides on the same capture
      // (s.rateLimit) and is always surfaced; the unattended NUDGE is gated by
      // STOA_AUTO_RESUME=1 — injecting input into a session unattended is the
      // risky part, so it's off by default (mirrors the budget caps). For each
      // session, the pure nextRateLimitAction decides wait/resume/idle from the
      // detected state + reset time; we act only on "resume" (reset has passed)
      // and only once per episode. Clear the once-guard the moment a session is
      // no longer rate-limited so a later limit can resume again.
      const rlNowMs = Date.now();
      const resumeDay = utcDay(rlNowMs);
      for (const s of curr) {
        if (!s.rateLimit) {
          rateLimitResumed.delete(s.id);
          rateLimitParkedAt.delete(s.id);
          rateLimitBudgetLogged.delete(s.id);
          continue;
        }
        // A "rate limit exceeded" line can ALSO classify the session as `error`
        // (the patterns overlap). Never nudge an errored/dead session — that's not
        // a recoverable count-down-and-resume wait.
        if (s.status === "error" || s.status === "dead") {
          rateLimitResumed.delete(s.id);
          rateLimitParkedAt.delete(s.id);
          rateLimitBudgetLogged.delete(s.id);
          continue;
        }
        // Anchor the no-reset fallback at the moment the limit was first seen.
        if (!rateLimitParkedAt.has(s.id)) rateLimitParkedAt.set(s.id, rlNowMs);
        if (!AUTO_RESUME_ENABLED || rateLimitResumed.has(s.id)) continue;
        // Per-day resume budget: roll the counter over when the UTC day changes.
        let budget = rateLimitResumeDay.get(s.id);
        if (!budget || budget.day !== resumeDay) {
          budget = { day: resumeDay, count: 0 };
          rateLimitResumeDay.set(s.id, budget);
          rateLimitBudgetLogged.delete(s.id); // a fresh day may log again
        }
        const action = nextRateLimitAction({
          detected: true,
          resetAtMs: s.rateLimit.resetAt,
          nowMs: rlNowMs,
          // Never nudge a session that's showing a real prompt — the resume Enter /
          // queued task would answer the open dialog instead of re-triggering the
          // counted-down turn. Wait until the prompt clears.
          hasPrompt: !!s.prompt,
          // Don't nudge a session that's actively working (a spinner) — it isn't
          // idly parked at the limit, so injecting Enter would hit a live turn.
          busy: s.status === "running",
          parkedAtMs: rateLimitParkedAt.get(s.id) ?? null,
          fallbackMs: RESUME_FALLBACK_MS,
          resumesUsedToday: budget.count,
          maxPerDay: RESUME_MAX_PER_DAY,
        });
        if (action !== "resume") {
          // If the day's budget is what's holding us back — and not some other
          // guard (busy / a real prompt), which would make "until tomorrow"
          // misleading — say so ONCE.
          if (
            RESUME_MAX_PER_DAY > 0 &&
            budget.count >= RESUME_MAX_PER_DAY &&
            s.status !== "running" &&
            !s.prompt &&
            !rateLimitBudgetLogged.has(s.id)
          ) {
            rateLimitBudgetLogged.add(s.id);
            console.log(
              `rate-limit auto-resume: daily budget (${RESUME_MAX_PER_DAY}) spent for ${s.name} — holding until tomorrow.`
            );
          }
          continue; // still counting down / prompt up / busy / budget spent / no reset
        }
        // If the queue loop above already sent this session's queued prompt this
        // idle period, that IS the resume — don't also nudge (would double-send).
        if (queueDispatched.has(s.id)) {
          rateLimitResumed.add(s.id);
          budget.count++; // the queue loop's delivered send counts against the cap
          continue;
        }
        // A queued prompt is the natural resume payload; otherwise nudge with a
        // bare Enter to re-trigger the agent's pending turn. Guard once-per-
        // episode BEFORE the async send so a slow send can't double-fire; charge
        // the daily budget only on a DELIVERED nudge (in .then), so a failed send
        // that retries next tick doesn't burn a resume.
        rateLimitResumed.add(s.id);
        const queued = peekPrompt(s.id);
        const backend = getSessionBackend();
        const send = queued
          ? backend.pasteText(s.name, queued, { enter: true })
          : backend.sendEnter(s.name);
        void send
          .then(() => {
            budget.count++;
            if (queued) dequeuePrompt(s.id);
          })
          .catch((err) => {
            rateLimitResumed.delete(s.id); // let the next tick retry
            console.error("rate-limit resume failed:", err);
          });
      }

      // Auto-steer: policy auto-answer (opt-in). Detection (s.prompt) rides on the
      // same capture and is always surfaced; the unattended Enter is gated by
      // STOA_AUTO_ANSWER=1 — pressing a key into a session is the risky part, so
      // it's off by default. The pure nextAutoAnswerAction decides answer/escalate/
      // idle; we ONLY send Enter on "answer" (a routine prompt whose default is the
      // safe affirmative) and ONLY once per distinct prompt line, so a slow agent
      // can't get the same Enter spammed every 2.5s. A rate-limited session is
      // handled by the loop above, never here (its prompt, if any, isn't routine).
      if (AUTO_ANSWER_ENABLED) {
        for (const s of curr) {
          // Don't answer unless actively waiting on a prompt and not rate-limited
          // (the resume loop owns the rate-limited case).
          if (!s.prompt || s.rateLimit || s.status !== "waiting") {
            // Re-arm the once-per-prompt guard ONLY when the turn truly settled
            // (idle/dead) — NOT on a transient "running"/spinner flap, which would
            // clear the guard and let the SAME prompt be answered a second time
            // when it re-reads as "waiting" next tick. The guard is keyed by the
            // prompt signature, so a genuinely NEW prompt is still answered.
            if (shouldRearmAutoAnswer(s.status)) autoAnswered.delete(s.id);
            continue;
          }
          const action = nextAutoAnswerAction({
            prompt: s.prompt,
            status: s.status,
          });
          if (action !== "answer") continue; // escalate / idle → leave it waiting
          // Once per DISTINCT prompt (stable signature: a countdown can't re-trigger).
          const sig = promptSignature(s.prompt);
          if (autoAnswered.get(s.id) === sig) continue;
          // Guard BEFORE the async send so a slow send can't double-fire.
          autoAnswered.set(s.id, sig);
          console.log(
            `auto-answer: accepted ${s.prompt.kind} prompt in ${s.name} (${s.prompt.line})`
          );
          void getSessionBackend()
            .sendEnter(s.name)
            .catch((err) => {
              autoAnswered.delete(s.id); // let the next tick retry
              console.error("auto-answer failed:", err);
            });
        }
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
            tag: `${s.id}-loop`,
            url: "/",
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
            tag: `${s.id}-stuck`,
            url: "/",
            sessionId: s.id,
            actions: actionsForKind("error"),
          }).catch((err) => console.error("watchdog push failed:", err));
        }
        for (const id of [...stuckSessions.keys()])
          if (!liveIds.has(id)) stuckSessions.delete(id);
      }

      // Inter-agent channel delivery (opt-in via STOA_AUTO_CHANNEL_DELIVER=1).
      // Channels are always pull-readable (channel_inbox); this only adds the
      // unattended PUSH — injecting one unread message into the recipient's
      // terminal at a clean turn boundary so a sibling doesn't have to poll.
      // Mirrors the prompt-queue dispatch: gate on a settled, ready session (the
      // pure isChannelDeliveryTurn), deliver the single oldest unread with a
      // directive "from another agent" wrapper, mark it delivered on a successful
      // paste. One delivery in flight per session (channelDelivering) so a slow
      // paste can't double-send; the once-guard clears on success/failure so the
      // NEXT unread is delivered on a later tick (one message at a time).
      if (CHANNEL_DELIVER_ENABLED) {
        for (const s of curr) {
          if (channelDelivering.has(s.id)) continue;
          // If the prompt-queue loop above already pasted this session's queued
          // task this idle period, don't ALSO inject a channel message — both
          // fire on "idle" off the same snapshot, so two pastes would interleave
          // in one terminal. Wait for the next idle tick (mirrors the rate-limit
          // resume loop's queueDispatched guard).
          if (queueDispatched.has(s.id)) continue;
          if (
            !isChannelDeliveryTurn({ status: s.status, hasPrompt: !!s.prompt })
          )
            continue;
          const msg = nextUnreadMessage(s.id);
          if (!msg) continue;
          channelDelivering.add(s.id);
          const text = buildChannelDeliveryText(msg);
          void getSessionBackend()
            .pasteText(s.name, text, { enter: true })
            .then(() => {
              markDelivered(msg.id);
            })
            .catch((err) => {
              console.error("channel delivery failed:", err);
            })
            .finally(() => {
              channelDelivering.delete(s.id);
            });
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
    let budgetTickBusy = false;
    setInterval(async () => {
      if (budgetTickBusy) return; // transcript reads can run slow
      budgetTickBusy = true;
      try {
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
          // endpoint would hold budgetTickBusy and delay the kill below.
          void sendPushToAll({
            title: "Stoa budget",
            body,
            tag: `budget-${b.id}-${b.level}`,
            url: "/",
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
      } catch (err) {
        console.error("budget tick failed:", err);
      } finally {
        budgetTickBusy = false;
      }
    }, 30000);
  }

  // ── dispatch reconciler (GitHub issue → agent fleet) ──
  // Always armed but cheap when idle: the tick early-returns per repo and only
  // does real work for ENABLED repos (auto-dispatch) or in-flight rows (PR
  // polling). reconcileTick has its own busy guard. 60s cadence tolerates the
  // blocking gh calls (issue list + pr list) it makes.
  const dispatchTimer = setInterval(() => {
    void reconcileTick();
  }, 60000);
  // Don't let the reconciler timer keep the process alive on its own.
  dispatchTimer.unref?.();

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
