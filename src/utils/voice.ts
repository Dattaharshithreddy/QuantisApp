import * as Speech from 'expo-speech';

// Voice market summary — full speech-to-text command input would require a
// custom native module (not available in Expo Go without a dev client build),
// so this implements the practical half: tap-to-speak market summaries read
// aloud via on-device TTS, hands-free while you're charting.

export function speakSummary(text: string) {
  Speech.stop();
  Speech.speak(text, { rate: 0.95, pitch: 1.0 });
}

export function stopSpeaking() {
  Speech.stop();
}

export function buildMarketSummarySpeech(opts: {
  symbol: string; price: number; chgPct: number; rsi: number; trend: string;
}): string {
  const { symbol, price, chgPct, rsi, trend } = opts;
  const dir = chgPct >= 0 ? 'up' : 'down';
  const rsiNote = rsi >= 70 ? 'overbought territory' : rsi <= 30 ? 'oversold territory' : 'a neutral zone';
  return `${symbol} is currently at ${price.toFixed(2)}, ${dir} ${Math.abs(chgPct).toFixed(2)} percent today. ` +
    `The RSI is at ${rsi}, putting it in ${rsiNote}. Overall structure looks ${trend}.`;
}
