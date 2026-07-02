"use client";

/**
 * First-run onboarding checklist (#30) — shown ONLY on the true empty state
 * (no sessions yet, gated again at the mount site) and only until dismissed
 * (a localStorage flag, so it never nags). One GET /api/readiness probe on
 * mount supplies the server facts (agent CLIs on PATH, sign-in evidence);
 * projects come from props and "you're remote" from the page hostname. All
 * decision logic is pure and lives in lib/readiness.ts (unit-tested) — this
 * component just fetches and renders, and hands "create the first session"
 * to the SAME handler the header's New Session button uses.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  computeOnboardingSteps,
  isRemoteHostname,
  onboardingProgress,
  shouldShowOnboarding,
  EMPTY_READINESS,
  ONBOARDING_DISMISSED_KEY,
  type ReadinessPayload,
} from "@/lib/readiness";
import { cn } from "@/lib/utils";

interface OnboardingChecklistProps {
  sessionCount: number;
  hasProjects: boolean;
  /** Opens the existing NewSessionDialog (the header button's handler). */
  onCreateSession: () => void;
}

export function OnboardingChecklist({
  sessionCount,
  hasProjects,
  onCreateSession,
}: OnboardingChecklistProps) {
  // Raw flag (not a boolean) so the pure shouldShowOnboarding decides. The
  // views only mount this after hydration, so localStorage is available; the
  // try/catch covers denied storage (e.g. some private-browsing modes).
  const [dismissedFlag, setDismissedFlag] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ONBOARDING_DISMISSED_KEY);
    } catch {
      return null;
    }
  });
  // null = probe still in flight (render a placeholder, not all-todo lies).
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);

  const show = shouldShowOnboarding(sessionCount, dismissedFlag);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    fetch("/api/readiness")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ReadinessPayload | null) => {
        if (!cancelled) setReadiness(data ?? EMPTY_READINESS);
      })
      .catch(() => {
        if (!cancelled) setReadiness(EMPTY_READINESS);
      });
    return () => {
      cancelled = true;
    };
  }, [show]);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      /* storage denied — dismiss for this page load only */
    }
    setDismissedFlag("1");
  };

  const steps = readiness
    ? computeOnboardingSteps({
        readiness,
        hasProjects,
        hasSessions: sessionCount > 0,
        isRemoteClient: isRemoteHostname(
          typeof window === "undefined" ? "" : window.location.hostname
        ),
      })
    : null;
  const progress = steps ? onboardingProgress(steps) : null;

  return (
    <div className="border-border/60 bg-background/60 flex-shrink-0 overflow-y-auto border-b px-4 py-3">
      <div className="mx-auto flex max-w-xl flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Welcome to Stoa — let&apos;s get you set up
            {progress && (
              <span className="text-muted-foreground ml-2 font-normal">
                {progress.done}/{progress.total} done
              </span>
            )}
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss setup checklist"
            onClick={dismiss}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {steps ? (
          <ul className="flex flex-col gap-1.5">
            {steps.map((step) => (
              <li key={step.id} className="flex items-start gap-2 text-sm">
                {step.done ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-500" />
                ) : (
                  <Circle className="text-muted-foreground/50 mt-0.5 h-4 w-4 flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <span
                    className={cn(
                      "font-medium",
                      step.done && "text-muted-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                  <p className="text-muted-foreground text-xs">{step.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Checking your setup…</p>
        )}

        <Button size="sm" className="self-start" onClick={onCreateSession}>
          <Plus className="mr-1 h-4 w-4" />
          Create your first session
        </Button>
      </div>
    </div>
  );
}
