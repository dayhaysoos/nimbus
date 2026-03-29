import { useEffect, useMemo, useRef, useState } from 'react';
import { compactSummaryLineHeight, compactSummaryText } from '../lib/pretext-compact';

interface CompactHistoryTextProps {
  text: string;
  className?: string;
}

export function CompactHistoryText({ text, className }: CompactHistoryTextProps): JSX.Element {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setWidth(Math.max(0, Math.floor(element.clientWidth)));
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => {
        window.removeEventListener('resize', updateWidth);
      };
    }

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const compactText = useMemo(() => {
    if (width <= 0) {
      return text;
    }
    return compactSummaryText(text, width);
  }, [text, width]);

  return (
    <p
      ref={ref}
      className={className}
      style={{ lineHeight: `${compactSummaryLineHeight()}px` }}
      title={text}
    >
      {compactText}
    </p>
  );
}
