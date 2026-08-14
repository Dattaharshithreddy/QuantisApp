import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from 'services/storage';
import { THEMES, Theme } from '../theme/colors';

type ThemeCtx = { theme: Theme; themeName: 'dark' | 'light'; toggleTheme: () => void };
const Ctx = createContext<ThemeCtx>({ theme: THEMES.dark, themeName: 'dark', toggleTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName, setThemeName] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    KVStore.get('themeName').then(v => {
      if (v === 'light' || v === 'dark') setThemeName(v);
    });
  }, []);

  function toggleTheme() {
    const next = themeName === 'dark' ? 'light' : 'dark';
    setThemeName(next);
    KVStore.set('themeName', next);
  }

  return (
    <Ctx.Provider value={{ theme: THEMES[themeName], themeName, toggleTheme }}>
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
