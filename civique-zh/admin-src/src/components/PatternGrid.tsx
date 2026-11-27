import React, { useCallback, useRef, useState } from 'react';

interface PatternGridProps {
  disabled?: boolean;
  error?: boolean;
  onComplete: (pattern: string) => void;
  onTooShort?: () => void;
  onStart?: () => void;
}

const GRID_SIZE = 252;
const CENTERS: Array<{ id: number; x: number; y: number }> = [
  { id: 0, x: 42, y: 42 },
  { id: 1, x: 126, y: 42 },
  { id: 2, x: 210, y: 42 },
  { id: 3, x: 42, y: 126 },
  { id: 4, x: 126, y: 126 },
  { id: 5, x: 210, y: 126 },
  { id: 6, x: 42, y: 210 },
  { id: 7, x: 126, y: 210 },
  { id: 8, x: 210, y: 210 },
];
const HIT_RADIUS = 30;

export const PatternGrid: React.FC<PatternGridProps> = ({
  disabled = false,
  error = false,
  onComplete,
  onTooShort,
  onStart,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number } | null>(null);
  const selectedRef = useRef<number[]>([]);

  const getLocalPoint = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const scaleX = GRID_SIZE / rect.width;
    const scaleY = GRID_SIZE / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, []);

  const addDotWithIntermediate = useCallback((dotId: number) => {
    const current = selectedRef.current;
    if (current.includes(dotId) || current.length >= 9) return;

    const next = [...current];
    if (next.length > 0) {
      const prev = next[next.length - 1];
      const r1 = Math.floor(prev / 3);
      const c1 = prev % 3;
      const r2 = Math.floor(dotId / 3);
      const c2 = dotId % 3;
      if (Math.abs(r1 - r2) % 2 === 0 && Math.abs(c1 - c2) % 2 === 0) {
        const mid = ((r1 + r2) / 2) * 3 + (c1 + c2) / 2;
        if (mid !== dotId && !next.includes(mid)) {
          next.push(mid);
        }
      }
    }
    if (!next.includes(dotId) && next.length < 9) {
      next.push(dotId);
    }

    selectedRef.current = next;
    setSelected(next);
  }, []);

  const hitTestAndAdd = useCallback(
    (x: number, y: number) => {
      for (const pt of CENTERS) {
        if (Math.hypot(x - pt.x, y - pt.y) <= HIT_RADIUS) {
          addDotWithIntermediate(pt.id);
          break;
        }
      }
    },
    [addDotWithIntermediate],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const pt = getLocalPoint(e.clientX, e.clientY);
    if (!pt) return;
    selectedRef.current = [];
    setSelected([]);
    setDrawing(true);
    setPointerPos(pt);
    onStart?.();
    hitTestAndAdd(pt.x, pt.y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing || disabled) return;
    e.preventDefault();
    const pt = getLocalPoint(e.clientX, e.clientY);
    if (!pt) return;
    setPointerPos(pt);
    hitTestAndAdd(pt.x, pt.y);
  };

  const finishStroke = () => {
    if (!drawing) return;
    setDrawing(false);
    setPointerPos(null);
    const pts = selectedRef.current;
    if (pts.length === 0) return;

    if (pts.length < 4) {
      onTooShort?.();
      setTimeout(() => {
        selectedRef.current = [];
        setSelected([]);
      }, 280);
      return;
    }

    const patternStr = pts.join('-');
    setTimeout(() => {
      selectedRef.current = [];
      setSelected([]);
    }, 220);
    onComplete(patternStr);
  };

  const lineColor = error ? '#DC2626' : '#00A66C';
  const lastDot = selected.length > 0 ? CENTERS[selected[selected.length - 1]] : null;

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishStroke}
      onPointerCancel={finishStroke}
      style={{ width: GRID_SIZE, height: GRID_SIZE, touchAction: 'none' }}
      className="relative mx-auto select-none cursor-pointer rounded-2xl bg-[#F7FAF8] dark:bg-[#0D1511] border border-[#E4ECE8] dark:border-[#1E2B24]"
      aria-label="九宫格手势输入区域"
    >
      <svg viewBox={`0 0 ${GRID_SIZE} ${GRID_SIZE}`} className="w-full h-full overflow-visible">
        {selected.length > 1 && (
          <polyline
            fill="none"
            stroke={lineColor}
            strokeWidth={4.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeOpacity={0.85}
            points={selected.map((id) => `${CENTERS[id].x},${CENTERS[id].y}`).join(' ')}
          />
        )}

        {drawing && lastDot && pointerPos && (
          <line
            x1={lastDot.x}
            y1={lastDot.y}
            x2={pointerPos.x}
            y2={pointerPos.y}
            stroke={lineColor}
            strokeWidth={3}
            strokeLinecap="round"
            strokeOpacity={0.45}
          />
        )}

        {CENTERS.map((pt) => {
          const isSelected = selected.includes(pt.id);
          const isLast = selected[selected.length - 1] === pt.id;
          return (
            <g key={pt.id}>
              {isSelected && (
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={27}
                  fill={error ? 'rgba(220,38,38,0.10)' : 'rgba(0,166,108,0.12)'}
                />
              )}
              <circle
                cx={pt.x}
                cy={pt.y}
                r={isSelected ? 21 : 18}
                fill={
                  isSelected
                    ? error
                      ? 'rgba(220,38,38,0.16)'
                      : 'rgba(0,166,108,0.18)'
                    : 'transparent'
                }
                stroke={isSelected ? lineColor : 'currentColor'}
                strokeOpacity={isSelected ? 0.95 : 0.16}
                strokeWidth={isSelected ? 2 : 1.5}
              />
              <circle
                cx={pt.x}
                cy={pt.y}
                r={isLast ? 8.5 : isSelected ? 7.5 : 5}
                fill={isSelected ? lineColor : 'currentColor'}
                fillOpacity={isSelected ? 1 : 0.35}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
};
