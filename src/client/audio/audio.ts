import { settings } from '../settings.ts';

/**
 * All sounds are synthesised at runtime with the Web Audio API — no audio
 * files, fully original. Volume buses: master → (effects | music).
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private fx!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private last = new Map<string, number>();
  private musicTimer: number | null = null;
  private musicStep = 0;
  private musicWanted = false;

  constructor() {
    settings.onChange(() => this.applyVolumes());
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
  }

  /** Browsers only allow audio after a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.fx = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.fx.connect(this.master);
      this.musicBus.connect(this.master);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      let seed = 1234567;
      for (let i = 0; i < data.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x7fffffff) * 2 - 1;
      }
      this.applyVolumes();
      if (this.musicWanted) this.startMusic();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const a = settings.get().audio;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(a.muted ? 0 : a.master, t, 0.02);
    this.fx.gain.setTargetAtTime(a.effects, t, 0.02);
    this.musicBus.gain.setTargetAtTime(a.music * 0.5, t, 0.2);
  }

  private ready(key: string, minGapMs: number): AudioContext | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || settings.get().audio.muted) return null;
    const now = performance.now();
    if (now - (this.last.get(key) ?? 0) < minGapMs) return null;
    this.last.set(key, now);
    return ctx;
  }

  private env(ctx: AudioContext, peak: number, attack: number, decay: number, dest: AudioNode, at = ctx.currentTime): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(dest);
    return g;
  }

  private tone(ctx: AudioContext, type: OscillatorType, f0: number, f1: number, peak: number, decay: number, at = ctx.currentTime, attack = 0.004): void {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + decay);
    o.connect(this.env(ctx, peak, attack, decay, this.fx, at));
    o.start(at);
    o.stop(at + attack + decay + 0.05);
  }

  private burst(ctx: AudioContext, filter: BiquadFilterType, freq: number, q: number, peak: number, decay: number, at = ctx.currentTime, attack = 0.002): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f).connect(this.env(ctx, peak, attack, decay, this.fx, at));
    src.start(at, Math.random() * 0.5);
    src.stop(at + attack + decay + 0.05);
  }

  kick(power: number): void {
    const ctx = this.ready('kick', 40);
    if (!ctx) return;
    const p = Math.min(1, Math.max(0.2, power));
    this.tone(ctx, 'sine', 170, 50, 0.7 * p, 0.14);
    this.burst(ctx, 'lowpass', 1400, 0.7, 0.45 * p, 0.05);
  }

  bump(speed: number): void {
    const ctx = this.ready('bump', 60);
    if (!ctx) return;
    const v = Math.min(1, speed / 500);
    if (v < 0.05) return;
    this.tone(ctx, 'sine', 240, 120, 0.35 * v, 0.07);
    this.burst(ctx, 'lowpass', 700, 0.5, 0.2 * v, 0.04);
  }

  wall(speed: number): void {
    const ctx = this.ready('wall', 35);
    if (!ctx) return;
    const v = Math.min(1, speed / 900);
    if (v < 0.04) return;
    this.burst(ctx, 'bandpass', 1500 + v * 800, 1.2, 0.5 * v, 0.06);
    this.tone(ctx, 'triangle', 320, 200, 0.2 * v, 0.05);
  }

  post(speed: number): void {
    const ctx = this.ready('post', 80);
    if (!ctx) return;
    const v = Math.min(1, 0.3 + speed / 900);
    this.tone(ctx, 'sine', 880, 870, 0.3 * v, 0.7);
    this.tone(ctx, 'sine', 1331, 1320, 0.18 * v, 0.5);
    this.tone(ctx, 'triangle', 2210, 2200, 0.06 * v, 0.25);
    this.burst(ctx, 'highpass', 3000, 0.7, 0.2 * v, 0.03);
  }

  net(speed: number): void {
    const ctx = this.ready('net', 90);
    if (!ctx) return;
    this.burst(ctx, 'lowpass', 500, 0.6, Math.min(0.5, 0.1 + speed / 1500), 0.22, ctx.currentTime, 0.02);
  }

  goal(): void {
    const ctx = this.ready('goal', 800);
    if (!ctx) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(ctx, 'triangle', f, f, 0.28, 0.5, t + i * 0.085, 0.01);
      this.tone(ctx, 'square', f / 2, f / 2, 0.05, 0.4, t + i * 0.085, 0.01);
    });
    // Crowd-like swell of filtered noise.
    this.burst(ctx, 'bandpass', 900, 0.4, 0.35, 1.8, t, 0.35);
    this.burst(ctx, 'bandpass', 2400, 0.8, 0.12, 1.6, t + 0.1, 0.3);
  }

  countdown(n: number): void {
    const ctx = this.ready(`count${n}`, 300);
    if (!ctx) return;
    if (n > 0) this.tone(ctx, 'sine', 660, 660, 0.3, 0.13);
    else {
      this.tone(ctx, 'sine', 990, 990, 0.3, 0.3);
      this.tone(ctx, 'sine', 1485, 1485, 0.12, 0.3);
    }
  }

  whistle(long: boolean): void {
    const ctx = this.ready('whistle', 500);
    if (!ctx) return;
    const blasts = long ? [0, 0.3, 0.6] : [0];
    for (const off of blasts) {
      const at = ctx.currentTime + off;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 2150;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 28;
      const depth = ctx.createGain();
      depth.gain.value = 70;
      lfo.connect(depth).connect(o.frequency);
      const dur = long && off === 0.6 ? 0.55 : 0.22;
      o.connect(this.env(ctx, 0.16, 0.01, dur, this.fx, at));
      o.start(at);
      lfo.start(at);
      o.stop(at + dur + 0.05);
      lfo.stop(at + dur + 0.05);
    }
  }

  click(): void {
    const ctx = this.ready('click', 30);
    if (!ctx) return;
    this.tone(ctx, 'triangle', 1100, 900, 0.12, 0.035);
  }

  // ------------------------------------------------------------------ music

  /** Gentle generative pad + arpeggio for the menus. */
  startMusic(): void {
    this.musicWanted = true;
    if (!this.ctx || this.musicTimer !== null) return;
    const chords = [
      [220, 261.63, 329.63],
      [174.61, 220, 261.63],
      [261.63, 329.63, 392],
      [196, 246.94, 293.66],
    ];
    const stepSec = 0.36;
    const tick = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      const chord = chords[Math.floor(this.musicStep / 16) % chords.length]!;
      const at = ctx.currentTime + 0.05;
      if (this.musicStep % 16 === 0) {
        for (const f of chord) {
          for (const detune of [-6, 5]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = f / 2;
            o.detune.value = detune;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 700;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, at);
            g.gain.exponentialRampToValueAtTime(0.035, at + 1.2);
            g.gain.exponentialRampToValueAtTime(0.0001, at + stepSec * 16 + 0.8);
            o.connect(lp).connect(g).connect(this.musicBus);
            o.start(at);
            o.stop(at + stepSec * 16 + 1);
          }
        }
      }
      const pattern = [0, 1, 2, 1, 0, 2, 1, 2];
      if (this.musicStep % 2 === 0) {
        const f = chord[pattern[(this.musicStep / 2) % pattern.length]!]! * 2;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.05, at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
        o.connect(g).connect(this.musicBus);
        o.start(at);
        o.stop(at + 0.55);
      }
      this.musicStep++;
    };
    tick();
    this.musicTimer = window.setInterval(tick, stepSec * 1000);
  }

  stopMusic(): void {
    this.musicWanted = false;
    if (this.musicTimer !== null) clearInterval(this.musicTimer);
    this.musicTimer = null;
  }
}

export const audio = new AudioEngine();
