"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { useWebhookStatus } from "@/data/webhooks/useWebhookStatus";
import { cn } from "@/lib/utils";

/** Inline copyable code block — clicking the copy icon copies the text. */
function CopyBlock({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className={cn(
        "bg-muted/60 flex items-start gap-2 rounded-md border px-3 py-2 font-mono text-xs",
        className
      )}
    >
      <span className="min-w-0 flex-1 break-all">{text}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy"
        className="mt-0.5 shrink-0"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="text-muted-foreground h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

/** Collapsible "Webhook Intake" section for the Allocation tab. */
export function WebhookIntakePanel() {
  const [open, setOpen] = useState(false);
  const { data } = useWebhookStatus(open);

  // Derive the base URL from the browser's origin so this works on any host/port.
  const origin =
    typeof window !== "undefined" ? window.location.origin : "<your-stoa-url>";
  const endpointUrl = `${origin}/api/webhooks/intake`;

  // macOS / Linux shell example (openssl is standard on POSIX systems).
  const curlExample = [
    `# macOS / Linux`,
    `SECRET=<your-secret>`,
    `BODY='{"event":"task","repo":"<repo-id>","title":"Fix the login bug"}'`,
    `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')`,
    `curl -X POST ${endpointUrl} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Stoa-Signature: $SIG" \\`,
    `  -d "$BODY"`,
  ].join("\n");

  // PowerShell example for Windows users.
  const psExample = [
    `# Windows (PowerShell)`,
    `$Secret = "<your-secret>"`,
    `$Body   = '{"event":"task","repo":"<repo-id>","title":"Fix the login bug"}'`,
    `$Hmac   = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($Secret))`,
    `$Sig    = ($Hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Body)) | ForEach-Object { $_.ToString("x2") }) -join ""`,
    `Invoke-RestMethod -Uri "${endpointUrl}" -Method Post \``,
    `  -Headers @{ "Content-Type"="application/json"; "X-Stoa-Signature"=$Sig } \``,
    `  -Body $Body`,
  ].join("\n");

  const notConfiguredText =
    "Not configured — add STOA_WEBHOOK_SECRET=<random-secret> to your .env file and restart Stoa to enable.";

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        Webhook Intake
        {open && (
          <span
            className={cn(
              "ml-auto text-xs font-normal",
              data?.configured ? "text-green-500" : "text-muted-foreground"
            )}
          >
            {data === undefined
              ? ""
              : data.configured
                ? "Active"
                : "Not configured"}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-3 px-3 pt-1 pb-3">
          {/* Status */}
          <div className="flex items-start gap-2">
            <span
              className={cn(
                "mt-1 inline-flex h-2 w-2 shrink-0 rounded-full",
                data === undefined
                  ? "bg-muted"
                  : data.configured
                    ? "bg-green-500"
                    : "bg-yellow-500"
              )}
            />
            <span className="text-muted-foreground text-xs">
              {data === undefined
                ? "Checking..."
                : data.configured
                  ? "Active — STOA_WEBHOOK_SECRET is set"
                  : notConfiguredText}
            </span>
          </div>

          {/* Endpoint */}
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">
              Endpoint
            </p>
            <CopyBlock text={endpointUrl} />
          </div>

          {/* Authentication */}
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">
              Authentication
            </p>
            <p className="text-muted-foreground text-xs">
              Set{" "}
              <code className="bg-muted rounded px-1">STOA_WEBHOOK_SECRET</code>{" "}
              to a random secret. Every request must include an{" "}
              <code className="bg-muted rounded px-1">X-Stoa-Signature</code>{" "}
              header containing the HMAC-SHA256 of the raw body.
            </p>
          </div>

          {/* Native example — macOS/Linux */}
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">
              Example (macOS / Linux)
            </p>
            <CopyBlock text={curlExample} className="whitespace-pre" />
          </div>

          {/* Native example — Windows */}
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">
              Example (Windows PowerShell)
            </p>
            <CopyBlock text={psExample} className="whitespace-pre" />
          </div>

          {/* GitHub section */}
          <div className="rounded-md border border-dashed px-3 py-2">
            <p className="mb-1 text-xs font-medium">GitHub Webhooks</p>
            <ol className="text-muted-foreground list-inside list-decimal space-y-1 text-xs">
              <li>
                In your GitHub repo go to{" "}
                <span className="font-mono">
                  Settings &rarr; Webhooks &rarr; Add webhook
                </span>
                .
              </li>
              <li>
                Set <span className="font-mono">Payload URL</span> to the
                endpoint above.
              </li>
              <li>
                Set <span className="font-mono">Content type</span> to{" "}
                <span className="font-mono">application/json</span>.
              </li>
              <li>
                Set <span className="font-mono">Secret</span> to the value of{" "}
                <code className="bg-muted rounded px-1">
                  STOA_WEBHOOK_SECRET
                </code>
                .
              </li>
              <li>
                Under events select <span className="font-mono">Issues</span>{" "}
                (only <span className="font-mono">opened</span> is processed;
                others are acknowledged and ignored).
              </li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
