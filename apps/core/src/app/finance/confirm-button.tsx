"use client";

export function ConfirmButton({
  question,
  className,
  children,
}: {
  question: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(event) => {
        if (!window.confirm(question)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
