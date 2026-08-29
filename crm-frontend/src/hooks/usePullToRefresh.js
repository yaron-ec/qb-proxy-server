import { useEffect, useRef, useState } from 'react';

/**
 * usePullToRefresh - Native-style pull-to-refresh for mobile
 * @param {Function} onRefresh - async function to call on pull
 * @param {Object} options
 * @param {number} options.threshold - px to pull before triggering (default 72)
 */
export function usePullToRefresh(onRefresh, { threshold = 72 } = {}) {
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);

  const startY = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const el = containerRef.current || document.documentElement;

    const isAtTop = () => {
      // Check if the scrollable ancestor is at the top
      const scrollEl = containerRef.current || document.scrollingElement || document.documentElement;
      return scrollEl.scrollTop <= 0;
    };

    const onTouchStart = (e) => {
      if (isAtTop()) {
        startY.current = e.touches[0].clientY;
      }
    };

    const onTouchMove = (e) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0 && isAtTop()) {
        // Prevent default scroll so we control it
        e.preventDefault();
        setPulling(true);
        // Apply rubber-band damping
        setPullDistance(Math.min(dy * 0.45, threshold * 1.5));
      } else {
        startY.current = null;
        setPulling(false);
        setPullDistance(0);
      }
    };

    const onTouchEnd = async () => {
      if (pulling && pullDistance >= threshold * 0.45) {
        setRefreshing(true);
        setPulling(false);
        setPullDistance(0);
        startY.current = null;
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      } else {
        setPulling(false);
        setPullDistance(0);
        startY.current = null;
      }
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [onRefresh, pulling, pullDistance, threshold]);

  return { pulling, refreshing, pullDistance, containerRef };
}