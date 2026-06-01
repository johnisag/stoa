"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ConfirmOptions {
  /** Dialog heading. Defaults to "Are you sure?". */
  title?: string;
  /** Body text explaining the consequence. */
  description?: React.ReactNode;
  /** Confirm button label. Defaults to "Delete" when destructive, else "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Red confirm button + destructive intent. Defaults to true. */
  destructive?: boolean;
}

type ConfirmFn = (options?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/**
 * Promise-based replacement for `window.confirm()`:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, description }))) return;
 *
 * Renders a themed Radix dialog instead of native OS chrome (which is blocked in
 * standalone PWAs and looks foreign). Must be used under <ConfirmProvider>.
 */
export function useConfirm(): ConfirmFn {
  const fn = React.useContext(ConfirmContext);
  if (!fn) {
    throw new Error("useConfirm must be used within a <ConfirmProvider>");
  }
  return fn;
}

interface ConfirmState {
  open: boolean;
  options: ConfirmOptions;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ConfirmState>({
    open: false,
    options: {},
  });
  // Resolver for the in-flight promise; settled exactly once per open dialog.
  const resolveRef = React.useRef<((confirmed: boolean) => void) | null>(null);

  const settle = React.useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const confirm = React.useCallback<ConfirmFn>(
    (options = {}) =>
      new Promise<boolean>((resolve) => {
        // A second call while one is open cancels the previous (no leaked promise).
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setState({ open: true, options });
      }),
    []
  );

  const { open, options } = state;
  const destructive = options.destructive ?? true;
  const confirmLabel =
    options.confirmLabel ?? (destructive ? "Delete" : "Confirm");

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Escape / overlay click resolve as cancel. Guarded on a live resolver
          // so closing via a button (which already settled) can't settle twice.
          if (!next && resolveRef.current) settle(false);
        }}
      >
        {/* Cancel is first in the DOM, so Radix focuses it on open — a stray
            Enter cancels rather than confirming a destructive action. */}
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{options.title ?? "Are you sure?"}</DialogTitle>
            {options.description ? (
              <DialogDescription>{options.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              {options.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
