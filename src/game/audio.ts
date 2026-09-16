// Tiny WebAudio SFX helper — all sounds are synthesized, no assets.

export class AudioFX {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  musicOn = false;

  ensure(): boolean {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      } catch {
        return false;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return true;
  }

  private ok(): boolean {
    if (!this.musicOn) return false;
    if (!this.ensure() || !this.ctx) return false;
    return this.ctx.state === "running";
  }

  tone(
    freq: number,
    freqEnd: number,
    dur: number,
    gain = 0.15,
    type: OscillatorType = "square",
    delay = 0,
  ) {
    if (!this.ok() || !this.ctx || !this.master) return;
    const c = this.ctx;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, freq), t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  noise(
    dur: number,
    gain = 0.2,
    type: BiquadFilterType = "lowpass",
    freq = 1200,
    delay = 0,
  ) {
    if (!this.ok() || !this.ctx || !this.master) return;
    const c = this.ctx;
    const t0 = c.currentTime + delay;
    const n = Math.max(1, Math.ceil(c.sampleRate * dur));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t0);
  }

  shoot() {
    this.noise(0.07, 0.26, "lowpass", 1500);
    this.tone(220, 70, 0.08, 0.15, "square");
  }
  shotgun() {
    this.noise(0.16, 0.32, "lowpass", 900);
    this.tone(140, 50, 0.14, 0.18, "square");
  }
  sniper() {
    this.noise(0.22, 0.28, "lowpass", 2200);
    this.tone(300, 40, 0.25, 0.16, "sawtooth");
  }
  enemyShot() {
    this.noise(0.06, 0.14, "lowpass", 1100);
    this.tone(180, 90, 0.06, 0.08, "square");
  }
  dry() {
    this.tone(900, 500, 0.05, 0.08, "square");
  }
  reload() {
    this.tone(500, 300, 0.06, 0.1, "square");
    this.tone(700, 400, 0.06, 0.1, "square", 0.16);
  }
  hitEnemy() {
    this.tone(300, 140, 0.07, 0.15, "triangle");
  }
  headshot() {
    this.tone(680, 220, 0.09, 0.17, "triangle");
    this.tone(1000, 500, 0.07, 0.1, "triangle", 0.03);
  }
  kill() {
    this.tone(520, 180, 0.14, 0.17, "square");
    this.noise(0.1, 0.12, "highpass", 1500, 0.02);
  }
  katana() {
    this.noise(0.1, 0.2, "highpass", 2400);
    this.tone(900, 300, 0.09, 0.1, "sawtooth");
  }
  hurt() {
    this.tone(180, 60, 0.22, 0.22, "sawtooth");
    this.noise(0.12, 0.18, "lowpass", 600);
  }
  explosion() {
    this.noise(0.5, 0.38, "lowpass", 500);
    this.tone(90, 30, 0.4, 0.28, "sawtooth");
  }
  pickup() {
    this.tone(660, 1320, 0.14, 0.13, "triangle");
  }
  wave() {
    this.tone(330, 660, 0.2, 0.13, "triangle");
    this.tone(440, 880, 0.22, 0.11, "triangle", 0.12);
  }
  bossRoar() {
    this.tone(70, 180, 0.7, 0.28, "sawtooth");
    this.noise(0.6, 0.18, "lowpass", 300);
  }
  focusIn() {
    this.tone(200, 900, 0.3, 0.15, "sine");
    this.tone(1200, 200, 0.4, 0.09, "sine", 0.05);
  }
  focusDash() {
    this.noise(0.12, 0.28, "highpass", 1800);
    this.tone(400, 1600, 0.15, 0.13, "sawtooth");
  }
  grappleFire() {
    this.noise(0.08, 0.18, "highpass", 2000);
    this.tone(500, 1500, 0.12, 0.11, "sawtooth");
  }
  grappleHit() {
    this.tone(300, 200, 0.08, 0.15, "square");
  }
  uiClick() {
    this.tone(700, 500, 0.05, 0.08, "square");
  }
}
