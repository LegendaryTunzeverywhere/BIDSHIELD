import { useEffect, useRef, useState } from 'react';

interface FlapTextProps {
  text: string;
  tone?: string;
  className?: string;
}

export default function FlapText({ text, tone, className }: FlapTextProps) {
  const [chars, setChars] = useState(() => text.toUpperCase().split(''));
  const [flipKey, setFlipKey] = useState(0);
  const prev = useRef(text);

  useEffect(() => {
    if (prev.current !== text) {
      prev.current = text;
      setChars(text.toUpperCase().split(''));
      setFlipKey((k) => k + 1);
    }
  }, [text]);

  return (
    <span
      className={['flap-word', tone ?? text.toLowerCase(), className].filter(Boolean).join(' ')}
      aria-label={text}
    >
      {chars.map((ch, i) => (
        <span key={`${flipKey}-${i}`} className="flap-cell" aria-hidden="true">
          <span className="flap-char">{ch === ' ' ? ' ' : ch}</span>
        </span>
      ))}
    </span>
  );
}
