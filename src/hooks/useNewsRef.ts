// ─────────────────────────────────────────────────────────────────────────────
// useNewsRef — zero-render news subscription
//
// Same pattern as usePriceRef.
// News updates every ~5 minutes — AIChatScreen must not re-render from it.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useEffect } from 'react';
import { useData } from '../context/DataContext';

function NewsRefUpdaterInner({ onNews }: { onNews: (news: any[]) => void }) {
  const { news } = useData();
  onNews(news ?? []); // synchronous ref update, no setState
  return null;
}

export const NewsRefUpdater = React.memo(NewsRefUpdaterInner);

export function useNewsRef() {
  const newsRef = useRef<any[]>([]);

  const updateNews = React.useCallback((news: any[]) => {
    newsRef.current = news;
  }, []);

  return { newsRef, updateNews };
}
