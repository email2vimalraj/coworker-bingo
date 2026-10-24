import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-dark disabled:bg-slate-300",
  secondary:
    "bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300",
  ghost: "text-accent hover:bg-indigo-50 disabled:text-slate-400",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-base font-semibold transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}

export const inputClass =
  "min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-indigo-200";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-slate-800">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-sm text-slate-500">{hint}</span> : null}
      {error ? <span className="mt-1 block text-sm font-medium text-red-600">{error}</span> : null}
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center text-slate-500" role="status">
      {label}
    </div>
  );
}
