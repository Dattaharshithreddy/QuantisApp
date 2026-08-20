// ─────────────────────────────────────────────────────────────────────────────
// useNewsRef — zero-render news subscription
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useLayoutEffect } from 'react';
import { useData } from '../context/DataContext';

function NewsRefUpdaterInner({ onNews }: { onNews: (news: any[]) => void }) {
  const { news } = useData();

  useLayoutEffect(() => {
    onNews(news ?? []);
  }, [news, onNews]);

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
