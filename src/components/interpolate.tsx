import type { ReactNode } from "react";

/**
 * Renders a translated sentence with elements in it: `text` holds {name} placeholders (kept in
 * every language, in that language's word order) and `values` the elements that go there.
 */
export function Interpolate({ text, values }: { text: string; values: Record<string, ReactNode> }) {
  const parts = text.split(/({[a-zA-Z0-9]+})/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^{([a-zA-Z0-9]+)}$/);
        if (match && values[match[1]]) {
          return <span key={i}>{values[match[1]]}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
