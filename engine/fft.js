// 複素 FFT（基数2・その場で計算）。2本の実数信号（左右）を1回で変換するのに使う。
export class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n) | 0;
    if (1 << this.levels !== n) throw new Error('FFT size must be power of 2');
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < this.levels; j++) { r = (r << 1) | (x & 1); x >>>= 1; }
      this.rev[i] = r;
    }
  }
  // re, im: Float64Array(n)。結果で上書きする。
  transform(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const cosT = this.cos, sinT = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cosT[k] + im[l] * sinT[k];
          const tim = -re[l] * sinT[k] + im[l] * cosT[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
