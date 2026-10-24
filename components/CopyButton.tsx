"use client";
import { useState } from "react";
import { Button } from "@/components/ui";

export function CopyButton({
  text,
  label = "Copy",
  variant = "secondary",
  className = "",
}: {
  text: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // ignore
      }
      ta.remove();
    }
    setDone(true);
    window.setTimeout(() => setDone(false), 1500);
  }
  return (
    <Button variant={variant} onClick={copy} className={className}>
      {done ? "Copied!" : label}
    </Button>
  );
}
