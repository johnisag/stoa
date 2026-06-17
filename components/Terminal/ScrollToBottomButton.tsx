"use client";

import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

export function ScrollToBottomButton({
  visible,
  onClick,
}: ScrollToBottomButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={cn(
        // z-30 so it sits above xterm's canvas layers and actually receives the
        // click (without it the press passes through to the terminal).
        "absolute right-6 bottom-6 z-30 p-3",
        "bg-primary/90 hover:bg-primary backdrop-blur-sm",
        "text-primary-foreground shadow-primary/30 rounded-full shadow-xl",
        "transition-all duration-200 hover:scale-105 active:scale-95",
        "animate-bounce",
        visible
          ? "opacity-100 pointer-events-auto"
          : "opacity-0 pointer-events-none"
      )}
      title="Scroll to bottom"
    >
      <ArrowDown className="h-5 w-5" />
    </button>
  );
}
