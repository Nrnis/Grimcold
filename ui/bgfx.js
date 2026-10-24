// The "Crossout" background: the garage's dark haze (CSS gradient on #center) plus a few slow
// embers drifting up through it, drawn on a small 2D canvas behind the 3D view. Only runs while
// that background is chosen and the page is visible.
export class Embers {
  constructor(host) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'bgfx';
    host.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.sparks = [];
    this.on = false;
    this.last = 0;
    this.frame = this.frame.bind(this);
    new ResizeObserver(() => this.resize()).observe(host);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.scale = dpr;
  }

  setEnabled(on) {
    if (on === this.on) return;
    this.on = on;
    this.canvas.hidden = !on;
    if (on) {
      this.resize();
      this.sparks = Array.from({ length: 14 }, () => this.spawn(true));
      this.last = performance.now();
      requestAnimationFrame(this.frame);
    }
  }

  spawn(anywhere = false) {
    const w = this.canvas.width, h = this.canvas.height;
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 10,
      vx: (Math.random() * 0.6 - 0.2) * 14 * this.scale, // mostly drifting up and a little sideways
      vy: -(8 + Math.random() * 16) * this.scale,
      r: (0.6 + Math.random() * 1.3) * this.scale,
      life: 0,
      span: 9 + Math.random() * 12, // seconds
      hue: 18 + Math.random() * 20,
    };
  }

  frame(now) {
    if (!this.on) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { ctx } = this;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i];
      s.life += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx += Math.sin(now / 1300 + i) * 2 * this.scale * dt; // a little flutter
      if (s.life > s.span || s.y < -10 || s.x < -10 || s.x > w + 10) { this.sparks[i] = this.spawn(); continue; }
      const t = s.life / s.span;
      const a = Math.min(1, t * 4) * (1 - t) * 0.75; // fade in, burn out
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
      g.addColorStop(0, `hsla(${s.hue}, 100%, 62%, ${a})`);
      g.addColorStop(0.35, `hsla(${s.hue}, 100%, 50%, ${a * 0.45})`);
      g.addColorStop(1, `hsla(${s.hue}, 100%, 45%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(this.frame);
  }
}
